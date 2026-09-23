import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../server/hono";
import { formatConfig, cfg } from "../server/config";
import { syncTenants } from "../database/tenant";
import { useRest } from "../database/rest";
import { AUDIT_COLLECTION } from "../database/audit";

const TENANT = "act-test";
const DB = "mongodb://localhost:27017/_AUDIT_ACTION_TEST";
const SLUG = "invoices";

let internalRest: InstanceType<typeof useRest>;
let server: any;
let url = "";

/**
 * Latest audited `runAction` entry.
 * `#logActivity` is fire-and-forget, and `since` (captured *before* the call)
 * makes sure we wait for the new entry instead of reading the previous one.
 */
async function lastRunAction(since?: Date) {
    for (let i = 0; i < 40; i++) {
        const found: any = await internalRest.db.collection(AUDIT_COLLECTION).findOne(
            { "operation.action": "runAction", ...(since ? { ts: { $gte: since } } : {}) },
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
        actions: {
            greet: async ({ data }: any) => ({ hello: data?.name }),
            boom: async () => { throw new Error("kaboom") },
        },
        api: { access: { "*": true } },
    }];

    internalRest = new useRest({ internal: true, tenant_id: TENANT });

    const app = createApp();
    server = Bun.serve({ port: 0, fetch: app.fetch });
    url = server.url.href.replace(/\/$/, "");
});

afterAll(async () => {
    try { await internalRest.db.collection(SLUG).drop(); } catch (_) {}
    try { await internalRest.db.collection(AUDIT_COLLECTION).drop(); } catch (_) {}
    try { server.stop(true); } catch {}
});

describe("audit — custom actions (runAction)", () => {
    it("audits an internal call with the action name and its data, never the payload", async () => {
        const since = new Date();
        const result: any = await internalRest.runAction(SLUG, "greet", { name: "Ada" });

        // the caller still receives the action's payload…
        expect(result).toEqual({ hello: "Ada" });

        // …but the audit only holds the parameters
        const logged = await lastRunAction(since);
        expect(logged).not.toBeNull();
        expect(logged.operation.input.action).toBe("greet");
        expect(logged.operation.input.data).toEqual({ name: "Ada" });
        expect(logged.operation.result).toBeNull();
        expect(logged.operation.status).toBe("success");
        expect(logged.internal).toBe(true);
    });

    it("audits the HTTP route as well, and marks it as not internal", async () => {
        const since = new Date();
        const res = await fetch(`${url}/api/${TENANT}/collections/${SLUG}/greet`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data: { name: "Grace" } }),
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ hello: "Grace" });

        const logged = await lastRunAction(since);
        expect(logged.operation.input.action).toBe("greet");
        expect(logged.operation.input.data).toEqual({ name: "Grace" });
        expect(logged.operation.result).toBeNull();
        expect(logged.internal).toBe(false);
    });

    it("records a failing action with its error, and rethrows it unchanged", async () => {
        const since = new Date();

        // `wrapErrors: false` — a custom action's own error reaches the caller as-is
        await expect(internalRest.runAction(SLUG, "boom")).rejects.toThrow("kaboom");

        const logged = await lastRunAction(since);
        expect(logged.operation.status).toBe("error");
        expect(logged.operation.error.message).toBe("kaboom");
        expect(logged.operation.result).toBeNull();
    });

    it("records an unknown action", async () => {
        const since = new Date();
        await expect(internalRest.runAction(SLUG, "nope")).rejects.toThrow();

        const logged = await lastRunAction(since);
        expect(logged.operation.status).toBe("error");
        expect(logged.operation.error.code).toBe("ACTION_NOT_FOUND");
    });
});
