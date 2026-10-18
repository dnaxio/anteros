import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { ObjectId } from "mongodb";
import { createApp } from "../server/hono";
import { formatConfig, cfg } from "../server/config";
import { syncTenants } from "../database/tenant";
import { syncVars } from "../database/vars";
import { useRest } from "../database/rest";
import { jwt } from "../utils/func";

const TENANT = "vars-api";
const DB = "mongodb://localhost:27017/_VARS_API_TEST";
const DIR = "packages/core/tests/fixtures/vars-tenant";

let rest: InstanceType<typeof useRest>;
let server: any;
let url = "";
let token = "";

beforeAll(async () => {
    formatConfig({
        server: { port: 4000, jwt: { secret: "vars-api-test-secret" } },
        tenants: [{ id: TENANT, dir: DIR, database: { uri: DB } }],
    });
    await syncTenants();
    await syncVars();

    rest = new useRest({ internal: false, tenant_id: TENANT });
    token = await jwt.sign({ sub: "vars-tester" });
    const app = createApp();
    server = Bun.serve({ port: 0, fetch: app.fetch });
    url = server.url.href.replace(/\/$/, "");
});

afterAll(async () => {
    try { await rest.db.dropDatabase(); } catch (_) {}
    try { server.stop(true); } catch (_) {}
});

const post = (action: string, body: any) =>
    fetch(`${url}/api/${TENANT}/vars/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

const json = async (action: string, body: any) => {
    const res = await post(action, body);
    return { status: res.status, body: await res.json() as any };
};

/** A function access rule requires a valid token — used by the `open` namespace `all` rule. */
const authedJson = async (action: string, body: any) => {
    const res = await fetch(`${url}/api/${TENANT}/vars/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
};

describe("vars HTTP API — access control", () => {
    it("denies a namespace without api.access", async () => {
        const res = await json("get", { ns: "private", key: "secret" });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe("ACCESS_DENIED");
    });

    it("rejects an unknown namespace", async () => {
        const res = await json("get", { ns: "nope", key: "x" });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("NAMESPACE_NOT_FOUND");
    });

    it("requires the namespace", async () => {
        const res = await json("get", { key: "x" });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("NAMESPACE_REQUIRED");
    });
});

describe("vars HTTP API — CRUD", () => {
    it("set / get / has / del", async () => {
        expect((await json("set", { ns: "config", key: "plan", value: "pro" })).status).toBe(200);

        const got = await json("get", { ns: "config", key: "plan" });
        expect(got.body.value).toBe("pro");

        expect((await json("has", { ns: "config", key: "plan" })).body.exists).toBe(true);
        expect((await json("del", { ns: "config", key: "plan" })).body.ok).toBe(true);
        expect((await json("get", { ns: "config", key: "plan" })).body.value).toBeUndefined();
    });

    it("setMany / all", async () => {
        await json("setMany", { ns: "config", entries: { a: 1, b: 2 } });
        const all = await json("all", { ns: "config" });
        expect(all.body.vars).toMatchObject({ a: 1, b: 2 });
    });

    it("entry carries the meta", async () => {
        const id = new ObjectId().toHexString();
        await json("set", { ns: "config", key: "lic", value: "L-1", meta: { note: "hi" }, scope: id });

        const entry = await json("entry", { ns: "config", key: "lic", scope: id });
        expect(entry.body.entry.value).toBe("L-1");
        expect(entry.body.entry.meta).toEqual({ note: "hi" });
    });

    it("incr", async () => {
        await json("set", { ns: "config", key: "hits", value: 5 });
        expect((await json("incr", { ns: "config", key: "hits" })).body.value).toBe(6);
    });

    it("scope keeps values isolated", async () => {
        const id = new ObjectId().toHexString();
        await json("set", { ns: "config", key: "lic", value: "SCOPED", scope: id });
        expect((await json("get", { ns: "config", key: "lic", scope: id })).body.value).toBe("SCOPED");
    });

    it("TTL round-trips as an expiry", async () => {
        await json("set", { ns: "config", key: "tmp", value: "x", ttl: "1h" });
        const entry = await json("entry", { ns: "config", key: "tmp" });
        expect(typeof entry.body.entry.expiresAt).toBe("string");
        expect((await json("expire", { ns: "config", key: "tmp", ttl: "30m" })).body.ok).toBe(true);
    });

    it("validates the value against its spec", async () => {
        const res = await json("set", { ns: "config", key: "maxUsers", value: "not-a-number" });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("VALIDATION_ERROR");
    });

    it("rejects an unknown action", async () => {
        const res = await json("nope", { ns: "config", key: "x" });
        expect(res.status).toBe(400);
    });
});

describe("vars HTTP API — scope cannot be a Mongo operator (#34)", () => {
    it("refuses an operator scope on every read/delete action", async () => {
        // Seed a real scoped value in the unscoped namespace.
        expect((await json("set", { ns: "open", key: "token", value: "alice-secret", scope: "alice" })).status).toBe(200);

        for (const action of ["all", "entries", "clear"]) {
            const res = await authedJson(action, { ns: "open", scope: { $ne: null } });
            expect({ action, status: res.status }).toEqual({ action, status: 400 });
            expect(res.body.code).toBe("VALIDATION_ERROR");
        }

        // Nothing was deleted and the scoped value is intact.
        const got = await json("get", { ns: "open", key: "token", scope: "alice" });
        expect(got.body.value).toBe("alice-secret");
    });

    it("refuses an operator scope on writes too", async () => {
        for (const action of ["set", "del"]) {
            const res = await json(action, { ns: "open", key: "token", value: "x", scope: { $ne: null } });
            expect({ action, status: res.status }).toEqual({ action, status: 400 });
        }
    });

    it("still accepts a string scope on an unscoped namespace", async () => {
        const set = await json("set", { ns: "open", key: "token", value: "bob-secret", scope: "bob" });
        expect(set.status).toBe(200);
        const all = await authedJson("all", { ns: "open", scope: "bob" });
        expect(all.status).toBe(200);
        expect(all.body.vars.token).toBe("bob-secret");
    });

    it("gives the access rule the namespace and the body", async () => {
        // The `open` namespace rule only allows `all` when it receives `{ namespace, body }`.
        const res = await authedJson("all", { ns: "open", scope: "alice" });
        expect(res.status).toBe(200);
    });

    it("refuses operators in the `where` meta filter", async () => {
        const res = await json("entries", { ns: "open", where: { note: { $ne: null } } });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("VALIDATION_ERROR");
    });
});

describe("vars HTTP API — audit (#50)", () => {
    it("never stores the values returned by a read", async () => {
        await json("set", { ns: "config", key: "audit-secret", value: "super-secret-value" });
        await json("get", { ns: "config", key: "audit-secret" });

        const logged: any = await rest.db.collection("_audit_").findOne(
            { "operation.action": "get", "operation.collection": "_vars_:config" },
            { sort: { ts: -1 } },
        );
        expect(logged).not.toBeNull();
        expect(logged.operation.result == null).toBe(true);
        expect(JSON.stringify(logged)).not.toContain("super-secret-value");
    });
});
