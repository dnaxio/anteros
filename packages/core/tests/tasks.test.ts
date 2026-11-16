import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { MongoClient, Db } from "mongodb";
import { syncTasks, startTasks, stopTasks, tasks } from "../lib/task";
import { formatConfig, cfg } from "../server/config";
import { syncTenants } from "../database/tenant";
import { syncCollections } from "../database/collection";
import { useRest } from "../database/rest";

/**
 * `define.Task` — the durable registry (`_tasks_`) and the `Bun.cron` scheduler.
 *
 * What these cases pin down:
 *  - the loader discovers `tasks/**\/*.task.ts` and skips invalid/disabled ones;
 *  - a row is created from the declaration and **never overwritten**;
 *  - a run records `lastRunAt` / `lastStatus` / `nextRunAt`, and a failure is
 *    recorded instead of throwing;
 *  - an operator may change the schedule or disable a task — and the change
 *    stream re-arms it without a restart;
 *  - the `lockedUntil` row is what makes several processes run a fire once.
 */

const TENANT = "tasks";
const DIR = "packages/core/tests/fixtures/tasks-tenant";
const DB = "mongodb://localhost:27017/_TASKS_TEST";

let rest: InstanceType<typeof useRest>;
let client: MongoClient;
let db: Db;
let replicaSet = false;

const rows = (): any => (db.collection("_tasks_") as any);
const runs = () => db.collection("task_runs").find({}).toArray();

async function waitFor(check: () => Promise<boolean>, timeout = 5_000, step = 50): Promise<boolean> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return true;
        await Bun.sleep(step);
    }
    return false;
}

beforeAll(async () => {
    formatConfig({
        server: { port: 4000 },
        tenants: [{ id: TENANT, dir: DIR, database: { uri: DB } }],
    });
    await syncTenants();
    await syncCollections();
    rest = new useRest({ tenant_id: TENANT });
    client = (cfg.tenants![0] as any).database.client;
    db = client.db();

    await syncTasks();
    await startTasks();

    replicaSet = Boolean((await db.admin().command({ hello: 1 })).setName);
});

afterAll(async () => {
    await stopTasks();
    try { await db.dropDatabase(); } catch { /* already gone */ }
    try { await client.close(); } catch { /* already gone */ }
    cfg.tenants = [];
});

describe("tasks — loading", () => {
    it("discovers valid tasks and skips invalid or disabled ones", () => {
        expect(tasks.ids(TENANT)).toEqual(["failing", "report"]);
        expect(tasks.has(TENANT, "report")).toBe(true);
        expect(tasks.has(TENANT, "disabled")).toBe(false);
        expect(tasks.has(TENANT, "invalid")).toBe(false);
        expect((cfg.tasks ?? []).map((task) => task.id).sort()).toEqual(["failing", "report"]);
    });
});

describe("tasks — the durable row", () => {
    it("creates a row from the declaration, and reports it armed", async () => {
        const row: any = await rows().findOne({ _id: "report" });
        expect(row.schedule).toBe("0 10 1 1 *");
        expect(row.timezone).toBe("UTC");
        expect(row.enabled).toBe(true);
        expect(row.catchUp).toBe("none");
        expect(row.lockMs).toBe(60_000);
        expect(row.nextRunAt).toBeInstanceOf(Date);
        expect(row.nextRunAt.getUTCHours()).toBe(10);

        const info = await tasks.get(TENANT, "report");
        expect(info).toMatchObject({ id: "report", enabled: true, armed: true, running: false });
        expect(info!.description).toBe("Writes a marker for every run.");
    });
});

describe("tasks — runs", () => {
    it("runs a task, records the result and keeps the row", async () => {
        const result = await tasks.run(TENANT, "report");
        expect(result).toMatchObject({ id: "report", trigger: "manual", skipped: false, ok: true });

        const stored: any[] = await runs();
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ task: "report", tenant: TENANT, trigger: "manual" });

        const row: any = await rows().findOne({ _id: "report" });
        expect(row.lastStatus).toBe("success");
        expect(row.lastRunAt).toBeInstanceOf(Date);
        expect(row.lastDurationMs).toBeGreaterThanOrEqual(0);
        expect(row.lockedUntil).toBeNull();
        expect(row.nextRunAt).toBeInstanceOf(Date);
    });

    it("records a failure instead of throwing", async () => {
        const result = await tasks.run(TENANT, "failing");
        expect(result).toMatchObject({ id: "failing", skipped: false, ok: false, error: "boom" });

        const row: any = await rows().findOne({ _id: "failing" });
        expect(row.lastStatus).toBe("error");
        expect(row.lastError).toBe("boom");
    });

    it("skips a run when another process holds the lock", async () => {
        await rows().updateOne({ _id: "report" }, { $set: { lockedUntil: new Date(Date.now() + 60_000) } });
        const before: any = await rows().findOne({ _id: "report" });

        const result = await tasks.run(TENANT, "report");
        expect(result).toMatchObject({ id: "report", skipped: true });

        const after: any = await rows().findOne({ _id: "report" });
        expect(after.lastRunAt).toEqual(before.lastRunAt); // the handler never ran
        await rows().updateOne({ _id: "report" }, { $set: { lockedUntil: null } });
    });

    it("refuses a task the tenant does not declare", async () => {
        await expect(tasks.run(TENANT, "nope")).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    });
});

describe("tasks — operator changes", () => {
    it("changes the schedule and re-arms immediately", async () => {
        const info = await tasks.update(TENANT, "report", { schedule: "0 8 * * TUE", timezone: "UTC" });
        expect(info.schedule).toBe("0 8 * * TUE");
        expect(info.armed).toBe(true);
        expect(info.nextRunAt).toBeInstanceOf(Date);
        expect(info.nextRunAt!.getUTCDay()).toBe(2); // Tuesday
        expect(info.nextRunAt!.getUTCHours()).toBe(8);

        const row: any = await rows().findOne({ _id: "report" });
        expect(row.schedule).toBe("0 8 * * TUE");
    });

    it("disables and re-enables a task", async () => {
        const off = await tasks.update(TENANT, "report", { enabled: false });
        expect(off).toMatchObject({ enabled: false, armed: false });

        const on = await tasks.update(TENANT, "report", { enabled: true });
        expect(on).toMatchObject({ enabled: true, armed: true });
    });

    it("refuses an invalid schedule or an unknown field value", async () => {
        await expect(tasks.update(TENANT, "report", { schedule: "every monday" }))
            .rejects.toMatchObject({ code: "TASK_SCHEDULE_INVALID" });
        await expect(tasks.update(TENANT, "report", { catchUp: "sometimes" as any }))
            .rejects.toMatchObject({ code: "TASK_UPDATE_INVALID" });
    });

    it("re-arms a row edited directly in the collection (change stream)", async () => {
        if (!replicaSet) return; // change streams need a replica set

        await rows().updateOne({ _id: "report" }, { $set: { enabled: false } });

        const off = await waitFor(async () => (await tasks.get(TENANT, "report"))?.armed === false);
        expect(off).toBe(true);

        await rows().updateOne({ _id: "report" }, { $set: { enabled: true } });
        const on = await waitFor(async () => (await tasks.get(TENANT, "report"))?.armed === true);
        expect(on).toBe(true);
    });

    it("runs a missed occurrence at boot when catchUp is 'once'", async () => {
        await stopTasks();
        await rows().updateOne(
            { _id: "report" },
            { $set: { catchUp: "once", nextRunAt: new Date(Date.now() - 60_000) } },
        );
        const before = (await runs()).length;

        await startTasks();
        const ran = await waitFor(async () => (await runs()).length > before);
        expect(ran).toBe(true);
        expect((await tasks.get(TENANT, "report"))?.lastStatus).toBe("success");

        await rows().updateOne({ _id: "report" }, { $set: { catchUp: "none" } });
    });
});

describe("tasks — removal", () => {
    it("removes a task: hidden from list(), disarmed, refused by run/update", async () => {
        const info = await tasks.remove(TENANT, "report");
        expect(info).toMatchObject({ id: "report", removed: true, enabled: false, armed: false });

        expect((await tasks.list(TENANT)).map((task) => task.id)).toEqual(["failing"]);
        expect((await tasks.list(TENANT, { includeRemoved: true })).map((task) => task.id))
            .toEqual(["failing", "report"]);

        await expect(tasks.run(TENANT, "report")).rejects.toMatchObject({ code: "TASK_REMOVED" });
        await expect(tasks.update(TENANT, "report", { enabled: true })).rejects.toMatchObject({ code: "TASK_REMOVED" });
    });

    it("is not resurrected by a restart", async () => {
        await stopTasks();
        await startTasks();

        const info = await tasks.get(TENANT, "report");
        expect(info).toMatchObject({ removed: true, armed: false });
        const row: any = await rows().findOne({ _id: "report" });
        expect(row.removedAt).toBeInstanceOf(Date);
    });

    it("restores it — visible and armed again", async () => {
        const info = await tasks.restore(TENANT, "report");
        expect(info).toMatchObject({ id: "report", removed: false, enabled: true, armed: true });
        expect((await tasks.list(TENANT)).map((task) => task.id)).toEqual(["failing", "report"]);
    });
});

describe("tasks — registry", () => {
    it("reports the scheduler state", () => {
        expect(tasks.stats()).toMatchObject({ tenants: 1, tasks: 2, running: 0, started: true });
    });
});
