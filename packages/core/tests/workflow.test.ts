import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import os from "node:os";
import { formatConfig } from "../server/config";
import { syncTenants } from "../database/tenant";
import { syncWorkflows, ensureWorkflowIndexes, getWorkflow, workflowStats } from "../lib/workflow";
import { useRest } from "../database/rest";

const TENANT = "wf-test";
// Second tenant sharing the same code folder — same workflows, other database
const TENANT_2 = "wf-test-2";
const DIR = "packages/core/tests/fixtures/workflow-tenant";

let rest: InstanceType<typeof useRest>;

async function indexNames(tenantId: string): Promise<string[]> {
    const tenantRest = new useRest({ tenant_id: tenantId, internal: true });
    return (await tenantRest.db.collection("_workflows_").listIndexes().toArray()).map((i: any) => i.name);
}

beforeAll(async () => {
    formatConfig({
        server: { port: 4000 },
        tenants: [
            { id: TENANT, dir: DIR, database: { uri: "mongodb://localhost:27017/_WF_TEST" } },
            { id: TENANT_2, dir: DIR, database: { uri: "mongodb://localhost:27017/_WF_TEST_2" } },
        ],
    });
    await syncTenants();
    await syncWorkflows();
    // The loader fires the index pass in the background — await it here so the
    // assertions below are deterministic (the non-blocking behaviour is tested
    // separately, via `syncWorkflows()` alone).
    await ensureWorkflowIndexes();

    rest = new useRest({ tenant_id: TENANT, internal: true });
});

afterAll(async () => {
    for (const id of [TENANT, TENANT_2]) {
        try { await new useRest({ tenant_id: id, internal: true }).db.collection("_workflows_").drop(); } catch (_) {}
    }
});

describe("workflow loader", () => {
    it("registers the enabled workflows of the tenant", () => {
        const invoice = getWorkflow("invoice", TENANT);
        expect(invoice).toBeDefined();
        expect(invoice!._tenant_).toBe(TENANT);
        expect(invoice!.version).toBe(3);
    });

    it("keeps exactly one definition for a duplicated id", () => {
        const order = getWorkflow("order", TENANT);
        // Which file wins depends on the filesystem order — what matters is that
        // there is a single, valid definition (never two, never a crash)
        expect(["Orders", "Orders (duplicate definition)"]).toContain(order!.name);
    });

    it("skips disabled workflows (`enabled: false`)", () => {
        expect(getWorkflow("nightly", TENANT)).toBeUndefined();
    });

    it("ignores a workflow without an `id`", () => {
        // A missing id used to be registered under the literal `undefined` key
        expect(getWorkflow("undefined", TENANT)).toBeUndefined();
    });

    it("isolates a file that throws on import", () => {
        expect(getWorkflow("broken", TENANT)).toBeUndefined();
        // …and the other workflows are still there
        expect(getWorkflow("order", TENANT)).toBeDefined();
    });

    it("loads the same folder independently for each tenant", () => {
        expect(getWorkflow("order", TENANT)).toBeDefined();
        expect(getWorkflow("order", TENANT_2)).toBeDefined();
        expect(getWorkflow("order", TENANT_2)!._tenant_).toBe(TENANT_2);
    });

    it("reports what was loaded", () => {
        const stats = workflowStats();
        expect(stats.total).toBeGreaterThanOrEqual(2); // one per tenant
        expect(stats.tenants).toContain(TENANT);
        expect(stats.tenants).toContain(TENANT_2);
    });
});

describe("workflow indexes", () => {
    it("creates the indexes the engine queries on", async () => {
        const names = await indexNames(TENANT);
        expect(names).toContain("workflowId_1_createdAt_-1"); // listRuns()
        expect(names).toContain("status_1");                  // resumeAll()
    });

    it("creates the indexes declared by the workflow context", async () => {
        const names = await indexNames(TENANT);
        expect(names).toContain("context.customerId_1");
        expect(names).toContain("context.total_-1");
        expect(names).toContain("context.companyId_1");
        // a field without `index` is not indexed
        expect(names).not.toContain("context.note_1");
        expect(names).not.toContain("context.processedAt_1");
    });

    it("creates the explicit `indexes` — compound, unique, sparse, named", async () => {
        const names = await indexNames(TENANT);
        expect(names).toContain("context.companyId_1_status_1"); // compound
        expect(names).toContain("uniq_batch");                  // explicit name

        const uniq: any = (await rest.db.collection("_workflows_").listIndexes().toArray())
            .find((i: any) => i.name === "uniq_batch");
        expect(uniq.unique).toBe(true);
        expect(uniq.sparse).toBe(true);
    });

    it("is idempotent — running it again creates nothing", async () => {
        const before = (await indexNames(TENANT)).length;
        await ensureWorkflowIndexes();
        expect((await indexNames(TENANT)).length).toBe(before);
    });

    it("serves the engine's own query with an index scan", async () => {
        const col: any = rest.db.collection("_workflows_");
        // A run must exist for the collection to be queryable/explainable
        await rest.workflow.run("invoice", { ref: "A-1" });
        const plan = JSON.stringify(await col.find({ workflowId: "invoice" }).explain("queryPlanner"));
        expect(plan).toContain("IXSCAN"); // COLLSCAN before the loader indexed `workflowId`
    });
});

describe("workflow engine wiring", () => {
    it("runs a workflow loaded from the filesystem", async () => {
        const run = await rest.workflow.run("invoice", { ref: "A-1" }, { companyId: "c-1" });
        expect(run.status).toBe("completed");
        expect(run.workflowVersion).toBe(3);
        expect(run.context).toEqual({ companyId: "c-1" });
        expect(run.steps.length).toBe(2);
        // The run says which process executed it (`reusePort` / forked workers)
        expect(run.pid).toBe(process.pid);
        expect(run.hostname).toBe(os.hostname());

        const runs = await rest.workflow.listRuns("invoice");
        expect(runs.length).toBeGreaterThanOrEqual(1);
    });

    it("refuses to run a disabled workflow", async () => {
        await expect(rest.workflow.run("nightly", {})).rejects.toThrow();
    });
});

describe("workflow context validation", () => {
    it("accepts a context that matches the declaration", async () => {
        const run = await rest.workflow.run("invoice", { ref: "B-1" }, { companyId: "c-2" });
        expect(run.context).toEqual({ companyId: "c-2" });
    });

    it("rejects a wrong type with a clear code", async () => {
        await expect(
            rest.workflow.run("invoice", {}, { companyId: 42 as any }),
        ).rejects.toThrow(/must be a string/);
    });

    it("coerces an ISO string to a real Date (so `context.*` indexes stay typed)", async () => {
        const run = await rest.workflow.run("invoice", {}, {
            companyId: "c-3",
            processedAt: "2026-03-04T05:06:07.000Z" as any,
        });
        expect(run.context.processedAt).toBeInstanceOf(Date);
        expect((run.context.processedAt as Date).toISOString()).toBe("2026-03-04T05:06:07.000Z");

        // …and it is stored as a Date in MongoDB too
        const stored: any = await rest.workflow.getRun(run._id);
        expect(stored.context.processedAt).toBeInstanceOf(Date);
    });

    it("rejects an invalid date", async () => {
        await expect(
            rest.workflow.run("invoice", {}, { processedAt: "not-a-date" as any }),
        ).rejects.toThrow(/must be a date/);
    });

    it("keeps undeclared keys as-is", async () => {
        const run = await rest.workflow.run("invoice", {}, { companyId: "c-4", extra: { any: "thing" } });
        expect(run.context.extra).toEqual({ any: "thing" });
    });
});
