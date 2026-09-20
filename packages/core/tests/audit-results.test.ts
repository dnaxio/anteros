import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { formatConfig, cfg } from "../server/config";
import { syncTenants } from "../database/tenant";
import { useRest } from "../database/rest";
import { AUDIT_COLLECTION } from "../database/audit";
import { IDS_MAX } from "../lib/auditResult";

const TENANT = "results-test";
const DB = "mongodb://localhost:27017/_AUDIT_RESULTS_TEST";
const SLUG = "orders";

let rest: InstanceType<typeof useRest>;

/** Latest audited entry for an action, written *after* `since` (fire-and-forget logging) */
async function lastActivity(action: string, since?: Date) {
    for (let i = 0; i < 40; i++) {
        const found: any = await rest.db.collection(AUDIT_COLLECTION).findOne(
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
        fields: [
            { name: "ref", type: "string" },
            { name: "total", type: "number" },
        ],
        api: { access: { "*": true } },
    }];

    rest = new useRest({ internal: false, tenant_id: TENANT });
});

afterAll(async () => {
    try { await rest.db.collection(SLUG).drop(); } catch (_) {}
    try { await rest.db.collection(AUDIT_COLLECTION).drop(); } catch (_) {}
    delete (cfg.server as any).audit;
});

describe("audit results — default (`summary`)", () => {
    it("keeps only the generated `_id` for an insert — no document", async () => {
        const since = new Date();
        const doc: any = await rest.insertOne(SLUG, { ref: "TOPSECRET-REF", total: 10 });

        const logged = await lastActivity("insertOne", since);
        expect(logged.operation.result).toEqual({ _id: doc._id });
        // the payload is nowhere in the result
        expect(JSON.stringify(logged.operation.result)).not.toContain("TOPSECRET-REF");
        // …but the input still carries the parameters (that is the audit trail)
        expect(logged.operation.input.data.ref).toBe("TOPSECRET-REF");
    });

    it("keeps `count` + `insertedIds` for a batch insert", async () => {
        const since = new Date();
        const docs: any[] = await rest.insertMany(SLUG, [
            { ref: "B-1", total: 1 },
            { ref: "B-2", total: 2 },
            { ref: "B-3", total: 3 },
        ]);

        const logged = await lastActivity("insertMany", since);
        expect(logged.operation.result.count).toBe(3);
        expect(logged.operation.result.insertedIds).toEqual(docs.map((d) => d._id));
        expect(logged.operation.result.truncated).toBeUndefined();
        // the input of insertMany only holds the count — the ids are the trace
        expect(logged.operation.input).toEqual({ count: 3 });
    });

    it("caps the identifiers of a huge batch", async () => {
        const since = new Date();
        const batch = Array.from({ length: IDS_MAX + 5 }, (_, i) => ({ ref: `big-${i}`, total: i }));
        await rest.insertMany(SLUG, batch);

        const logged = await lastActivity("insertMany", since);
        expect(logged.operation.result.count).toBe(IDS_MAX + 5);
        expect(logged.operation.result.insertedIds.length).toBe(IDS_MAX);
        expect(logged.operation.result.truncated).toBe(true);
    });

    it("keeps the operational counters of updates, deletes and meta operations", async () => {
        const [first] = await rest.find(SLUG, { $limit: 1 });

        let since = new Date();
        const one: any = await rest.updateOne(SLUG, first!._id, { $set: { total: 99 } });
        expect(one.total).toBe(99); // the caller gets the document…
        const updated = await lastActivity("updateOne", since);
        // …but the audit keeps the identifier only (`updateOne` returns a document)
        expect(updated.operation.result).toEqual({ _id: one._id });
        // the parameters are there too
        expect(updated.operation.input.update.$set.total).toBe(99);

        since = new Date();
        const many: any = await rest.updateMany(SLUG, [first!._id], { $set: { total: 100 } });
        expect((await lastActivity("updateMany", since)).operation.result.modifiedCount).toBe(many.modifiedCount);

        since = new Date();
        await rest.countDocuments(SLUG, {});
        expect(typeof (await lastActivity("countDocuments", since)).operation.result).toBe("number");

        since = new Date();
        const removed: any = await rest.deleteOne(SLUG, first!._id);
        expect(removed).not.toBeNull();
        expect((await lastActivity("deleteOne", since)).operation.result).toEqual({ deleted: true });

        // a delete that matched nothing reports nothing
        since = new Date();
        await rest.deleteOne(SLUG, first!._id);
        expect((await lastActivity("deleteOne", since)).operation.result).toBeNull();

        // a document-producing operation never leaks the document — just its id
        const fresh: any = await rest.insertOne(SLUG, { ref: "FOU-1", total: 5 });
        since = new Date();
        const found: any = await rest.findOneAndUpdate(SLUG, { _id: fresh._id }, { $set: { total: 6 } });
        expect(found.total).toBe(6); // the caller gets the document…
        expect((await lastActivity("findOneAndUpdate", since)).operation.result).toEqual({ _id: found._id });
    });

    it("never stores a document, whatever the operation", async () => {
        const entries: any[] = await rest.db.collection(AUDIT_COLLECTION)
            .find({ "operation.collection": SLUG })
            .toArray();

        for (const entry of entries) {
            // a document would carry the collection's own fields
            expect(entry.operation.result?.total).toBeUndefined();
            expect(entry.operation.result?.ref).toBeUndefined();
        }
    });
});

describe("audit results — `none`", () => {
    it("stores no result at all, except the generated identifiers", async () => {
        (cfg.server as any).audit = { results: "none" };

        const since = new Date();
        const doc: any = await rest.insertOne(SLUG, { ref: "N-1", total: 1 });
        expect((await lastActivity("insertOne", since)).operation.result).toEqual({ _id: doc._id });

        let since2 = new Date();
        await rest.updateMany(SLUG, [doc._id], { $set: { total: 2 } });
        expect((await lastActivity("updateMany", since2)).operation.result).toBeNull();

        since2 = new Date();
        await rest.countDocuments(SLUG, {});
        expect((await lastActivity("countDocuments", since2)).operation.result).toBeNull();

        since2 = new Date();
        await rest.deleteOne(SLUG, doc._id);
        expect((await lastActivity("deleteOne", since2)).operation.result).toBeNull();
    });
});

describe("audit results — `full`", () => {
    it("stores the raw result, documents included", async () => {
        (cfg.server as any).audit = { results: "full" };

        const since = new Date();
        const doc: any = await rest.insertOne(SLUG, { ref: "F-1", total: 1 });
        const inserted = await lastActivity("insertOne", since);
        expect(inserted.operation.result.ref).toBe("F-1");

        const since2 = new Date();
        await rest.deleteOne(SLUG, doc._id);
        const deleted = await lastActivity("deleteOne", since2);
        expect(deleted.operation.result.ref).toBe("F-1"); // the deleted document is kept
    });

    it("still never stores a result for reads and custom actions", async () => {
        (cfg.server as any).audit = { results: "full" };

        const since = new Date();
        await rest.find(SLUG, { $limit: 1 });
        expect((await lastActivity("find", since)).operation.result).toBeNull();
    });
});
