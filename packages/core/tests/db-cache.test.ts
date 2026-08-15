import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { ObjectId } from "mongodb";
import { useRest } from "../database/rest";
import { formatConfig, cfg } from "../server/config";
import { syncTenants } from "../database/tenant";
import { syncCollections } from "../database/collection";

const TEST_TENANT = "cache-test";
const TEST_DB = "mongodb://localhost:27017/_DB_CACHE_TEST";

let rest: InstanceType<typeof useRest>;

beforeAll(async () => {
    formatConfig({
        server: { port: 4000, cache: { driver: "memory", enabled: true } },
        tenants: [
            { id: TEST_TENANT, dir: "src", database: { uri: TEST_DB } },
            { id: "cache-test-2", dir: "src", database: { uri: TEST_DB } },
        ],
    });
    await syncTenants();
    await syncCollections();
    (cfg as any).collections = [
        { _tenant_: TEST_TENANT, slug: "items", fields: [{ name: "title", type: "string" }, { name: "count", type: "number" }], api: { access: { "*": true } } },
        { _tenant_: TEST_TENANT, slug: "orders", fields: [{ name: "code", type: "string" }, { name: "author", type: "relationship", relation: { to: "clients" } }], api: { access: { "*": true } } },
        { _tenant_: TEST_TENANT, slug: "clients", fields: [{ name: "name", type: "string" }], api: { access: { "*": true } } },
    ];
    rest = new useRest({ internal: false, tenant_id: TEST_TENANT });
});

afterAll(async () => {
    try { await rest.db.collection("items").drop(); } catch {}
    try { await rest.db.collection("orders").drop(); } catch {}
    try { await rest.db.collection("clients").drop(); } catch {}
});

describe("DB query cache (useCache)", () => {
    it("serves from cache and invalidates on framework writes", async () => {
        const marker = `dc-${crypto.randomUUID()}`;
        await rest.insertMany("items", [{ title: marker }, { title: marker }]);
        const params = { $match: { title: marker } };

        const r1 = await rest.find("items", params, { useCache: true });
        expect(r1.length).toBe(2);

        // direct DB write (bypasses the framework) → cache is still served (stale)
        await rest.db.collection("items").insertOne({ title: marker });
        const r2 = await rest.find("items", params, { useCache: true });
        expect(r2.length).toBe(2); // from cache

        // framework insert → invalidates → refetches (now 4 docs: 2 + direct + framework)
        await rest.insertOne("items", { title: marker });
        const r3 = await rest.find("items", params, { useCache: true });
        expect(r3.length).toBe(4); // refetched

        // framework delete → invalidates
        await rest.deleteMany("items", [r3[0]!._id]);
        const r4 = await rest.find("items", params, { useCache: true });
        expect(r4.length).toBe(3);

        await rest.db.collection("items").deleteMany({ title: marker });
    });

    it("different params produce different cache entries", async () => {
        const marker = `dp-${crypto.randomUUID()}`;
        await rest.insertMany("items", [{ title: marker, count: 1 }, { title: marker, count: 2 }]);
        await rest.find("items", { $match: { title: marker, count: 1 } }, { useCache: true });
        const r = await rest.find("items", { $match: { title: marker, count: 2 } }, { useCache: true });
        expect(r.length).toBe(1);
        expect(r[0]!.count).toBe(2);
        await rest.db.collection("items").deleteMany({ title: marker });
    });

    it("relations: modifying the included collection invalidates the parent cache", async () => {
        const client = await rest.insertOne("clients", { name: "Old" });
        const order = await rest.insertOne("orders", { code: "O1", author: client._id });

        const params = { $match: { _id: order._id }, $include: ["author"] };
        const r1: any = await rest.find("orders", params, { useCache: true });
        expect(r1[0]!.author.name).toBe("Old");

        // direct DB write on clients (bypass) → orders cache still stale
        await rest.db.collection("clients").updateOne({ _id: new ObjectId(client._id) }, { $set: { name: "Direct" } });
        const r2: any = await rest.find("orders", params, { useCache: true });
        expect(r2[0]!.author.name).toBe("Old"); // from cache

        // framework write on clients → invalidates orders cache too (relation)
        await rest.updateOne("clients", client._id, { $set: { name: "New" } });
        const r3: any = await rest.find("orders", params, { useCache: true });
        expect(r3[0]!.author.name).toBe("New"); // refetched

        await rest.db.collection("orders").deleteMany({ _id: order._id });
        await rest.db.collection("clients").deleteMany({ _id: client._id });
    });

    it("collection cache.ttl default applies without the option", async () => {
        (cfg.collections as any)[0]!.cache = { ttl: "1m" };
        const marker = `cttl-${crypto.randomUUID()}`;
        await rest.insertOne("items", { title: marker });
        const r1 = await rest.find("items", { $match: { title: marker } }, { useCache: true });
        expect(r1.length).toBe(1);
        delete (cfg.collections as any)[0]!.cache;
        await rest.db.collection("items").deleteMany({ title: marker });
    });

    it("targeted invalidation: an id NOT in the cached result keeps the cache", async () => {
        const marker = `ti-out-${crypto.randomUUID()}`;
        const feb1 = await rest.insertOne("items", { title: marker, month: "feb" });
        const feb2 = await rest.insertOne("items", { title: marker, month: "feb" });
        const jan = await rest.insertOne("items", { title: marker, month: "jan" });

        const params = { $match: { title: marker, month: "feb" } };
        const r1 = await rest.find("items", params, { useCache: true });
        expect(r1.length).toBe(2); // cached (ids: feb1, feb2)

        // update a JANUARY doc (id not in the cached result) → no invalidation
        await rest.updateOne("items", jan._id, { $set: { month: "feb" } });
        const r2 = await rest.find("items", params, { useCache: true });
        expect(r2.length).toBe(2); // served from cache — jan's doc NOT in the result

        await rest.db.collection("items").deleteMany({ title: marker });
    });

    it("targeted invalidation: an id IN the cached result invalidates it", async () => {
        const marker = `ti-in-${crypto.randomUUID()}`;
        const a = await rest.insertOne("items", { title: marker, count: 1 });
        const b = await rest.insertOne("items", { title: marker, count: 2 });

        const params = { $match: { title: marker } };
        const r1: any = await rest.find("items", params, { useCache: true });
        expect(r1.find((d: any) => d._id === a._id)!.count).toBe(1);

        // update a doc that IS in the cached result → targeted invalidation → refetch
        await rest.updateOne("items", a._id, { $set: { count: 99 } });
        const r2: any = await rest.find("items", params, { useCache: true });
        expect(r2.find((d: any) => d._id === a._id)!.count).toBe(99);
        expect(r2.length).toBe(2);

        // delete a doc in the cache → invalidated → refetch
        await rest.deleteOne("items", b._id);
        const r3 = await rest.find("items", params, { useCache: true });
        expect(r3.length).toBe(1);

        await rest.db.collection("items").deleteMany({ title: marker });
    });

    it("targeted invalidation works with native ObjectId ids", async () => {
        const marker = `ti-oid-${crypto.randomUUID()}`;
        const a = await rest.insertOne("items", { title: marker, count: 1 });

        const params = { $match: { title: marker } };
        const r1: any = await rest.find("items", params, { useCache: true });
        expect(r1[0]!.count).toBe(1);

        // update avec un ObjectId NATIF (pas un string) — la normalisation String(id) doit matcher l'index
        await rest.updateOne("items", new ObjectId(a._id), { $set: { count: 77 } });
        const r2: any = await rest.find("items", params, { useCache: true });
        expect(r2[0]!.count).toBe(77); // invalidé + refetch

        await rest.db.collection("items").deleteMany({ title: marker });
    });

    it("maxTags configurable caps the tagged ids", async () => {
        const cacheConf = (cfg.server as any).cache;
        (cfg.server as any).cache = { ...cacheConf, maxTags: 2 };
        const marker = `mt-${crypto.randomUUID()}`;
        const a = await rest.insertOne("items", { title: marker, count: 1 });
        const b = await rest.insertOne("items", { title: marker, count: 2 });
        const c = await rest.insertOne("items", { title: marker, count: 3 });

        const params = { $match: { title: marker }, $sort: { count: 1 } }; // ordre garanti: a(1), b(2), c(3)
        await rest.find("items", params, { useCache: true }); // cache peuplé (3 docs)

        // le 3e id (c) n'est PAS taggé (maxTags: 2) → pas d'invalidation ciblée
        await rest.updateOne("items", c._id, { $set: { count: 33 } });
        const r1: any = await rest.find("items", params, { useCache: true });
        expect(r1.find((d: any) => d._id === c._id)!.count).toBe(3); // cache conservé

        // le 1er id (a) est taggé → invalidation ciblée
        await rest.updateOne("items", a._id, { $set: { count: 11 } });
        const r2: any = await rest.find("items", params, { useCache: true });
        expect(r2.find((d: any) => d._id === a._id)!.count).toBe(11); // refetch

        (cfg.server as any).cache = cacheConf; // restore
        await rest.db.collection("items").deleteMany({ title: marker });
    });

    it("rest.cache is tenant-scoped", async () => {
        // write from tenant A
        await rest.cache.set("price:42", { total: 99 }, "5m");
        expect(await rest.cache.get("price:42")).toEqual({ total: 99 });
        expect(await rest.cache.has("price:42")).toBe(true);

        // tenant B does NOT see tenant A's keys
        const restB = new useRest({ tenant_id: "cache-test-2" });
        expect(await restB.cache.get("price:42")).toBeUndefined();
        await restB.cache.set("price:42", { total: 0 });
        expect(await restB.cache.get("price:42")).toEqual({ total: 0 });
        // tenant A unchanged
        expect(await rest.cache.get("price:42")).toEqual({ total: 99 });

        // getOrSet + delete
        let calls = 0;
        const v = await rest.cache.getOrSet("stats", async () => { calls++; return { n: 1 }; });
        expect(v).toEqual({ n: 1 });
        const v2 = await rest.cache.getOrSet("stats", async () => { calls++; return { n: 2 }; });
        expect(v2).toEqual({ n: 1 });
        expect(calls).toBe(1);

        await rest.cache.delete("price:42");
        await rest.cache.delete("stats");
        expect(await rest.cache.get("price:42")).toBeUndefined();
    });
});
