import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../server/hono";
import { formatConfig, cfg } from "../server/config";
import { syncTenants } from "../database/tenant";
import { useRest } from "../database/rest";

/**
 * `api.privateFields` on a **collection reached through a join**.
 *
 * `func.omit` walks the whole response, but only with the matchers of the
 * collection that was queried: an `$include`d document carries the *included*
 * collection's fields, so that collection's `privateFields` must be applied too
 * — at the path the join put it, and nowhere else. Same story for a `$lookup`
 * inside an `aggregate` pipeline.
 */

const TENANT = "private-fields";
const DB = "mongodb://localhost:27017/_API_PRIVATE_FIELDS_TEST";

let url = "";
let server: any;
let rest: InstanceType<typeof useRest>;
let internal: InstanceType<typeof useRest>;

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
            slug: "authors",
            fields: [
                { name: "name", type: "string" },
                { name: "password", type: "string" },
                { name: "secret_token", type: "string" },
            ],
            api: { access: { "*": true }, privateFields: ["password", /^secret_/] },
        },
        {
            _tenant_: TENANT,
            slug: "posts",
            fields: [
                { name: "title", type: "string" },
                // A public field that happens to match the *included* collection's
                // matcher — it must survive: only the joined document is masked.
                { name: "secret_note", type: "string" },
                { name: "author", type: "relationship", relation: { to: "authors" } },
                { name: "reviewers", type: "relationship", relation: { to: "authors", hasMany: true } },
            ],
            // The collection being queried declares no private field of its own:
            // only the included one does.
            api: { access: { "*": true } },
        },
    ];

    rest = new useRest({ internal: false, tenant_id: TENANT });
    internal = new useRest({ internal: true, tenant_id: TENANT });

    const app = createApp();
    server = Bun.serve({ port: 0, fetch: app.fetch });
    url = server.url.href.replace(/\/$/, "");
});

afterAll(async () => {
    for (const name of ["authors", "posts", "_locks_", "_audit_"]) {
        try { await rest.db.collection(name).drop(); } catch (_) { /* first run */ }
    }
    server?.stop(true);
});

async function seed() {
    await rest.db.collection("authors").deleteMany({});
    await rest.db.collection("posts").deleteMany({});
    const author = await rest.insertOne("authors", {
        name: "Ada",
        password: "s3cret-hash",
        secret_token: "tok_live_123",
    });
    const post = await rest.insertOne("posts", {
        title: "Hello",
        secret_note: "public-note",
        author: author._id,
        reviewers: [author._id],
    });
    return { author, post };
}

describe("api.privateFields across a join", () => {
    it("masks the included collection's private fields on `find`", async () => {
        const { post } = await seed();

        const res = await call("posts", "find", { params: { $match: { _id: post._id }, $include: ["author"] } });

        expect(res.status).toBe(200);
        const doc = res.body[0];
        expect(doc.author.name).toBe("Ada");
        expect(doc.author.password).toBeUndefined();
        expect(doc.author.secret_token).toBeUndefined();
    });

    it("masks them on `findOne` too", async () => {
        const { post } = await seed();

        const res = await call("posts", "findOne", { id: post._id, params: { $include: ["author"] } });

        expect(res.status).toBe(200);
        expect(res.body.author.name).toBe("Ada");
        expect(res.body.author.password).toBeUndefined();
        expect(res.body.author.secret_token).toBeUndefined();
    });

    it("masks every element of a `hasMany` include", async () => {
        const { post } = await seed();

        const res = await call("posts", "find", { params: { $match: { _id: post._id }, $include: ["reviewers"] } });

        expect(res.status).toBe(200);
        const reviewers = res.body[0].reviewers;
        expect(Array.isArray(reviewers)).toBe(true);
        expect(reviewers[0].name).toBe("Ada");
        expect(reviewers[0].password).toBeUndefined();
        expect(reviewers[0].secret_token).toBeUndefined();
    });

    it("masks them on a `$lookup` of an `aggregate` pipeline", async () => {
        const { post } = await seed();

        const res = await call("posts", "aggregate", {
            pipeline: [
                { $match: { _id: post._id } },
                { $lookup: { from: "authors", localField: "author", foreignField: "_id", as: "author" } },
                { $unwind: "$author" },
            ],
        });

        expect(res.status).toBe(200);
        const doc = res.body[0];
        expect(doc.author.name).toBe("Ada");
        expect(doc.author.password).toBeUndefined();
        expect(doc.author.secret_token).toBeUndefined();
    });

    it("still masks the queried collection's own private fields", async () => {
        await seed();

        const res = await call("authors", "find", {});

        expect(res.status).toBe(200);
        expect(res.body[0].name).toBe("Ada");
        expect(res.body[0].password).toBeUndefined();
        expect(res.body[0].secret_token).toBeUndefined();
    });

    it("masks the join only — the queried collection's own matching field survives", async () => {
        const { post } = await seed();

        const res = await call("posts", "find", { params: { $match: { _id: post._id }, $include: ["author"] } });

        expect(res.status).toBe(200);
        expect(res.body[0].secret_note).toBe("public-note");
    });
});

describe("api.privateFields and the DB query cache", () => {
    it("does not mutate the cached result (an internal read still sees every field)", async () => {
        const { post } = await seed();
        const params = { $match: { _id: post._id }, $include: ["author"] };

        const viaHttp = await call("posts", "find", { params, options: { useCache: true } });
        expect(viaHttp.body[0].author.password).toBeUndefined();

        // Same query, same (warm) cache entry, but through the trusted internal API:
        // the masked fields must still be there — masking is a response concern.
        const viaRest: any = await internal.find("posts", params, { useCache: true });
        expect(viaRest[0].author.password).toBe("s3cret-hash");
        expect(viaRest[0].author.secret_token).toBe("tok_live_123");

        // And the HTTP layer stays consistent on the second, cached response.
        const again = await call("posts", "find", { params, options: { useCache: true } });
        expect(again.body[0].author.name).toBe("Ada");
        expect(again.body[0].author.password).toBeUndefined();
    });
});
