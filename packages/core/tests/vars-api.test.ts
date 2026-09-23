import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { ObjectId } from "mongodb";
import { createApp } from "../server/hono";
import { formatConfig, cfg } from "../server/config";
import { syncTenants } from "../database/tenant";
import { syncVars } from "../database/vars";
import { useRest } from "../database/rest";

const TENANT = "vars-api";
const DB = "mongodb://localhost:27017/_VARS_API_TEST";
const DIR = "packages/core/tests/fixtures/vars-tenant";

let rest: InstanceType<typeof useRest>;
let server: any;
let url = "";

beforeAll(async () => {
    formatConfig({
        server: { port: 4000 },
        tenants: [{ id: TENANT, dir: DIR, database: { uri: DB } }],
    });
    await syncTenants();
    await syncVars();

    rest = new useRest({ internal: false, tenant_id: TENANT });
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
