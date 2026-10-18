import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../server/hono";
import { formatConfig, cfg } from "../server/config";
import { syncTenants } from "../database/tenant";
import { useRest } from "../database/rest";

/**
 * External-API guards (issues #32 and #33) — and their **external-only** scope:
 * the in-process `rest` keeps the full surface (replacement documents, computed
 * aggregation fields), while a client of `/api/...` cannot use them to bypass
 * validation or to read a `privateFields` value under another name.
 */

const TENANT = "api-guards";
const DB = "mongodb://localhost:27017/_API_GUARDS_TEST";

let rest: InstanceType<typeof useRest>;
let internal: InstanceType<typeof useRest>;
let server: any;
let url = "";
let personId = "";

async function call(collection: string, action: string, body?: any) {
    const res = await fetch(`${url}/api/${TENANT}/collections/${collection}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
    formatConfig({
        server: { port: 4000 },
        tenants: [{ id: TENANT, dir: "src", database: { uri: DB } }],
    });
    await syncTenants();

    (cfg as any).collections = [
        {
            _tenant_: TENANT,
            slug: "people",
            fields: [
                { name: "name", type: "string", required: true },
                { name: "password", type: "string" },
                { name: "secret_token", type: "string" },
                { name: "nickname", type: "string" },
                { name: "role", type: "string" },
            ],
            api: { access: { "*": true }, privateFields: ["password", /^secret_/], readOnlyFields: ["role"] },
        },
        {
            _tenant_: TENANT,
            slug: "notes",
            fields: [
                { name: "title", type: "string" },
                { name: "owner", type: "relationship", relation: { to: "people" } },
                { name: "secretRef", type: "relationship", relation: { to: "secrets" } },
            ],
            api: { access: { "*": true } },
        },
        {
            _tenant_: TENANT,
            slug: "secrets",
            fields: [{ name: "code", type: "string" }],
            api: { access: { find: false } },
        },
    ];

    rest = new useRest({ internal: false, tenant_id: TENANT });
    internal = new useRest({ internal: true, tenant_id: TENANT });

    const app = createApp();
    server = Bun.serve({ port: 0, fetch: app.fetch });
    url = server.url.href.replace(/\/$/, "");

    for (const name of ["people", "notes", "secrets", "_locks_", "_audit_"]) {
        try { await rest.db.collection(name).drop(); } catch {}
    }
    const person: any = await rest.insertOne("people", {
        name: "Ada",
        password: "hash-ada",
        secret_token: "tok-ada",
    });
    personId = person._id;
    const secret: any = await rest.insertOne("secrets", { code: "s3cret" });
    await rest.insertOne("notes", { title: "n1", owner: personId, secretRef: secret._id });
});

afterAll(async () => {
    for (const name of ["people", "notes", "_locks_", "_audit_"]) {
        try { await rest.db.collection(name).drop(); } catch {}
    }
    try { server.stop(true); } catch {}
});

describe("external mutations — operator documents only (#32)", () => {
    it("refuses an empty update, a replacement document and an array", async () => {
        const cases = [{ update: {} }, { update: { name: "Replaced" } }, { update: [] }];
        for (const body of cases) {
            const res = await call("people", "updateOne", { id: personId, ...body });
            expect({ body, status: res.status, code: res.body.code })
                .toEqual({ body, status: 400, code: "INVALID_UPDATE" });
        }
    });

    it("still accepts an operator update", async () => {
        const res = await call("people", "updateOne", { id: personId, update: { $set: { name: "Ada 2" } } });
        expect(res.status).toBe(200);
        expect((await rest.findOne("people", personId))?.name).toBe("Ada 2");
    });

    it("applies the same rule to updateMany", async () => {
        const bad = await call("people", "updateMany", { ids: [personId], update: { name: "x" } });
        expect(bad.status).toBe(400);
        expect(bad.body.code).toBe("INVALID_UPDATE");
    });

    it("refuses `$rename` and unsetting a required field", async () => {
        const rename = await call("people", "updateOne", { id: personId, update: { $rename: { nickname: "password" } } });
        expect(rename.status).toBe(400);
        expect(rename.body.code).toBe("INVALID_UPDATE");

        const unset = await call("people", "updateOne", { id: personId, update: { $unset: { name: "" } } });
        expect(unset.status).toBe(400);
        expect(unset.body.code).toBe("INVALID_UPDATE");
    });

    it("leaves the in-process `rest` unchanged (internal callers keep `$rename` etc.)", async () => {
        const doc: any = await rest.insertOne("people", { name: "Bob", password: "hash-bob", nickname: "bobby" });
        await internal.updateOne("people", doc._id, { $rename: { nickname: "name" } } as any);
        expect((await rest.findOne("people", doc._id))?.name).toBe("bobby");
    });
});

describe("external reads — private fields cannot be aliased (#33)", () => {
    it("refuses a reference to a private field in an expression", async () => {
        const pipelines = [
            [{ $addFields: { leak: "$password" } }],
            [{ $project: { leak: { $concat: ["$password"] } } }],
            [{ $group: { _id: "$password" } }],
            [{ $replaceRoot: { newRoot: { leak: "$password" } } }],
            [{ $addFields: { leak: "$$ROOT.password" } }],
        ];
        for (const pipeline of pipelines) {
            const res = await call("people", "aggregate", { pipeline });
            expect({ pipeline, status: res.status, code: res.body.code })
                .toEqual({ pipeline, status: 400, code: "PRIVATE_FIELD_REFERENCE" });
        }
    });

    it("refuses operators that move a field without a `$path`", async () => {
        const res = await call("people", "aggregate", { pipeline: [{ $addFields: { leak: { $getField: "password" } } }] });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("PRIVATE_FIELD_REFERENCE");
    });

    it("refuses a joined private field under an alias", async () => {
        const res = await call("notes", "aggregate", {
            pipeline: [
                { $lookup: { from: "people", as: "p" } },
                { $addFields: { leak: "$p.secret_token" } },
            ],
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("PRIVATE_FIELD_REFERENCE");
    });

    it("still allows an aggregate that does not touch a private field", async () => {
        const res = await call("people", "aggregate", {
            pipeline: [{ $group: { _id: "$name", n: { $sum: 1 } } }],
        });
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it("still masks a directly-projected private field", async () => {
        const res = await call("people", "find", { params: { $project: { name: 1, password: 1, secret_token: 1 } } });
        expect(res.status).toBe(200);
        for (const doc of res.body) {
            expect(doc.password).toBeUndefined();
            expect(doc.secret_token).toBeUndefined();
        }
    });

    it("leaves the in-process `rest` unchanged (internal aggregates may compute)", async () => {
        const docs: any[] = await internal.aggregate("people", [
            { $match: { name: { $in: ["Ada 2", "Ada", "Bobby"] } } },
            { $addFields: { leak: "$password" } },
        ]);
        expect(docs.length).toBeGreaterThan(0);
        expect(docs[0].leak).toBeString();
    });
});

describe("external reads — joins honour the target access rule (#36)", () => {
    it("refuses a lookup on a collection the caller cannot read", async () => {
        const res = await call("notes", "aggregate", {
            pipeline: [{ $lookup: { from: "secrets", as: "s" } }],
        });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe("ACCESS_DENIED");
    });

    it("refuses a lookup on an internal collection", async () => {
        const res = await call("notes", "aggregate", {
            pipeline: [{ $lookup: { from: "_audit_", as: "a" } }],
        });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("LOOKUP_TARGET_FORBIDDEN");
    });

    it("refuses an $include on a related collection the caller cannot read", async () => {
        const res = await call("notes", "find", { params: { $include: ["secretRef"] } });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe("ACCESS_DENIED");
    });

    it("still allows a join on a readable collection", async () => {
        const res = await call("notes", "aggregate", {
            pipeline: [{ $lookup: { from: "people", localField: "owner", foreignField: "_id", as: "p" } }],
        });
        expect(res.status).toBe(200);
    });

    it("leaves the in-process `rest` unchanged (internal lookups still work)", async () => {
        const docs: any[] = await internal.aggregate("notes", [
            { $lookup: { from: "secrets", localField: "secretRef", foreignField: "_id", as: "s" } },
        ]);
        expect(docs.length).toBeGreaterThan(0);
        expect(Array.isArray(docs[0].s)).toBe(true);
    });
});

describe("external API — body shape and generic errors (#21, #24, #47)", () => {
    it("returns a generic not-found message (no tenant/collection echo)", async () => {
        const res = await call("does-not-exist", "find", { params: {} });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("COLLECTION_NOT_FOUND");
        expect(res.body.message).toBe("Resource not found");
        expect(res.body.message).not.toContain("does-not-exist");
    });

    it("refuses malformed insert/update/delete bodies", async () => {
        const cases: Array<[string, any, string]> = [
            ["insertOne", {}, "INVALID_BODY"],
            ["insertOne", { data: "not-an-object" }, "INVALID_BODY"],
            ["insertMany", { data: { name: "x" } }, "INVALID_BODY"],
            ["findOne", { id: { $ne: null } }, "INVALID_ID"],
            ["updateOne", { id: { $ne: null }, update: { $set: { name: "x" } } }, "INVALID_ID"],
            ["deleteOne", { id: { $ne: null } }, "INVALID_ID"],
            ["updateMany", { ids: "not-an-array", update: { $set: { name: "x" } } }, "INVALID_BODY"],
            ["deleteMany", { ids: [{}] }, "INVALID_BODY"],
        ];

        for (const [action, body, code] of cases) {
            const res = await call("people", action, body);
            expect({ action, status: res.status, code: res.body.code })
                .toEqual({ action, status: 400, code });
        }
    });

    it("still accepts a well-formed insert", async () => {
        const res = await call("people", "insertOne", { data: { name: "Cara" } });
        expect(res.status).toBe(200);
    });
});

describe("in-process `rest` — `$rename` cannot target a read-only field (#43)", () => {
    it("refuses a rename to a read-only field, allows a normal one", async () => {
        const doc: any = await rest.insertOne("people", { name: "Ren", nickname: "ren" });

        await expect(internal.updateOne("people", doc._id, { $rename: { nickname: "role" } } as any))
            .rejects.toMatchObject({ code: "READONLY_FIELD" });

        await internal.updateOne("people", doc._id, { $rename: { nickname: "name" } } as any);
        expect((await rest.findOne("people", doc._id))?.name).toBe("ren");
    });
});
