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
        server: { port: 4000 },
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
        const doc: any = await rest.insertOne("items", { title: "ts" });
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

describe("cursors / streaming", () => {
    it("findStream iterates all matching docs (no default limit)", async () => {
        const marker = `stream-${crypto.randomUUID()}`;
        await rest.bulkWrite("items", Array.from({ length: 150 }, (_, i) => ({
            insertOne: { document: { title: marker, count: i } },
        })) as any);

        const docs: any[] = [];
        for await (const doc of rest.findStream("items", { $match: { title: marker } })) {
            docs.push(doc);
        }
        expect(docs.length).toBe(150); // no 100-cap (unlike find())
        expect(docs.every((d) => d.title === marker)).toBe(true);

        await rest.db.collection("items").deleteMany({ title: marker });
    });

    it("aggregateStream yields JSON-converted docs", async () => {
        const marker = `astream-${crypto.randomUUID()}`;
        await rest.insertMany("items", [
            { title: marker, count: 5 },
            { title: marker, count: 7 },
        ]);

        const docs: any[] = [];
        for await (const doc of rest.aggregateStream("items", [{ $match: { title: marker } }])) {
            docs.push(doc);
        }
        expect(docs.length).toBe(2);

        await rest.db.collection("items").deleteMany({ title: marker });
    });

    it("findStream honors the batchSize option", async () => {
        const marker = `bsize-${crypto.randomUUID()}`;
        await rest.bulkWrite("items", Array.from({ length: 50 }, (_, i) => ({
            insertOne: { document: { title: marker, count: i } },
        })) as any);

        const docs: any[] = [];
        for await (const doc of rest.findStream("items", { $match: { title: marker } }, { batchSize: 10 })) {
            docs.push(doc);
        }
        expect(docs.length).toBe(50);
        // JSON-converted (id as string, ISO dates)
        expect(typeof docs[0]!._id).toBe("string");
        expect(docs[0]!.createdAt).toMatch(/\d{4}-\d{2}-\d{2}/);

        await rest.db.collection("items").deleteMany({ title: marker });
    });

    it("cursor options: maxTimeMS + comment + hint", async () => {
        const marker = `copts-${crypto.randomUUID()}`;
        await rest.insertMany("items", [{ title: marker }, { title: marker }]);

        const docs: any[] = [];
        for await (const doc of rest.findStream("items", { $match: { title: marker } }, {
            batchSize: 5,
            maxTimeMS: 30000,
            comment: `test-${marker}`,
            hint: { _id: 1 },
        })) {
            docs.push(doc);
        }
        expect(docs.length).toBe(2);

        await rest.db.collection("items").deleteMany({ title: marker });
    });

    it("findStream withCount yields { count, doc } per document", async () => {
        const marker = `wcount-${crypto.randomUUID()}`;
        await rest.bulkWrite("items", Array.from({ length: 25 }, (_, i) => ({
            insertOne: { document: { title: marker, count: i } },
        })) as any);
        // non-matching doc to prove the count only covers the $match
        await rest.insertOne("items", { title: "other" });

        let iterations = 0;
        for await (const d of rest.findStream("items", { $match: { title: marker } }, { withCount: true })) {
            expect(d.count).toBe(25);
            expect(d.doc.title).toBe(marker);
            iterations++;
        }
        expect(iterations).toBe(25);

        await rest.db.collection("items").deleteMany({ title: { $in: [marker, "other"] } });
    });

    it("findStream pageSize yields { count, docs, hasNext } per page", async () => {
        const marker = `pages-${crypto.randomUUID()}`;
        await rest.bulkWrite("items", Array.from({ length: 25 }, (_, i) => ({
            insertOne: { document: { title: marker, count: i } },
        })) as any);
        await rest.insertOne("items", { title: "other" });

        const pages: any[] = [];
        for await (const page of rest.findStream("items", { $match: { title: marker } }, { pageSize: 10 })) {
            pages.push(page);
            expect(page.count).toBe(25);          // total matching docs, not the page size
            expect(page.docs.length).toBeLessThanOrEqual(10); // pageSize
            expect(page.docs.every((d: any) => d.title === marker)).toBe(true);
        }
        // 25 docs / pageSize 10 → 3 pages: 10 + 10 + 5
        expect(pages.length).toBe(3);
        expect(pages[0]!.docs.length).toBe(10);
        expect(pages[0]!.hasNext()).toBe(true);
        expect(pages[1]!.docs.length).toBe(10);
        expect(pages[1]!.hasNext()).toBe(true);
        expect(pages[2]!.docs.length).toBe(5);
        expect(pages[2]!.hasNext()).toBe(false);
        const total = pages.reduce((acc: number, p: any) => acc + p.docs.length, 0);
        expect(total).toBe(25);

        await rest.db.collection("items").deleteMany({ title: { $in: [marker, "other"] } });
    });

    it("findStream pageSize withCount: false skips the count query", async () => {
        const marker = `nocount-${crypto.randomUUID()}`;
        await rest.bulkWrite("items", Array.from({ length: 12 }, (_, i) => ({
            insertOne: { document: { title: marker, count: i } },
        })) as any);

        const pages: any[] = [];
        for await (const page of rest.findStream("items", { $match: { title: marker } }, { pageSize: 10, withCount: false })) {
            pages.push(page);
            expect("count" in page).toBe(false); // no count field
            expect(page.docs.length).toBeLessThanOrEqual(10);
            expect(typeof page.hasNext).toBe("function");
        }
        expect(pages.length).toBe(2); // 10 + 2
        expect(pages[0]!.hasNext()).toBe(true);
        expect(pages[1]!.hasNext()).toBe(false);

        await rest.db.collection("items").deleteMany({ title: marker });
    });

    it("findStream map transforms each doc on the fly", async () => {
        const marker = `map-${crypto.randomUUID()}`;
        await rest.insertMany("items", [{ title: marker, count: 1 }, { title: marker, count: 2 }]);

        const out: any[] = [];
        for await (const doc of rest.findStream("items", { $match: { title: marker } }, {
            map: (d: any) => ({ id: d._id, n: d.count }),
        })) {
            out.push(doc);
        }
        expect(out.length).toBe(2);
        expect(out.every((m) => "id" in m && "n" in m && !("title" in m))).toBe(true);

        await rest.db.collection("items").deleteMany({ title: marker });
    });

    it("findStream signal aborts the stream and closes the cursor", async () => {
        const marker = `sig-${crypto.randomUUID()}`;
        await rest.bulkWrite("items", Array.from({ length: 20 }, (_, i) => ({
            insertOne: { document: { title: marker, count: i } },
        })) as any);

        const ac = new AbortController();
        let seen = 0;
        for await (const doc of rest.findStream("items", { $match: { title: marker } }, { signal: ac.signal })) {
            seen++;
            if (seen === 3) ac.abort();
        }
        expect(seen).toBe(3); // stopped early, cursor closed by the generator

        await rest.db.collection("items").deleteMany({ title: marker });
    });

    it("findStream pageSize map + signal", async () => {
        const marker = `psig-${crypto.randomUUID()}`;
        await rest.bulkWrite("items", Array.from({ length: 30 }, (_, i) => ({
            insertOne: { document: { title: marker, count: i } },
        })) as any);

        const ac = new AbortController();
        let pages = 0;
        for await (const page of rest.findStream("items", { $match: { title: marker } }, {
            pageSize: 10,
            map: (d: any) => ({ id: d._id }),
            signal: ac.signal,
        })) {
            pages++;
            expect(page.docs.every((d: any) => "id" in d && !("title" in d))).toBe(true);
            if (pages === 2) ac.abort();
        }
        expect(pages).toBe(2); // stopped after 2 pages

        await rest.db.collection("items").deleteMany({ title: marker });
    });

    it("aggregateStream withCount counts the pipeline output", async () => {
        const marker = `acount-${crypto.randomUUID()}`;
        await rest.insertMany("items", [
            { title: marker, count: 1 },
            { title: marker, count: 2 },
            { title: marker, count: 3 },
        ]);

        const out: any[] = [];
        for await (const d of rest.aggregateStream("items", [{ $match: { title: marker } }], { withCount: true })) {
            expect(d.count).toBe(3);
            out.push(d.doc);
        }
        expect(out.length).toBe(3);

        await rest.db.collection("items").deleteMany({ title: marker });
    });
});

describe("$limit", () => {
    it("$limit: 0 means no limit (returns all matching docs)", async () => {
        const marker = `limit-zero-${crypto.randomUUID()}`;
        await rest.bulkWrite("items", Array.from({ length: 101 }, (_, i) => ({
            insertOne: { document: { title: marker, count: i } },
        })) as any);

        const all = await rest.find("items", { $match: { title: marker }, $limit: 0 });
        expect(all.length).toBe(101); // the old 100 cap would have returned 100

        await rest.db.collection("items").deleteMany({ title: marker });
    });

    it("accepts $limit above 1000", async () => {
        const marker = `limit-big-${crypto.randomUUID()}`;
        await rest.insertMany("items", [
            { title: marker, count: 1 },
            { title: marker, count: 2 },
            { title: marker, count: 3 },
        ]);

        const docs = await rest.find("items", { $match: { title: marker }, $limit: 5000 });
        expect(docs.length).toBe(3);

        await rest.db.collection("items").deleteMany({ title: marker });
    });

    it("defaults to $limit 100", async () => {
        const marker = `limit-default-${crypto.randomUUID()}`;
        await rest.bulkWrite("items", Array.from({ length: 120 }, (_, i) => ({
            insertOne: { document: { title: marker, count: i } },
        })) as any);

        const docs = await rest.find("items", { $match: { title: marker } });
        expect(docs.length).toBe(100);

        await rest.db.collection("items").deleteMany({ title: marker });
    });

    it("rejects negative $limit with INVALID_LIMIT", async () => {
        const err: any = await rest.find("items", { $limit: -1 }).then(() => null, (e) => e);
        expect(err?.code).toBe("INVALID_LIMIT");
    });

    it("rejects non-integer $limit with INVALID_LIMIT", async () => {
        const err: any = await rest.find("items", { $limit: 1.5 }).then(() => null, (e) => e);
        expect(err?.code).toBe("INVALID_LIMIT");
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
        const doc: any = await rest.insertOne("items", { title: "old" });
        const upd: any = await rest.updateOne("items", doc._id, { $set: { title: "new" } });
        expect(upd.title).toBe("new");
        expect(upd.updatedAt).not.toBe(doc.updatedAt);
    });
});

describe("deleteOne", () => {
    it("deletes and returns _id", async () => {
        const doc: any = await rest.insertOne("items", { title: "del-me" });
        const deleted: any = await rest.deleteOne("items", doc._id);
        expect(deleted?._id).toBe(doc._id);
    });
});

describe("insertMany", () => {
    it("inserts and returns array with _id", async () => {
        const docs: any[] = await rest.insertMany("items", [{ title: "m1" }, { title: "m2" }]);
        expect(docs.length).toBe(2);
        expect(docs[0]!._id).toBeString();
        expect(docs[1]!._id).toBeString();
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
        const marker = `count-me-${crypto.randomUUID()}`;
        await rest.insertOne("items", { title: marker });
        await rest.insertOne("items", { title: "count-other" });
        const n = await rest.countDocuments("items", { title: marker });
        expect(n).toBe(1); // only the matching doc — not the whole collection

        await rest.db.collection("items").deleteMany({ title: marker });
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
        const s: any = await rest.stats();
        expect(s).toBeDefined();
        expect(typeof s).toBe("object");
    });
});

describe("audit", () => {
    it("adds and retrieves activities", async () => {
        await rest.audit.addActivities([{
            internal: false,
            trace: { id: crypto.randomUUID() },
            request: undefined,
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
        const activities = await rest.audit.getActivities({ $match: {}, $limit: 10 });
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
        const stream = await rest.watch("items", [{ $match: { operationType: "insert" } }], {} as any);
        expect(stream).toBeDefined();
        await stream.close();
    });
});
