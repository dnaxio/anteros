import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import os from "node:os";
import { formatConfig } from "../server/config";
import { syncTenants } from "../database/tenant";
import { syncWorkflows, ensureWorkflowIndexes, getWorkflow } from "../lib/workflow";
import { useRest } from "../database/rest";
import type { WorkflowRun } from "../types/workflow";

const TENANT = "wf-engine";
const DIR = "packages/core/tests/fixtures/workflow-engine";

let rest: InstanceType<typeof useRest>;
/** Shared, in-process state written by the fixture steps */
const state: { log: string[]; attempts: Record<string, number> } = ((globalThis as any).__wfEngine ??= {
    log: [],
    attempts: {},
});

async function runsOf(workflowId: string): Promise<WorkflowRun[]> {
    const col = rest.db.collection("_workflows_");
    return (await col.find({ workflowId }).sort({ createdAt: -1 }).toArray()) as unknown as WorkflowRun[];
}

/** The run currently being executed (its `_id` is only known from the database) */
async function currentRun(workflowId: string): Promise<any> {
    for (let i = 0; i < 80; i++) {
        const [run] = await runsOf(workflowId);
        if (run && run.status === "running") return run;
        await Bun.sleep(25);
    }
    throw new Error(`no running '${workflowId}' run found`);
}

/** Insert a run document directly, to set up a state the engine must recover from */
async function insertRun(doc: Partial<WorkflowRun> & { _id: string; workflowId: string }): Promise<void> {
    await rest.db.collection("_workflows_").insertOne({
        tenant_id: TENANT,
        status: "failed",
        progress: 0,
        data: {},
        currentStep: 0,
        totalExecuted: 0,
        totalSkipped: 0,
        steps: [],
        compensations: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        ...doc,
    } as any);
}

beforeAll(async () => {
    formatConfig({
        server: { port: 4000 },
        tenants: [{ id: TENANT, dir: DIR, database: { uri: "mongodb://localhost:27017/_WF_ENGINE" } }],
    });
    await syncTenants();
    await syncWorkflows();
    await ensureWorkflowIndexes();
    rest = new useRest({ tenant_id: TENANT, internal: true });
});

beforeEach(() => {
    state.log.length = 0;
    for (const key of Object.keys(state.attempts)) delete state.attempts[key];
});

afterAll(async () => {
    try { await rest.db.collection("_workflows_").drop(); } catch (_) {}
    try { await rest.db.collection("_locks_").drop(); } catch (_) {}
    delete (globalThis as any).__wfEngine;
});

describe("workflow locks", () => {
    it("runs a step once when two nodes resume the same run", async () => {
        await insertRun({
            _id: "lock-1",
            workflowId: "simple",
            status: "paused",
            steps: [{ stepId: "one", status: "pending", startedAt: new Date() } as any],
        });

        const [a, b] = await Promise.allSettled([
            rest.workflow.resume("lock-1"),
            rest.workflow.resume("lock-1"),
        ]);
        const outcomes = [a, b].map((r) => r.status);
        const errors = [a, b].map((r: any) => r.reason?.code).filter(Boolean) as string[];

        // One node wins; the other is either locked out or finds the run finished
        expect(outcomes).toContain("fulfilled");
        for (const code of errors) expect(["RUN_LOCKED", "RUN_TERMINAL"]).toContain(code);

        // …and above all: the step was NOT executed twice
        expect(state.log.filter((l) => l === "simple:one").length).toBe(1);
    });

    it("releases the lock when the run finishes (a later resume is not locked)", async () => {
        const run = await rest.workflow.run("simple", { echo: "release" });
        const locks = await rest.db.collection("_locks_").countDocuments({ name: `workflow:${run._id}` });
        expect(locks).toBe(0);
    });

    it("refuses a resume while another node holds the run", async () => {
        await insertRun({
            _id: "lock-2",
            workflowId: "simple",
            status: "paused",
            steps: [{ stepId: "one", status: "pending", startedAt: new Date() } as any],
        });
        // Simulate another node holding the lock (not expired)
        await rest.db.collection("_locks_").insertOne({
            _id: `${TENANT}:workflow:lock-2` as any,
            tid: TENANT,
            name: "workflow:lock-2",
            acquiredAt: Date.now(),
            expiresAt: Date.now() + 60_000,
        } as any);

        await expect(rest.workflow.resume("lock-2")).rejects.toThrow(/another node/);
        await rest.db.collection("_locks_").deleteOne({ name: "workflow:lock-2" });
    });
});

describe("workflow pause & cancel", () => {
    it("pauses an in-flight run at the next step boundary", async () => {
        const pending = rest.workflow.run("slow", { ms: 600 });
        const running = await currentRun("slow");

        expect(await rest.workflow.pause(running._id)).toBe(true);
        const run: any = await pending;

        expect(run.status).toBe("paused");
        expect(state.log).toEqual(["slow:fast", "slow:slow:start", "slow:slow:end"]);
        expect(run.steps[2].status).toBe("pending"); // the last step never ran
    }, 20_000);

    it("resumes a paused run from the step it stopped at", async () => {
        const [paused] = await runsOf("slow");
        state.log.length = 0;

        const run = await rest.workflow.resume(paused!._id, { ms: 10 });
        expect(run.status).toBe("completed");
        expect(state.log).toEqual(["slow:last"]);
    }, 20_000);

    it("cancels an in-flight run permanently", async () => {
        const pending = rest.workflow.run("slow", { ms: 600 });
        const running = await currentRun("slow");

        expect(await rest.workflow.cancel(running._id)).toBe(true);
        const run: any = await pending;

        expect(run.status).toBe("cancelled");
        expect(state.log).not.toContain("slow:last");
        await expect(rest.workflow.resume(run._id)).rejects.toThrow(/cancelled|not applicable/);
    }, 20_000);

    it("does not cancel a run that already completed", async () => {
        const done = await rest.workflow.run("simple", { echo: "terminal" });
        expect(await rest.workflow.cancel(done._id)).toBe(false);

        const stored: any = await rest.workflow.getRun(done._id);
        expect(stored.status).toBe("completed");
    });
});

describe("workflow step retries & timeout", () => {
    it("retries a transient failure instead of rolling the saga back", async () => {
        const run = await rest.workflow.run("flaky", { failUntil: 2 });
        expect(run.status).toBe("completed");
        expect(state.log).toEqual(["flaky:attempt:1", "flaky:attempt:2", "flaky:attempt:3"]);
        expect(run.steps[0]!.output).toEqual({ attempts: 3 });
    });

    it("gives up after `retries` and fails the run", async () => {
        await expect(rest.workflow.run("flaky", { failUntil: 5 })).rejects.toThrow(/transient failure/);
        const [run] = await runsOf("flaky");
        expect(run!.status).toBe("failed");
        expect(state.attempts.unstable).toBe(3); // 1 attempt + 2 retries
    });

    it("aborts a step that exceeds its timeout", async () => {
        await expect(rest.workflow.run("hang", { ms: 1000 })).rejects.toThrow(/timed out/);
        const [run] = await runsOf("hang");
        expect(run!.status).toBe("failed");
        expect(run!.error?.code).toBe("WORKFLOW_STEP_TIMEOUT");
    }, 15_000);
});

describe("workflow compensations", () => {
    it("compensates the completed steps and marks the run `compensated`", async () => {
        await expect(rest.workflow.run("failing", {})).rejects.toThrow(/boom-b/);
        const [run] = await runsOf("failing");

        expect(run!.status).toBe("compensated");
        expect(run!.steps[2]!.status).toBe("pending"); // never reached
        expect(state.log).toEqual([
            "failing:a:rest=client",
            "simple:one", // the sub-workflow run from the step
            "failing:a:sub-workflow-done",
            "failing:b",
            "failing:undo-a:1",
        ]);
    }, 15_000);

    it("refuses to resume a compensated run (never replays the steps)", async () => {
        const [run] = await runsOf("failing");
        state.log.length = 0;

        await expect(rest.workflow.resume(run!._id)).rejects.toThrow(/compensated/);
        expect(state.log).toEqual([]);
    });

    it("never replays a compensation through resumeAll", async () => {
        const [before] = await runsOf("failing");
        state.log.length = 0;

        await rest.workflow.resumeAll();

        // The compensated run is left alone and its compensation is not replayed
        const [after] = await runsOf("failing");
        expect(after!.status).toBe("compensated");
        expect(state.log.filter((l) => l.startsWith("failing:undo-a"))).toEqual([]);
        expect(before!._id).toBe(after!._id);
    }, 15_000);

    it("finishes an interrupted rollback without replaying what already succeeded", async () => {
        await insertRun({
            _id: "rollback-1",
            workflowId: "failing",
            status: "failed",
            steps: [
                { stepId: "a", status: "completed", output: { a: 1 }, startedAt: new Date() } as any,
                { stepId: "b", status: "failed", error: { message: "boom-b" }, startedAt: new Date() } as any,
                { stepId: "c", status: "pending", startedAt: new Date() } as any,
            ],
            // `undo-a` failed the first time: the rollback must be finished
            compensations: [{ stepId: "undo-a", status: "failed", error: { message: "network" }, startedAt: new Date() } as any],
        });

        const run: any = await rest.workflow.resume("rollback-1");
        expect(run.status).toBe("compensated");
        expect(run.steps[1].status).toBe("failed"); // never continued forward
        expect(state.log.length).toBe(1);
        expect(state.log[0]).toStartWith("failing:undo-a");
        expect(run.compensations.length).toBe(2); // the failed one + the successful retry
    });

    it("replays nothing when the rollback already succeeded", async () => {
        await insertRun({
            _id: "rollback-2",
            workflowId: "failing",
            status: "failed",
            steps: [
                { stepId: "a", status: "completed", output: { a: 1 }, startedAt: new Date() } as any,
                { stepId: "b", status: "failed", error: { message: "boom-b" }, startedAt: new Date() } as any,
            ],
            compensations: [{ stepId: "undo-a", status: "completed", startedAt: new Date() } as any],
        });
        state.log.length = 0;

        const run: any = await rest.workflow.resume("rollback-2");
        expect(run.status).toBe("compensated");
        expect(state.log).toEqual([]); // the successful compensation was not replayed
    });
});

describe("workflow run ownership", () => {
    it("stops when another node takes the run over", async () => {
        const pending = rest.workflow.run("slow", { ms: 500 });
        const running = await currentRun("slow");

        // Simulate a takeover: another process owns the run lock now
        await rest.db.collection("_locks_").updateOne(
            { _id: `${TENANT}:workflow:${running._id}` as any },
            { $set: { pid: process.pid + 1, hostname: os.hostname(), expiresAt: Date.now() + 60_000 } },
        );

        const run: any = await pending;
        expect(run.steps[2].status).toBe("pending"); // the last step never ran
        expect(state.log).not.toContain("slow:last");

        await rest.db.collection("_locks_").deleteOne({ _id: `${TENANT}:workflow:${running._id}` as any });
    }, 20_000);

    it("records the executing pid on the run", async () => {
        const run = await rest.workflow.run("simple", { echo: "who" });
        expect(run.pid).toBe(process.pid);
        expect(run.hostname).toBe(os.hostname());
    });
});

describe("workflow resume guards", () => {
    it("refuses to resume a run started by another version", async () => {
        await insertRun({
            _id: "version-1",
            workflowId: "versioned",
            workflowVersion: 1,
            status: "paused",
            steps: [{ stepId: "v", status: "pending", startedAt: new Date() } as any],
        });
        // The workflow has been deployed in version 2 since the run started
        getWorkflow("versioned", TENANT)!.version = 2;

        await expect(rest.workflow.resume("version-1")).rejects.toThrow(/version/);

        // …unless the operator forces it
        state.log.length = 0;
        const run: any = await rest.workflow.resume("version-1", undefined, { force: true });
        expect(run.status).toBe("completed");
        expect(state.log).toEqual(["versioned:v"]);

        getWorkflow("versioned", TENANT)!.version = 1;
    });
});

describe("workflow resumeAll", () => {
    it("resumes every paused run, batch by batch", async () => {
        for (let i = 0; i < 5; i++) {
            await insertRun({
                _id: `bulk-${i}`,
                workflowId: "simple",
                status: "paused",
                steps: [{ stepId: "one", status: "pending", startedAt: new Date() } as any],
            });
        }

        const { resumed } = await rest.workflow.resumeAll(undefined, { batchSize: 2 });
        expect(resumed).toBeGreaterThanOrEqual(5);

        const left = await rest.db.collection("_workflows_")
            .countDocuments({ _id: /^bulk-/, status: { $in: ["paused", "failed"] } });
        expect(left).toBe(0);

        const done = await rest.db.collection("_workflows_")
            .countDocuments({ _id: /^bulk-/, status: "completed" });
        expect(done).toBe(5);
    }, 20_000);
});
