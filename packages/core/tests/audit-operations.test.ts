import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../server/hono";
import { formatConfig, cfg } from "../server/config";
import { syncTenants } from "../database/tenant";
import { useRest } from "../database/rest";
import { AUDIT_COLLECTION } from "../database/audit";

const TENANT = "ops-test";
const DB = "mongodb://localhost:27017/_AUDIT_OPS_TEST";
const SLUG = "orders";
const SERVICE = "billing";

let internalRest: InstanceType<typeof useRest>;
let server: any;
let url = "";

/** Latest audited entry for an action, written *after* `since` (fire-and-forget logging) */
async function lastActivity(action: string, since?: Date) {
    for (let i = 0; i < 40; i++) {
        const found: any = await internalRest.db.collection(AUDIT_COLLECTION).findOne(
            { "operation.action": action, ...(since ? { ts: { $gte: since } } : {}) },
            { sort: { ts: -1 } },
        );
        if (found) return found;
        await Bun.sleep(25);
    }
    return null;
}

beforeAll(async () => {
    formatConfig({
        server: { port: 4000 },
        tenants: [{ id: TENANT, dir: "src", database: { uri: DB } }],
    });
    await syncTenants();

    (cfg as any).collections = [{
        _tenant_: TENANT,
        slug: SLUG,
        fields: [{ name: "ref", type: "string" }],
        api: { access: { "*": true } },
    }];
    (cfg as any).services = [{
        _tenant_: TENANT,
        name: SERVICE,
        enabled: true,
        actions: {
            charge: async ({ data }: any) => ({ charged: data?.amount }),
            boom: async () => { throw new Error("service-kaboom") },
        },
        api: { access: { "*": true } },
    }];

    internalRest = new useRest({ internal: true, tenant_id: TENANT });

    await internalRest.insertMany(SLUG, [{ ref: "A-1" }, { ref: "A-2" }]);

    const app = createApp();
    server = Bun.serve({ port: 0, fetch: app.fetch });
    url = server.url.href.replace(/\/$/, "");
});

afterAll(async () => {
    try { await internalRest.db.collection(SLUG).drop(); } catch (_) {}
    try { await internalRest.db.collection(AUDIT_COLLECTION).drop(); } catch (_) {}
    try { server.stop(true); } catch {}
});

describe("audit — streams", () => {
    it("audits `findStream` with its parameters and no result", async () => {
        const since = new Date();
        const docs: any[] = [];
        for await (const doc of internalRest.findStream(SLUG, { $match: { ref: "A-1" } }, { batchSize: 10 })) {
            docs.push(doc);
        }
        expect(docs.length).toBe(1); // the consumer really got the documents

        const logged = await lastActivity("findStream", since);
        expect(logged).not.toBeNull();
        expect(logged.operation.input.params).toEqual({ $match: { ref: "A-1" } });
        expect(logged.operation.input.options).toEqual({ batchSize: 10 });
        expect(logged.operation.result).toBeNull();
        expect(logged.operation.status).toBe("success");
        expect(typeof logged.operation.duration).toBe("number");
    });

    it("audits `aggregateStream` with its pipeline and no result", async () => {
        const since = new Date();
        const pipeline = [{ $match: { ref: "A-2" } }];
        const rows: any[] = [];
        for await (const doc of internalRest.aggregateStream(SLUG, pipeline, { batchSize: 10 })) {
            rows.push(doc);
        }
        expect(rows.length).toBe(1);

        const logged = await lastActivity("aggregateStream", since);
        expect(logged).not.toBeNull();
        expect(logged.operation.input.pipeline).toEqual(pipeline);
        expect(logged.operation.result).toBeNull();
    });

    it("audits a stream that breaks early (the entry is written on `finally`)", async () => {
        const since = new Date();
        for await (const _doc of internalRest.findStream(SLUG, {}, { batchSize: 1 })) {
            break; // consumer stops after the first document
        }

        const logged = await lastActivity("findStream", since);
        expect(logged).not.toBeNull();
        expect(logged.operation.status).toBe("success");
    });

    it("audits `watch` with its parameters and no result", async () => {
        const since = new Date();
        const pipeline = [{ $match: { "fullDocument.ref": "A-1" } }];
        const stream = await internalRest.watch(SLUG, pipeline, {});
        expect(stream).toBeDefined();

        const logged = await lastActivity("watch", since);
        expect(logged).not.toBeNull();
        expect(logged.operation.input.pipeline).toEqual(pipeline);
        expect(logged.operation.result).toBeNull();

        await stream.close().catch(() => {});
    });
});

describe("audit — services", () => {
    it("audits an internal `rest.runService` call and marks it as internal", async () => {
        const since = new Date();
        const result: any = await internalRest.runService(SERVICE, "charge", { amount: 42 });
        expect(result).toEqual({ charged: 42 }); // the caller still gets the payload

        const logged = await lastActivity("runService", since);
        expect(logged).not.toBeNull();
        expect(logged.operation.collection).toBe(SERVICE);
        expect(logged.operation.input.action).toBe("charge");
        expect(logged.operation.input.data).toEqual({ amount: 42 });
        expect(logged.operation.result).toBeNull();
        expect(logged.internal).toBe(true);
    });

    it("audits the HTTP route once — not twice — and marks it as not internal", async () => {
        const since = new Date();
        const before = await internalRest.db.collection(AUDIT_COLLECTION)
            .countDocuments({ "operation.action": "runService" });

        const res = await fetch(`${url}/services/${TENANT}/${SERVICE}/charge`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data: { amount: 7 } }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ charged: 7 });

        await lastActivity("runService", since);
        const after = await internalRest.db.collection(AUDIT_COLLECTION)
            .countDocuments({ "operation.action": "runService" });

        expect(after - before).toBe(1); // exactly one entry — the route no longer logs its own
        const logged = await lastActivity("runService", since);
        expect(logged.internal).toBe(false);
        expect(logged.operation.input.data).toEqual({ amount: 7 });
    });

    it("records a failing service action with its error, and rethrows it unchanged", async () => {
        const since = new Date();
        await expect(internalRest.runService(SERVICE, "boom")).rejects.toThrow("service-kaboom");

        const logged = await lastActivity("runService", since);
        expect(logged.operation.status).toBe("error");
        expect(logged.operation.error.message).toBe("service-kaboom");
        expect(logged.operation.result).toBeNull();
    });

    it("records an unknown service", async () => {
        const since = new Date();
        await expect(internalRest.runService("nope", "charge")).rejects.toThrow();

        const logged = await lastActivity("runService", since);
        expect(logged.operation.status).toBe("error");
        expect(logged.operation.error.code).toBe("SERVICE_NOT_FOUND");
    });
});
