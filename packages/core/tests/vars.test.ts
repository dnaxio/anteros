import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { MongoClient, ObjectId } from "mongodb";
import { useRest } from "../database/rest";
import { formatConfig, cfg } from "../server/config";
import { syncVars } from "../database/vars";
import { define } from "../lib/define";

const TEST_TENANT = "vars";
const DB = "mongodb://localhost:27017/_VARS_TEST";

let rest: InstanceType<typeof useRest>;
let client: MongoClient;
const raw = () => client.db().collection("_vars_");

beforeAll(async () => {
    formatConfig({
        server: { port: 4000 },
        tenants: [{
            id: TEST_TENANT,
            dir: "packages/core/tests/fixtures/vars-tenant",
            database: { uri: DB },
        }],
    });

    client = new MongoClient(DB, { serverSelectionTimeoutMS: 3000 });
    await client.connect();
    const tenant: any = cfg.tenants?.[0];
    tenant.database.client = client;
    tenant.database.db = client.db();

    await syncVars();

    rest = new useRest({ tenant_id: TEST_TENANT });
});

afterAll(async () => {
    try { await client.db().dropDatabase(); } catch (_) {}
    try { await client.close(); } catch (_) {}
});

describe("define.Vars", () => {
    it("marks the definition", () => {
        const v = define.Vars({ namespace: "x", vars: { a: 1 } });
        expect(v._isVars_).toBe(true);
    });
});

describe("vars loading & seeding", () => {
    it("loads the definitions from vars/*.var.ts", () => {
        const namespaces = (cfg.vars ?? []).map((v) => v.namespace).sort();
        expect(namespaces).toEqual(["config", "private"]);
        expect((cfg.vars ?? []).every((v) => v._tenant_ === TEST_TENANT)).toBe(true);
    });

    it("seeds default values at the global scope", async () => {
        expect(await rest.vars.get<string>("config", "licence")).toBe("RDX00");
        expect(await rest.vars.get<number>("config", "maxUsers")).toBe(100);
    });

    it("never overwrites an existing value when re-seeding", async () => {
        await rest.vars.set("config", "licence", "CHANGED");
        await syncVars();
        expect(await rest.vars.get<string>("config", "licence")).toBe("CHANGED");
    });

    it("always creates the scope + TTL indexes", async () => {
        const names = (await raw().listIndexes().toArray()).map((i) => i.name);
        expect(names).toContain("scope_1_ns_1");
        expect(names).toContain("expiresAt_1");
    });
});

describe("rest.vars — CRUD", () => {
    it("set / get / has / del", async () => {
        await rest.vars.set("app", "theme", "dark");
        expect(await rest.vars.get<string>("app", "theme")).toBe("dark");
        expect(await rest.vars.has("app", "theme")).toBe(true);

        expect(await rest.vars.del("app", "theme")).toBe(true);
        expect(await rest.vars.get<string>("app", "theme")).toBeUndefined();
        expect(await rest.vars.has("app", "theme")).toBe(false);
        expect(await rest.vars.del("app", "theme")).toBe(false);
    });

    it("stores rich values (objects, arrays, booleans)", async () => {
        const value = { max: 10, tags: ["a", "b"], on: true };
        await rest.vars.set("app", "limits", value);
        expect(await rest.vars.get<any>("app", "limits")).toEqual(value);
    });

    it("setMany / all / clear", async () => {
        await rest.vars.setMany("bulk", { a: 1, b: 2, c: 3 });
        expect(await rest.vars.all("bulk")).toEqual({ a: 1, b: 2, c: 3 });
        expect(await rest.vars.clear("bulk")).toBe(3);
        expect(await rest.vars.all("bulk")).toEqual({});
    });

    it("incr is atomic (and creates a missing key)", async () => {
        await rest.vars.set("counters", "hits", 5);
        expect(await rest.vars.incr("counters", "hits")).toBe(6);
        expect(await rest.vars.incr("counters", "hits", 10)).toBe(16);
        expect(await rest.vars.incr("counters", "fresh", 3)).toBe(3);
    });

    it("isolates namespaces", async () => {
        await rest.vars.set("ns1", "k", "a");
        await rest.vars.set("ns2", "k", "b");
        expect(await rest.vars.get<string>("ns1", "k")).toBe("a");
        expect(await rest.vars.get<string>("ns2", "k")).toBe("b");
    });
});

describe("rest.vars — scope (per company)", () => {
    it("keeps a distinct value per scope", async () => {
        const acme = new ObjectId().toHexString();
        const globex = new ObjectId().toHexString();

        await rest.vars.scope(acme).set("config", "licence", "ACME-001");
        await rest.vars.scope(globex).set("config", "licence", "GLBX-002");

        expect(await rest.vars.scope(acme).get<string>("config", "licence")).toBe("ACME-001");
        expect(await rest.vars.scope(globex).get<string>("config", "licence")).toBe("GLBX-002");
        // global value untouched
        expect(await rest.vars.get<string>("config", "licence")).not.toBe("ACME-001");
    });

    it("accepts an explicit scope option", async () => {
        const id = new ObjectId().toHexString();
        await rest.vars.set("config", "licence", "SCOPED", { scope: id });
        expect(await rest.vars.get<string>("config", "licence", { scope: id })).toBe("SCOPED");
    });
});

describe("rest.vars — meta", () => {
    it("stores and returns validated meta", async () => {
        const id = new ObjectId().toHexString();
        const acme = rest.vars.scope(id);

        await acme.set("config", "licence", "ACME-003", { meta: { note: "Contrat 2026" } });
        const entry = await acme.entry("config", "licence");

        expect(entry?.value).toBe("ACME-003");
        expect(entry?.meta).toEqual({ note: "Contrat 2026" });
        expect(String(entry?.scope)).toBe(id);
    });

    it("rejects unknown meta keys", async () => {
        await expect(
            rest.vars.set("config", "licence", "X", { meta: { nope: 1 } }),
        ).rejects.toThrow(/nope/);
    });

    it("filters entries on meta with `where`", async () => {
        const id = new ObjectId().toHexString();
        const acme = rest.vars.scope(id);

        await acme.setMany("flags", { a: true, b: false }, { meta: { note: "grp" } });
        const found = await acme.entries("flags", { where: { note: "grp" } });

        expect(found.length).toBe(2);
        expect(await acme.entries("flags", { where: { note: "other" } })).toEqual([]);
    });
});

describe("rest.vars — validation", () => {
    it("rejects a value that does not match its spec", async () => {
        await expect(rest.vars.set("config", "maxUsers", "not-a-number")).rejects.toThrow(/maxUsers/);
    });
});

describe("rest.vars — TTL", () => {
    it("stores an expiry set per call", async () => {
        await rest.vars.set("ttl", "k", "v", { ttl: "1h" });
        const entry = await rest.vars.entry("ttl", "k");
        expect(entry?.expiresAt).toBeInstanceOf(Date);
        expect(entry!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it("applies the variable's default TTL", async () => {
        await rest.vars.set("config", "session", "s1"); // `session` declares ttl: '1h'
        const entry = await rest.vars.entry("config", "session");
        expect(entry?.expiresAt).toBeInstanceOf(Date);
    });

    it("`set` without ttl clears an existing one", async () => {
        await rest.vars.set("ttl", "clear", "v", { ttl: "1h" });
        await rest.vars.set("ttl", "clear", "v2"); // no ttl → authoritative reset
        const entry = await rest.vars.entry("ttl", "clear");
        expect(entry?.expiresAt).toBeNull();
    });

    it("`expire` sets / renews the TTL", async () => {
        await rest.vars.set("ttl", "renew", "v");
        expect(await rest.vars.expire("ttl", "renew", "30m")).toBe(true);
        const entry = await rest.vars.entry("ttl", "renew");
        expect(entry?.expiresAt).toBeInstanceOf(Date);
    });

    it("hides an expired entry from reads", async () => {
        await raw().insertOne({
            _id: "config:gone",
            ns: "config", key: "gone", scope: null,
            value: "x", meta: {},
            expiresAt: new Date(Date.now() - 1000),
            createdAt: new Date(), updatedAt: new Date(),
        } as any);

        expect(await rest.vars.get<string>("config", "gone")).toBeUndefined();
        expect(await rest.vars.has("config", "gone")).toBe(false);
        expect(await rest.vars.entry("config", "gone")).toBeUndefined();
    });

    it("rejects an invalid ttl", async () => {
        await expect(rest.vars.set("ttl", "bad", "v", { ttl: "abc" })).rejects.toThrow(/ttl/);
    });
});
