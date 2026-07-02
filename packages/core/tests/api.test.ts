import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { useRest } from "../database/rest";
import { formatConfig, cfg } from "../server/config";
import { syncTenants } from "../database/tenant";
import { syncCollections } from "../database/collection";

const TEST_TENANT = "test";
const TEST_DB = "mongodb://localhost:27017/_DB_TEST";

let rest: InstanceType<typeof useRest>;

beforeAll(async () => {
    formatConfig({
        tenants: [{ id: TEST_TENANT, dir: "src", database: { uri: TEST_DB } }],
    });
    await syncTenants();
    await syncCollections();

    (cfg as any).collections = [
        {
            _tenant_: TEST_TENANT,
            slug: "items",
            fields: [
                { name: "title", type: "string", required: true },
                { name: "count", type: "number" },
            ],
            api: { access: { "*": true } },
        },
    ];

    rest = new useRest({ internal: false, tenant_id: TEST_TENANT });
});

afterAll(async () => {
    try { await rest.db.collection("items").drop(); } catch (_) {}
    try { await rest.db.collection("_locks_").drop(); } catch (_) {}
});

// ─── CRUD ────────────────────────────────────────────────────────────

describe("insertOne", () => {
    it("returns _id as 24-char hex string", async () => {
        const doc = await rest.insertOne("items", { title: "hello", count: 1 });
        expect(doc._id).toBeString();
        expect(doc._id.length).toBe(24);
    });
    it("sets createdAt and updatedAt", async () => {
        const doc = await rest.insertOne("items", { title: "ts" });
        expect(doc.createdAt).toBeString();
        expect(doc.updatedAt).toBeString();
    });
});

describe("find", () => {
    it("returns an array", async () => {
        expect(Array.isArray(await rest.find("items", {}))).toBe(true);
    });
    it("filters with $match", async () => {
        await rest.insertOne("items", { title: "match-me", count: 42 });
        const docs = await rest.find("items", { $match: { count: 42 } });
        expect(docs.length).toBeGreaterThanOrEqual(1);
    });
    it("matches _id string", async () => {
        const doc = await rest.insertOne("items", { title: "by-id" });
        const docs = await rest.find("items", { $match: { _id: doc._id } });
        expect(docs.length).toBe(1);
    });
    it("respects $limit", async () => {
        await rest.insertOne("items", { title: "a1" });
        await rest.insertOne("items", { title: "a2" });
        expect((await rest.find("items", { $limit: 1 })).length).toBe(1);
    });
});

describe("findOne", () => {
    it("returns single doc by _id", async () => {
        const doc = await rest.insertOne("items", { title: "single" });
        expect((await rest.findOne("items", doc._id)).title).toBe("single");
    });
    it("returns null for unknown id", async () => {
        expect(await rest.findOne("items", "aaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
    });
});

describe("updateOne", () => {
    it("$set title and changes updatedAt", async () => {
        const doc = await rest.insertOne("items", { title: "old" });
        const upd = await rest.updateOne("items", doc._id, { $set: { title: "new" } });
        expect(upd.title).toBe("new");
        expect(upd.updatedAt).not.toBe(doc.updatedAt);
    });
});

describe("deleteOne", () => {
    it("deletes and returns _id", async () => {
        const doc = await rest.insertOne("items", { title: "del-me" });
        expect((await rest.deleteOne("items", doc._id))._id).toBe(doc._id);
    });
});

describe("insertMany", () => {
    it("inserts and returns array with _id", async () => {
        const docs = await rest.insertMany("items", [{ title: "m1" }, { title: "m2" }]);
        expect(docs.length).toBe(2);
        expect(docs[0]._id).toBeString();
        expect(docs[1]._id).toBeString();
    });
});

describe("updateMany", () => {
    it("updates multiple by ids", async () => {
        const a = await rest.insertOne("items", { title: "u1", count: 1 });
        const b = await rest.insertOne("items", { title: "u2", count: 1 });
        const r = await rest.updateMany("items", [a._id, b._id], { $set: { count: 99 } });
        expect(r).toBeDefined();
    });
});

describe("deleteMany", () => {
    it("deletes multiple by ids", async () => {
        const a = await rest.insertOne("items", { title: "d1" });
        const b = await rest.insertOne("items", { title: "d2" });
        const r = await rest.deleteMany("items", [a._id, b._id]);
        expect(r).toBeDefined();
    });
});

describe("aggregate", () => {
    it("returns array from pipeline", async () => {
        await rest.insertOne("items", { title: "agg", count: 5 });
        const docs = await rest.aggregate("items", [{ $match: { title: "agg" } }, { $limit: 1 }]);
        expect(docs.length).toBe(1);
    });
    it("rejects $where", async () => {
        await expect(rest.aggregate("items", [{ $where: "1" }])).rejects.toThrow();
    });
});

// ─── UTILS ───────────────────────────────────────────────────────────

describe("countDocuments", () => {
    it("returns a number", async () => {
        const n = await rest.countDocuments("items", {});
        expect(typeof n).toBe("number");
    });
    it("counts with filter", async () => {
        await rest.insertOne("items", { title: "count-me" });
        const n = await rest.countDocuments("items", { title: "count-me" });
        expect(n).toBeGreaterThanOrEqual(1);
    });
});

describe("bulkWrite", () => {
    it("executes mixed operations", async () => {
        const result = await rest.bulkWrite("items", [
            { insertOne: { document: { title: "bw1" } } },
            { insertOne: { document: { title: "bw2" } } },
        ]);
        expect(result.insertedCount).toBe(2);
    });
});

describe("bulkUpdate", () => {
    it("updates many documents matching filters", async () => {
        await rest.insertOne("items", { title: "bu1", count: 1 });
        await rest.insertOne("items", { title: "bu2", count: 1 });
        const r = await rest.bulkUpdate("items", [
            { updateMany: { filter: { count: 1 }, update: { $set: { count: 100 } } } },
        ]);
        expect(r.modifiedCount).toBeGreaterThanOrEqual(1);
    });
});

describe("stats", () => {
    it("returns collection stats", async () => {
        const s = await rest.stats("items");
        expect(s).toBeDefined();
        expect(typeof s).toBe("object");
    });
});

describe("audit", () => {
    it("adds and retrieves activities", async () => {
        await rest.audit.addActivities([{
            internal: false,
            trace: { id: crypto.randomUUID() },
            request: null,
            meta: {},
            operation: {
                tenant: TEST_TENANT,
                action: "test",
                collection: "items",
                status: "success",
                input: null,
                result: null,
                error: null,
                duration: 0,
                transaction: false,
            },
            ts: new Date(),
        }]);
        const activities = await rest.audit.getActivities({ $limit: 10 });
        expect(Array.isArray(activities)).toBe(true);
        expect(activities.length).toBeGreaterThanOrEqual(1);
    });
});

describe("workflows", () => {
    it("returns workflows array", async () => {
        const w = await rest.workflows({});
        expect(Array.isArray(w)).toBe(true);
    });
});

describe("lock / unlock", () => {
    it("acquires a lock (throws if held)", async () => {
        await rest.unlock("test-lock").catch(() => {});
        await expect(rest.lock("test-lock", 5000)).resolves.toBeUndefined();
    });

    it("fails to acquire same lock twice", async () => {
        await rest.unlock("test-lock-2").catch(() => {});
        await rest.lock("test-lock-2", 10000);
        await expect(rest.lock("test-lock-2", 1000)).rejects.toThrow();
        await rest.unlock("test-lock-2");
    });
});

describe("transactions", () => {
    it("commits a transaction (requires replica set)", async () => {
        try {
            rest.startSession();
            rest.startTransaction();
            await rest.insertOne("items", { title: "tx-commit" });
            await rest.commitTransaction();
            await rest.endSession();
            const docs = await rest.find("items", { $match: { title: "tx-commit" } });
            expect(docs.length).toBe(1);
        } catch (err: any) {
            if (err?.message?.includes("retryable writes") || err?.message?.includes("replica set")) {
                console.warn("Skipping transaction test: MongoDB standalone");
                return;
            }
            throw err;
        }
    });

    it("aborts a transaction (requires replica set)", async () => {
        try {
            rest.startSession();
            rest.startTransaction();
            await rest.insertOne("items", { title: "tx-abort" });
            await rest.abortTransaction();
            await rest.endSession();
            const docs = await rest.find("items", { $match: { title: "tx-abort" } });
            expect(docs.length).toBe(0);
        } catch (err: any) {
            if (err?.message?.includes("retryable writes") || err?.message?.includes("replica set")) {
                console.warn("Skipping transaction test: MongoDB standalone");
                return;
            }
            throw err;
        }
    });
});

describe("watch", () => {
    it("returns a change stream", async () => {
        const stream = await rest.watch("items", [{ $match: { operationType: "insert" } }]);
        expect(stream).toBeDefined();
        await stream.close();
    });
});
