import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../server/hono";
import { formatConfig, cfg } from "../server/config";
import { syncTenants } from "../database/tenant";
import { getFileCollection } from "../database/file";
import { useRest } from "../database/rest";

const TENANT = "up-test";
const DB = "mongodb://localhost:27017/_DB_UP_TEST";
const SLUG = "photos";

let rest: InstanceType<typeof useRest>;
let server: any;
let url = "";

beforeAll(async () => {
    formatConfig({
        server: { port: 4000 },
        tenants: [{ id: TENANT, dir: "up-tenant", database: { uri: DB } }],
    });
    await syncTenants();

    // File collection (disk storage) — no syncing from disk, declared directly
    (cfg as any).fileCollections = [{
        _tenant_: TENANT,
        _isFileCollection_: true,
        slug: SLUG,
        fields: [{ name: "label", type: "string" }],
        upload: { allowedMimeTypes: ["image/png", "text/plain"], maxSize: 5 * 1024 * 1024 },
        storage: { driver: "disk" },
        api: { access: { "*": true } },
    }];

    rest = new useRest({ internal: false, tenant_id: TENANT });
    const app = createApp();
    server = Bun.serve({ port: 0, fetch: app.fetch });
    url = server.url.href.replace(/\/$/, "");
});

afterAll(async () => {
    try { await rest.db.collection(SLUG).drop(); } catch {}
    // clean the uploaded files
    try {
        const fs = await import("node:fs/promises");
        await fs.rm(`${process.cwd()}/storage/${TENANT}/${SLUG}`, { recursive: true, force: true });
    } catch {}
    try { server.stop(true); } catch {}
});

function pngFile(name: string) {
    // minimal valid PNG (1x1) so content detection sees a real image
    const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64"
    );
    return new File([bytes], name, { type: "image/png" });
}

describe("upload — single file (unchanged contract)", () => {
    it("returns a single object", async () => {
        const form = new FormData();
        form.append("file", pngFile("one.png"));
        form.append("label", "single");

        const res = await fetch(`${url}/upload/${TENANT}/${SLUG}`, { method: "POST", body: form });
        expect(res.status).toBe(200);

        const body: any = await res.json();
        expect(Array.isArray(body)).toBe(false);          // ← object, not an array
        expect(body._id).toBeString();
        expect(body._file.name).toBe("one.png");
        expect(body._file.mimetype).toBe("image/png");
        expect(body._file.url).toContain(`/files/${TENANT}/${SLUG}/`);

        // metadata persisted on the document
        const doc: any = await rest.findOne(SLUG, body._id);
        expect(doc.label).toBe("single");
    });

    it("accepts the 'upload' field name too", async () => {
        const form = new FormData();
        form.append("upload", pngFile("alt.png"));

        const res = await fetch(`${url}/upload/${TENANT}/${SLUG}`, { method: "POST", body: form });
        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(Array.isArray(body)).toBe(false);
        expect(body._file.name).toBe("alt.png");
    });
});

describe("upload — multiple files", () => {
    it("returns an array and creates one document per file", async () => {
        const form = new FormData();
        form.append("file", pngFile("a.png"));
        form.append("file", pngFile("b.png"));
        form.append("file", pngFile("c.png"));
        form.append("label", "batch");

        const res = await fetch(`${url}/upload/${TENANT}/${SLUG}`, { method: "POST", body: form });
        expect(res.status).toBe(200);

        const body: any = await res.json();
        expect(Array.isArray(body)).toBe(true);
        expect(body.length).toBe(3);
        expect(body.map((f: any) => f._file.name).sort()).toEqual(["a.png", "b.png", "c.png"]);

        // every file is its own document, all ids distinct, metadata shared
        const ids = body.map((f: any) => f._id);
        expect(new Set(ids).size).toBe(3);
        for (const id of ids) {
            const doc: any = await rest.findOne(SLUG, id);
            expect(doc.label).toBe("batch");
            expect(doc._file.url).toContain(`/files/${TENANT}/${SLUG}/`);
        }
    });

    it("still rejects a request without any file", async () => {
        const form = new FormData();
        form.append("label", "nofile");

        const res = await fetch(`${url}/upload/${TENANT}/${SLUG}`, { method: "POST", body: form });
        expect(res.status).toBe(400);
        const body: any = await res.json();
        expect(body.code).toBe("FILE_REQUIRED");
    });

    it("rejects the whole batch on an invalid file (per-file validation)", async () => {
        const form = new FormData();
        form.append("file", pngFile("ok.png"));
        form.append("file", new File([Buffer.from("nope")], "bad.exe", { type: "application/x-msdownload" }));

        const res = await fetch(`${url}/upload/${TENANT}/${SLUG}`, { method: "POST", body: form });
        expect(res.status).toBe(400);
        const body: any = await res.json();
        expect(body.code).toBe("MIMETYPE_NOT_ALLOWED");
    });
});
