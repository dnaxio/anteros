import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { useRest } from "../database/rest";
import { formatConfig, cfg } from "../server/config";
import { syncTenants, getTenant } from "../database/tenant";
import {
    AUDIT_COLLECTION,
    LEGACY_AUDIT_COLLECTION,
    AUDIT_TTL_INDEX,
    migrateAuditCollection,
    syncAuditRetention,
} from "../database/audit";

const TEST_TENANT = "audit";
const TEST_DB = "mongodb://localhost:27017/_AUDIT_TEST";

// Second tenant: proves `tenant.audit.retention` is wired end-to-end
const TTL_TENANT = "audit-ttl";
const TTL_DB = "mongodb://localhost:27017/_AUDIT_TTL_TEST";

let rest: InstanceType<typeof useRest>;

/**
 * Latest audit entry for a (collection, action) pair.
 *
 * `#logActivity` is fire-and-forget, so we poll — and when the same pair was
 * already logged by an earlier test, `since` (captured *before* the operation)
 * makes sure we wait for the new entry instead of reading the stale one.
 */
async function lastActivity(collection: string, action: string, since?: Date) {
    for (let i = 0; i < 40; i++) {
        const found: any = await rest.db.collection(AUDIT_COLLECTION).findOne(
            {
                "operation.collection": collection,
                "operation.action": action,
                ...(since ? { ts: { $gte: since } } : {}),
            },
            { sort: { ts: -1 } },
        );
        if (found) return found;
        await Bun.sleep(25);
    }
    return null;
}

/** Minimal activity document (same shape as `ActivityInput`). */
function activity(action: string) {
    return {
        internal: true,
        trace: { id: crypto.randomUUID() },
        meta: {},
        operation: {
            tenant: TEST_TENANT,
            action,
            collection: "items",
            status: "success",
            input: null,
            result: null,
            error: null,
            duration: 0,
            transaction: false,
        },
        ts: new Date(),
    } as any;
}

/** Index document, or undefined when absent. */
async function index(name: string): Promise<any> {
    return (await rest.db.collection(AUDIT_COLLECTION).listIndexes().toArray())
        .find((i: any) => i.name === name);
}

beforeAll(async () => {
    formatConfig({
        server: { port: 4000 },
        tenants: [
            { id: TEST_TENANT, dir: "src", database: { uri: TEST_DB } },
            { id: TTL_TENANT, dir: "src", database: { uri: TTL_DB }, audit: { retention: "7d" } },
        ],
    });
    await syncTenants();

    // Declared collections — needed to exercise the `$lookup` allow-list and `collectionType`
    (cfg as any).collections = [
        {
            _tenant_: TEST_TENANT,
            slug: "items",
            fields: [{ name: "title", type: "string" }],
            api: { access: { "*": true } },
        },
    ];
    (cfg as any).fileCollections = [
        {
            _tenant_: TEST_TENANT,
            _isFileCollection_: true,
            slug: "photos",
            fields: [{ name: "label", type: "string" }],
            api: { access: { "*": true } },
        },
    ];

    rest = new useRest({ internal: true, tenant_id: TEST_TENANT });
});

afterAll(async () => {
    try { await rest.db.collection("items").drop(); } catch (_) {}
    try { await rest.db.collection("photos").drop(); } catch (_) {}
    try { await rest.db.collection(AUDIT_COLLECTION).drop(); } catch (_) {}
    try { await rest.db.collection(LEGACY_AUDIT_COLLECTION).drop(); } catch (_) {}
    try { await getTenant(TTL_TENANT)?.database?.db?.collection(AUDIT_COLLECTION).drop(); } catch (_) {}
});

describe("audit collection", () => {
    it("writes to `_audit_`", async () => {
        await rest.audit.addActivities([activity("unit")]);

        const stored: any = await rest.db.collection(AUDIT_COLLECTION)
            .findOne({ "operation.action": "unit" });
        expect(stored).toBeDefined();
        expect(stored.operation.collection).toBe("items");
    });

    it("reads back through getActivities", async () => {
        const logs = await rest.audit.getActivities({
            $match: { "operation.action": "unit" },
            $limit: 10,
        } as any);
        expect(logs.length).toBeGreaterThanOrEqual(1);
    });

    it("does not use the legacy `_activities_` name anymore", async () => {
        const legacy = await rest.db.listCollections({ name: LEGACY_AUDIT_COLLECTION }).toArray();
        expect(legacy.length).toBe(0);
    });

    it("is on disk as soon as a mutation resolves (no polling needed)", async () => {
        const doc: any = await rest.insertOne("items", { title: "awaited" });

        // Deliberately **no** polling: mutations await their audit entry, so it is
        // already there — a successful write can never lose its trace.
        const logged: any = await rest.db.collection(AUDIT_COLLECTION).findOne({
            "operation.action": "insertOne",
            "operation.result._id": doc._id,
        });
        expect(logged).not.toBeNull();
        expect(logged.operation.status).toBe("success");
    });

    it("accepts `_audit_` as a $lookup target from a declared collection", async () => {
        const rows = await rest.aggregate("items", [
            { $lookup: { from: AUDIT_COLLECTION, localField: "_id", foreignField: "_id", as: "audit" } },
            { $limit: 1 },
        ]);
        expect(Array.isArray(rows)).toBe(true);
    });
});

describe("audit collectionType", () => {
    it("labels a document collection as `document`", async () => {
        await rest.insertOne("items", { title: "collectionType" });

        const logged = await lastActivity("items", "insertOne");
        expect(logged).not.toBeNull();
        expect(logged.operation.collectionType).toBe("document");
    });

    it("labels a file collection as `file`", async () => {
        await rest.insertOne("photos", { label: "ct", _file: { filename: "ct.png" } });

        const logged = await lastActivity("photos", "insertOne");
        expect(logged).not.toBeNull();
        expect(logged.operation.collectionType).toBe("file");
    });

    it("leaves `collectionType` undefined for an internal collection", async () => {
        // `_audit_` is not declared anywhere — no type to report
        const logged: any = await rest.db.collection(AUDIT_COLLECTION)
            .findOne({ "operation.collection": "_locks_" });
        expect(logged?.operation?.collectionType).toBeUndefined();
    });
});

describe("audit read operations", () => {
    it("logs `find` with its parameters, never the result", async () => {
        const since = new Date();
        const docs = await rest.find("items", { $match: { title: "collectionType" }, $limit: 5 });
        expect(docs.length).toBeGreaterThanOrEqual(1); // the read really returned data

        const logged = await lastActivity("items", "find", since);
        expect(logged).not.toBeNull();
        expect(logged.operation.input.params).toEqual({ $match: { title: "collectionType" }, $limit: 5 });
        expect(logged.operation.result).toBeNull();          // ← nothing returned is stored
        expect(logged.operation.status).toBe("success");
    });

    it("logs `findOne` with the id", async () => {
        const since = new Date();
        const [first] = await rest.find("items", { $limit: 1 });
        const doc: any = await rest.findOne("items", first!._id);
        expect(doc).not.toBeNull();

        const logged = await lastActivity("items", "findOne", since);
        expect(logged.operation.input.id).toBeString();
        expect(logged.operation.result).toBeNull();
    });

    it("logs `aggregate` with its pipeline", async () => {
        const since = new Date();
        const pipeline = [{ $match: { title: "collectionType" } }, { $limit: 1 }];
        const rows = await rest.aggregate("items", pipeline);
        expect(rows.length).toBeGreaterThanOrEqual(1);

        const logged = await lastActivity("items", "aggregate", since);
        expect(logged.operation.input.pipeline).toEqual(pipeline);
        expect(logged.operation.result).toBeNull();
    });

    it("logs a failed read with its error and still no result", async () => {
        const since = new Date();
        await expect(rest.aggregate("items", [
            { $lookup: { from: "not_declared", localField: "_id", foreignField: "_id", as: "x" } },
        ])).rejects.toThrow();

        const logged = await lastActivity("items", "aggregate", since);
        expect(logged.operation.status).toBe("error");
        expect(logged.operation.error.message).toBeString();
        expect(logged.operation.result).toBeNull();
    });
});

describe("audit query indexes", () => {
    it("are ensured at boot", async () => {
        const names = (await rest.db.collection(AUDIT_COLLECTION).listIndexes().toArray())
            .map((i: any) => i.name);
        expect(names).toContain("_audit_ts_");
        expect(names).toContain("_audit_collection_ts_");
        expect(names).toContain("_audit_status_ts_");
        expect(names).toContain("_audit_trace_");
    });

    it("serve the documented sorts and filters", async () => {
        expect((await index("_audit_ts_")).key).toEqual({ ts: -1 });
        expect((await index("_audit_collection_ts_")).key).toEqual({ "operation.collection": 1, ts: -1 });
        expect((await index("_audit_status_ts_")).key).toEqual({ "operation.status": 1, ts: -1 });
        expect((await index("_audit_trace_")).key).toEqual({ "trace.id": 1 });
    });
});

describe("audit retention (TTL)", () => {
    it("stays untouched — no TTL index — when retention is not configured", async () => {
        expect(await syncAuditRetention(rest.db, undefined)).toBe("skipped");
        expect(await index(AUDIT_TTL_INDEX)).toBeUndefined();
    });

    it("creates a TTL index when a duration is configured", async () => {
        expect(await syncAuditRetention(rest.db, "90d")).toBe("applied");

        const ttl = await index(AUDIT_TTL_INDEX);
        expect(ttl.key).toEqual({ ts: 1 });
        expect(ttl.expireAfterSeconds).toBe(90 * 86400);
    });

    it("is idempotent — the same duration is a no-op", async () => {
        expect(await syncAuditRetention(rest.db, "90d")).toBe("unchanged");
    });

    it("updates expireAfterSeconds when the duration changes", async () => {
        expect(await syncAuditRetention(rest.db, "24h")).toBe("applied");
        expect((await index(AUDIT_TTL_INDEX)).expireAfterSeconds).toBe(24 * 3600);
    });

    it("drops the TTL index when retention is explicitly disabled", async () => {
        expect(await syncAuditRetention(rest.db, false)).toBe("dropped");
        expect(await index(AUDIT_TTL_INDEX)).toBeUndefined();
    });

    it("ignores an invalid duration", async () => {
        expect(await syncAuditRetention(rest.db, "banana")).toBe("skipped");
        expect(await index(AUDIT_TTL_INDEX)).toBeUndefined();
    });

    it("is wired through `tenant.audit.retention`", async () => {
        const db = getTenant(TTL_TENANT)!.database!.db!;
        const ttl: any = (await db.collection(AUDIT_COLLECTION).listIndexes().toArray())
            .find((i: any) => i.name === AUDIT_TTL_INDEX);

        expect(ttl).toBeDefined();
        expect(ttl.expireAfterSeconds).toBe(7 * 86400);
    });
});

describe("audit collection migration (`_activities_` → `_audit_`)", () => {
    it("renames an existing legacy collection, without losing documents", async () => {
        await rest.db.collection(AUDIT_COLLECTION).drop().catch(() => {});
        await rest.db.collection(LEGACY_AUDIT_COLLECTION).insertOne(activity("legacy") as any);

        expect(await migrateAuditCollection(rest.db)).toBe(true);

        const legacy = await rest.db.listCollections({ name: LEGACY_AUDIT_COLLECTION }).toArray();
        expect(legacy.length).toBe(0);

        const moved: any = await rest.db.collection(AUDIT_COLLECTION)
            .findOne({ "operation.action": "legacy" });
        expect(moved).toBeDefined();
    });

    it("is idempotent — a second run is a no-op", async () => {
        expect(await migrateAuditCollection(rest.db)).toBe(false);
    });

    it("never touches the legacy collection when `_audit_` already exists", async () => {
        await rest.db.collection(AUDIT_COLLECTION).insertOne(activity("keep") as any);
        await rest.db.collection(LEGACY_AUDIT_COLLECTION).insertOne(activity("orphan") as any);

        expect(await migrateAuditCollection(rest.db)).toBe(false);

        // neither merged nor dropped — both collections survive untouched
        expect(await rest.db.collection(AUDIT_COLLECTION).countDocuments({ "operation.action": "orphan" })).toBe(0);
        expect(await rest.db.collection(LEGACY_AUDIT_COLLECTION).countDocuments({})).toBe(1);
    });
});
