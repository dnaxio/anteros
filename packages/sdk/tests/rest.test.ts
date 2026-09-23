import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Anteros, Rest } from "../index";

/**
 * The client surfaces — `Anteros` (one namespace per family, mirroring the server
 * URLs) and `Rest` (the original flat surface, unchanged).
 *
 * Tested against a fake server recording what each call actually sent, so the
 * *shape of the request* is the contract under test, not the server.
 */

type Hit = { path: string; method: string; body: any; form: any; headers: Record<string, string> };

let hits: Hit[] = [];
let server: any;
let base = "";

function api(tenant = "v1", options: Record<string, any> = {}) {
    return new Anteros({ server: base, tenant, ...options });
}

/** The original client — same transport, flat surface. */
function legacy(tenant = "v1", options: Record<string, any> = {}) {
    return new Rest({ server: base, tenant, ...options });
}

beforeAll(() => {
    server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: async (req) => {
            const url = new URL(req.url);
            const contentType = req.headers.get("content-type") ?? "";
            const hit: Hit = {
                path: url.pathname,
                method: req.method,
                body: null,
                form: null,
                headers: Object.fromEntries(req.headers.entries()),
            };

            if (contentType.includes("application/json")) hit.body = await req.json().catch(() => null);
            if (contentType.includes("multipart/form-data")) hit.form = await req.formData().catch(() => null);
            hits.push(hit);

            if (url.pathname.includes("/collections/missing/")) {
                return Response.json({ message: "Collection not found", code: "COLLECTION_NOT_FOUND", meta: { slug: "missing" } }, { status: 404 });
            }
            if (url.pathname.includes("/login")) {
                return Response.json({ token: "jwt-token", data: { _id: "u1", email: "ada@example.com" } });
            }
            if (url.pathname.includes("/upload/")) {
                const count = [...(hit.form?.getAll("file") ?? [])].length;
                const one = { _id: "f1", _file: { filename: "f1.png", name: "a.png", mimetype: "image/png", size: 3, url: "/api/v1/files/photos/f1.png" } };
                return Response.json(count > 1 ? [one, { ...one, _id: "f2" }] : one);
            }
            if (req.method === "DELETE") return Response.json({ message: "File deleted", ok: true });

            return Response.json({ ok: true });
        },
    });
    base = server.url.href.replace(/\/$/, "");
});

afterAll(() => {
    try { server.stop(true); } catch (_) { /* already stopped */ }
});

beforeEach(() => {
    hits = [];
});

describe("sdk — one namespace per family", () => {
    it("mirrors the server URL families", async () => {
        const client = api();

        await client.collection("orders").find({});
        await client.service("billing").run("charge", { amount: 7 });
        await client.vars.get("config", "licence");
        await client.agent("support").info();
        await client.files.url("photos", "f1.png");

        expect(hits.map((hit) => hit.path)).toEqual([
            "/api/v1/collections/orders/find",
            "/api/v1/services/billing/charge",
            "/api/v1/vars/get",
            "/api/v1/agents/support/info",
        ]);
    });

    it("keeps the instance-wide bits off the families", async () => {
        const config = await api().getConfig();
        expect(config as any).toEqual({ ok: true });
        expect(hits[0]!.path).toBe("/_dnax/config/v1");
    });

    it("follows a tenant change", async () => {
        const client = api("v1");
        client.setTenant("v2");
        await client.collection("orders").find({});
        expect(hits[0]!.path).toBe("/api/v2/collections/orders/find");
    });
});

describe("sdk — api.collection(slug)", () => {
    it("states the slug once and keeps the argument order unambiguous", async () => {
        const orders = api().collection<{ ref: string }>("orders");

        await orders.find({ $match: { status: "paid" }, $limit: 2 });
        await orders.findOne("64f1", { $include: ["customer"] });
        await orders.insertOne({ ref: "A-1" });
        await orders.insertMany([{ ref: "A-2" }, { ref: "A-3" }]);
        await orders.updateOne("64f1", { $set: { status: "shipped" } });
        await orders.updateMany(["64f1", "64f2"], { $set: { active: true } });
        await orders.deleteOne("64f1");
        await orders.deleteMany(["64f1", "64f2"]);
        await orders.aggregate([{ $group: { _id: "$status" } }]);
        await orders.runAction("refund", { reason: "damaged" });

        expect(hits.map((hit) => hit.path)).toEqual([
            "/api/v1/collections/orders/find",
            "/api/v1/collections/orders/findOne",
            "/api/v1/collections/orders/insertOne",
            "/api/v1/collections/orders/insertMany",
            "/api/v1/collections/orders/updateOne",
            "/api/v1/collections/orders/updateMany",
            "/api/v1/collections/orders/deleteOne",
            "/api/v1/collections/orders/deleteMany",
            "/api/v1/collections/orders/aggregate",
            "/api/v1/collections/orders/refund",
        ]);

        expect(hits[0]!.body).toEqual({ params: { $match: { status: "paid" }, $limit: 2 } });
        expect(hits[1]!.body).toEqual({ id: "64f1", params: { $include: ["customer"] } });
        expect(hits[2]!.body).toEqual({ data: { ref: "A-1" } });
        expect(hits[4]!.body).toEqual({ id: "64f1", update: { $set: { status: "shipped" } } });
        expect(hits[5]!.body).toEqual({ ids: ["64f1", "64f2"], update: { $set: { active: true } } });
        expect(hits[7]!.body).toEqual({ ids: ["64f1", "64f2"] });
        expect(hits[9]!.body).toEqual({ data: { reason: "damaged" } });
    });

    it("exposes the slug it is bound to", () => {
        expect(api().collection("orders").getSlug()).toBe("orders");
    });

    it("asks for the server-side query cache through `useCache`", async () => {
        await api().collection("orders").find({ $match: {} }, { useCache: true });
        expect(hits[0]!.body).toEqual({ params: { $match: {} }, options: { useCache: true } });
    });

    it("merges `defaultParams` under the call's own params", async () => {
        const client = api("v1", { defaultParams: { find: { $limit: 25 }, insertOne: { source: "import" } } });

        await client.collection("orders").find({ $match: { a: 1 } });
        expect(hits[0]!.body).toEqual({ params: { $limit: 25, $match: { a: 1 } } });

        await client.collection("orders").find({ $limit: 5 });
        expect(hits[1]!.body).toEqual({ params: { $limit: 5 } });

        await client.collection("orders").insertOne({ ref: "A-1" });
        expect(hits[2]!.body).toEqual({ data: { ref: "A-1" }, source: "import" });
    });

    it("logs in on the collection and carries the token afterwards", async () => {
        const users = api().collection("users");

        const { token, data } = await users.login({ email: "ada@example.com", password: "secret" });
        expect(token).toBe("jwt-token");
        expect(data.email).toBe("ada@example.com");
        expect(hits[0]!.path).toBe("/api/v1/collections/users/login");
        expect(hits[0]!.body).toEqual({ payload: { email: "ada@example.com", password: "secret" } });
        expect(hits[0]!.headers.authorization).toBeUndefined();

        await users.find({});
        expect(hits[1]!.headers.authorization).toBe("Bearer jwt-token");

        await users.logout();
        expect(hits[2]!.path).toBe("/api/v1/collections/users/logout");

        await users.find({});
        expect(hits[3]!.headers.authorization).toBeUndefined();
    });

    it("throws the server error with its code, status and meta", async () => {
        const error: any = await api().collection("missing").find({}).catch((err) => err);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe("Collection not found");
        expect(error.code).toBe("COLLECTION_NOT_FOUND");
        expect(error.status).toBe(404);
        expect(error.meta).toEqual({ slug: "missing" });
    });

    it("cleans the body when asked", async () => {
        await api().collection("orders").insertOne(
            { ref: "A-1", note: null, tags: [], meta: {} },
            { cleanDeep: true },
        );
        expect(hits[0]!.body).toEqual({ data: { ref: "A-1" } });
    });
});

describe("sdk — api.files", () => {
    it("uploads a single file with its custom fields", async () => {
        const file = new File([Buffer.from("PNG")], "cover.png", { type: "image/png" });

        const result: any = await api().files.upload("photos", file, { alt: "Cover", order: 2 });

        expect(hits[0]!.path).toBe("/api/v1/upload/photos");
        expect(hits[0]!.form!.get("file")).toBeInstanceOf(File);
        expect(hits[0]!.form!.get("alt")).toBe("Cover");
        expect(hits[0]!.form!.get("order")).toBe("2");
        expect(result._file.filename).toBe("f1.png");
    });

    it("uploads several files in one request, and uses the requested field name", async () => {
        await api().files.upload(
            "photos",
            [new File(["a"], "a.png"), new File(["b"], "b.png")],
            undefined,
            { fieldName: "upload" },
        );

        expect(hits[0]!.form!.getAll("upload")).toHaveLength(2);
        expect(hits[0]!.form!.get("file")).toBeNull();
    });

    it("builds a file URL, with the transformations the server understands", () => {
        const files = api().files;

        expect(files.url("photos", "f1.png")).toBe(`${base}/api/v1/files/photos/f1.png`);
        expect(files.url("photos", "f1.png", { width: 400, format: "webp" }))
            .toBe(`${base}/api/v1/files/photos/f1.png?w=400&format=webp`);
        expect(files.url("photos", "f1.png", { width: 400, height: 300, format: "avif", quality: 80 }))
            .toBe(`${base}/api/v1/files/photos/f1.png?w=400&h=300&format=avif&q=80`);
    });

    it("deletes a file by its document id", async () => {
        const result: any = await api().files.delete("photos", "f1");
        expect(hits[0]!.method).toBe("DELETE");
        expect(hits[0]!.path).toBe("/api/v1/files/photos/f1");
        expect(result.ok).toBe(true);
    });
});

describe("sdk — api.service & api.vars", () => {
    it("runs an action of the bound service, wrapping the payload in `data`", async () => {
        const analytics = api().service("analytics");
        expect(analytics.getName()).toBe("analytics");

        await analytics.run("generateReport", { from: "2026-01-01" });
        expect(hits[0]!.path).toBe("/api/v1/services/analytics/generateReport");
        expect(hits[0]!.body).toEqual({ data: { from: "2026-01-01" } });

        // An action without a payload still reaches the right route
        await analytics.run("exportCsv");
        expect(hits[1]!.path).toBe("/api/v1/services/analytics/exportCsv");
        expect(hits[1]!.body).toBeNull();
    });

    it("reaches the vars family, namespace and key in the body", async () => {
        const vars = api().vars;

        await vars.set("config", "licence", "RDX00");
        await vars.get("config", "licence");
        await vars.scope("acme").all("config");

        expect(hits.map((hit) => hit.path)).toEqual([
            "/api/v1/vars/set",
            "/api/v1/vars/get",
            "/api/v1/vars/all",
        ]);
        expect(hits[0]!.body).toEqual({ ns: "config", key: "licence", value: "RDX00" });
        expect(hits[2]!.body).toEqual({ ns: "config", scope: "acme" });
    });
});

/**
 * The original flat client: every method keeps the signature it always had, and
 * the URLs it builds are the new family ones — so a client written before the
 * namespaced client existed keeps working, without touching a single call site.
 */
describe("sdk — Rest, the original flat client", () => {
    it("keeps the CRUD methods, addressed at the new URLs", async () => {
        const client = legacy();

        await client.find("orders", { $match: { status: "paid" } });
        await client.findOne("orders", "64f1", { $include: ["customer"] });
        await client.aggregate("orders", [{ $count: "n" }]);
        await client.insertOne("orders", { ref: "A-1" });
        await client.insertMany("orders", [{ ref: "A-2" }]);
        await client.updateOne("orders", "64f1", { $set: { status: "shipped" } });
        await client.updateMany("orders", ["64f1"], { $set: { active: true } });
        await client.deleteOne("orders", "64f1");
        await client.deleteMany("orders", ["64f1"]);
        await client.runAction("orders", "refund", { reason: "damaged" });

        expect(hits.map((hit) => hit.path)).toEqual([
            "/api/v1/collections/orders/find",
            "/api/v1/collections/orders/findOne",
            "/api/v1/collections/orders/aggregate",
            "/api/v1/collections/orders/insertOne",
            "/api/v1/collections/orders/insertMany",
            "/api/v1/collections/orders/updateOne",
            "/api/v1/collections/orders/updateMany",
            "/api/v1/collections/orders/deleteOne",
            "/api/v1/collections/orders/deleteMany",
            "/api/v1/collections/orders/refund",
        ]);

        // Signatures are untouched: the collection is the first argument
        expect(hits[0]!.body).toEqual({ params: { $match: { status: "paid" } } });
        expect(hits[1]!.body).toEqual({ id: "64f1", params: { $include: ["customer"] } });
        expect(hits[3]!.body).toEqual({ data: { ref: "A-1" } });
    });

    it("keeps `login`/`logout` driving the token", async () => {
        const client = legacy();
        const users = "users";

        const { token } = await client.login(users, { email: "ada@example.com", password: "secret" });
        expect(token).toBe("jwt-token");
        expect(hits[0]!.path).toBe("/api/v1/collections/users/login");

        await client.find(users, {});
        expect(hits[1]!.headers.authorization).toBe("Bearer jwt-token");

        await client.logout(users);
        await client.find(users, {});
        expect(hits[3]!.headers.authorization).toBeUndefined();
    });

    it("keeps `upload`, `getFileUrl` and `deleteFile`", async () => {
        const client = legacy();
        const file = new File(["PNG"], "cover.png", { type: "image/png" });

        const uploaded: any = await client.upload("photos", file, { alt: "Cover" });
        expect(hits[0]!.path).toBe("/api/v1/upload/photos");
        expect(hits[0]!.form!.get("alt")).toBe("Cover");
        expect(uploaded._file.filename).toBe("f1.png");

        expect(client.getFileUrl("photos", "f1.png", { width: 400, format: "webp" }))
            .toBe(`${base}/api/v1/files/photos/f1.png?w=400&format=webp`);

        const deleted: any = await client.deleteFile("photos", "f1");
        expect(hits[1]!.method).toBe("DELETE");
        expect(hits[1]!.path).toBe("/api/v1/files/photos/f1");
        expect(deleted.ok).toBe(true);
    });

    it("keeps `runService`, `vars`, `agent` and `getConfig`", async () => {
        const client = legacy();

        await client.runService("analytics", "monthly", { month: "2026-09" });
        await client.vars.get<string>("config", "licence");
        await client.agent("support").info();
        await client.getConfig();

        expect(hits.map((hit) => hit.path)).toEqual([
            "/api/v1/services/analytics/monthly",
            "/api/v1/vars/get",
            "/api/v1/agents/support/info",
            "/_dnax/config/v1",
        ]);
    });

    it("shares the transport with the namespaced client — same headers, same token", async () => {
        const client = legacy();
        client.setHeader("X-Team", "platform");
        await client.login("users", { email: "ada@example.com", password: "secret" });

        const namespaced = api();
        namespaced.setHeader("X-Team", "platform");

        await client.find("orders", {});
        await namespaced.collection("orders").find({});

        for (const hit of hits) expect(hit.headers["x-team"]).toBe("platform");
        // Each client holds its own token — they are two instances, not one
        expect(hits[1]!.headers.authorization).toBe("Bearer jwt-token");
        expect(hits[2]!.headers.authorization).toBeUndefined();
    });
});
