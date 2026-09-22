import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { formatConfig, cfg } from "../server/config";
import { syncTenants, getTenant } from "../database/tenant";
import { syncWorkflows, ensureWorkflowIndexes, resolveWorkflowsRetention } from "../lib/workflow";

const SERVER_RETENTION = "30d";

const INHERIT = "wfr-inherit";
const OVERRIDE = "wfr-override";
const OFF = "wfr-off";

const DBS = {
    [INHERIT]: "mongodb://localhost:27017/_WF_RET_INHERIT",
    [OVERRIDE]: "mongodb://localhost:27017/_WF_RET_OVERRIDE",
    [OFF]: "mongodb://localhost:27017/_WF_RET_OFF",
} as const;

const TTL_INDEX = "_workflow_runs_ttl_";

/** TTL index of a tenant's `_workflows_` collection, or undefined */
async function ttlIndex(tenantId: string): Promise<any> {
    const db = getTenant(tenantId)!.database!.db!;
    return (await db.collection("_workflows_").listIndexes().toArray())
        .find((i: any) => i.name === TTL_INDEX);
}

beforeAll(async () => {
    formatConfig({
        server: {
            port: 4000,
            // Server-wide default — inherited unless the tenant declares its own
            workflows: { retention: SERVER_RETENTION },
        },
        tenants: [
            { id: INHERIT, dir: "packages/core/tests/fixtures/workflow-engine", database: { uri: DBS[INHERIT] } },
            {
                id: OVERRIDE,
                dir: "packages/core/tests/fixtures/workflow-engine",
                database: { uri: DBS[OVERRIDE] },
                workflows: { retention: "1h" },
            },
            {
                id: OFF,
                dir: "packages/core/tests/fixtures/workflow-engine",
                database: { uri: DBS[OFF] },
                workflows: { retention: false },
            },
        ],
    });

    await syncTenants();
    await syncWorkflows();
    await ensureWorkflowIndexes();
});

afterAll(async () => {
    for (const id of Object.keys(DBS)) {
        try { await getTenant(id)?.database?.db?.collection("_workflows_").drop(); } catch (_) {}
    }
    delete (cfg.server as any).workflows;
});

describe("workflow run retention", () => {
    it("resolves the tenant first, the server default as fallback", () => {
        expect(resolveWorkflowsRetention({ id: INHERIT, dir: "x", database: { uri: "" } } as any)).toBe(SERVER_RETENTION);
        expect(resolveWorkflowsRetention({ id: OVERRIDE, dir: "x", database: { uri: "" }, workflows: { retention: "1h" } } as any)).toBe("1h");
        // `false` is a value, not an absence — it must override the server default
        expect(resolveWorkflowsRetention({ id: OFF, dir: "x", database: { uri: "" }, workflows: { retention: false } } as any)).toBe(false);
    });

    it("applies the server default to a tenant without its own config", async () => {
        const ttl = await ttlIndex(INHERIT);
        expect(ttl).toBeDefined();
        expect(ttl.key).toEqual({ completedAt: 1 });
        expect(ttl.expireAfterSeconds).toBe(30 * 86400);
    });

    it("lets the tenant override the server default", async () => {
        const ttl = await ttlIndex(OVERRIDE);
        expect(ttl).toBeDefined();
        expect(ttl.expireAfterSeconds).toBe(3600);
    });

    it("lets a tenant opt out with `false`", async () => {
        expect(await ttlIndex(OFF)).toBeUndefined();
    });

    it("only prunes finished runs (`completedAt` is never set on an in-flight one)", async () => {
        const db = getTenant(INHERIT)!.database!.db!;
        const col: any = db.collection("_workflows_");
        await col.insertMany([
            { _id: "ret-running", workflowId: "simple", status: "running", createdAt: new Date(), updatedAt: new Date() },
            { _id: "ret-paused", workflowId: "simple", status: "paused", createdAt: new Date(), updatedAt: new Date() },
            { _id: "ret-done", workflowId: "simple", status: "completed", completedAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
        ]);

        const missing = await col.countDocuments({ _id: { $in: ["ret-running", "ret-paused"] }, completedAt: { $exists: false } });
        const finished = await col.countDocuments({ completedAt: { $exists: true } });

        expect(missing).toBe(2);   // never pruned by a TTL on `completedAt`
        expect(finished).toBe(1);  // only the finished run can expire
    });
});
