import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { useRest } from "../database/rest";
import { formatConfig, cfg } from "../server/config";
import { syncTenants } from "../database/tenant";
import { syncCollections } from "../database/collection";

/**
 * #45 — filters/pipelines that reach MongoDB through the internal methods are
 * sanitized like `find`: no `$where`/`$expr`/`$function`, bounded `$regex`/`$in`.
 */

const TENANT = "filters-hardening";
const DB = "mongodb://localhost:27017/_FILTERS_HARDENING_TEST";

let rest: InstanceType<typeof useRest>;

beforeAll(async () => {
    formatConfig({
        server: { port: 4000 },
        tenants: [{ id: TENANT, dir: "src", database: { uri: DB } }],
    });
    await syncTenants();
    await syncCollections();
    (cfg as any).collections = [{
        _tenant_: TENANT,
        slug: "items",
        fields: [
            { name: "title", type: "string" },
            { name: "count", type: "number" },
        ],
        api: { access: { "*": true } },
    }];
    rest = new useRest({ internal: false, tenant_id: TENANT });
    try { await rest.db.collection("items").drop(); } catch {}
});

afterAll(async () => {
    try { await rest.db.collection("items").drop(); } catch {}
    try { await rest.db.collection("_locks_").drop(); } catch {}
});

describe("internal methods — safe filters (#45)", () => {
    it("refuses `$where` in findOneAndUpdate / bulkWrite / countDocuments", async () => {
        const calls: Array<[string, () => Promise<any>]> = [
            ["findOneAndUpdate", () => rest.findOneAndUpdate("items", { $where: "true" } as any, { $set: { count: 1 } })],
            ["bulkWrite", () => rest.bulkWrite("items", [{ updateOne: { filter: { $where: "true" }, update: { $set: { count: 1 } } } } as any])],
            ["countDocuments", () => rest.countDocuments("items", { $where: "true" } as any)],
        ];
        for (const [name, call] of calls) {
            const error: any = await call().catch((err) => err);
            expect({ name, code: error?.code }).toEqual({ name, code: "UNAUTHORIZED_MATCH_KEYS" });
        }
    });

    it("still accepts a normal filter", async () => {
        const doc: any = await rest.insertOne("items", { title: "ok", count: 1 });
        const updated: any = await rest.findOneAndUpdate("items", { _id: { $eq: doc._id } } as any, { $set: { count: 2 } });
        expect(updated?.count).toBe(2);
    });
});

describe("aggregate — bounded operators (#45)", () => {
    it("refuses an over-long `$regex`", async () => {
        const error: any = await rest.aggregate("items", [
            { $match: { title: { $regex: "a".repeat(1001) } } },
        ]).catch((err) => err);
        expect(error?.code).toBe("REGEX_TOO_LONG");
    });

    it("refuses an oversized `$in`", async () => {
        const error: any = await rest.aggregate("items", [
            { $match: { title: { $in: Array.from({ length: 10001 }, (_, index) => `v${index}`) } } },
        ]).catch((err) => err);
        expect(error?.code).toBe("ARRAY_OPERATOR_TOO_LARGE");
    });

    it("still accepts a bounded pipeline", async () => {
        const docs = await rest.aggregate("items", [{ $match: { title: { $in: ["ok"] } } }]);
        expect(Array.isArray(docs)).toBe(true);
    });
});
