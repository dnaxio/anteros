import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { ObjectId } from "mongodb";
import { createApp } from "../server/hono";
import { formatConfig, cfg } from "../server/config";
import { syncTenants } from "../database/tenant";
import { getFileCollection } from "../database/file";
import { useRest } from "../database/rest";
import { createApi } from "../lib/api";

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
        fields: [{ name: "label", type: "string" }, { name: "takenAt", type: "date" }],
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

describe("upload — audit trail", () => {
    /** Latest audit entry for an action, polling until it lands */
    async function auditEntry(action: string, id?: string) {
        const filter: any = { "operation.action": action };
        if (id) filter["operation.result._id"] = id;
        for (let i = 0; i < 40; i++) {
            const found: any = await rest.db.collection("_audit_").findOne(filter, { sort: { ts: -1 } });
            if (found) return found;
            await Bun.sleep(25);
        }
        return null;
    }

    it("records an upload with the file metadata and the generated id — never the document", async () => {
        const form = new FormData();
        form.append("file", pngFile("audited.png"));
        form.append("label", "audited");

        const res = await fetch(`${url}/api/${TENANT}/upload/${SLUG}`, { method: "POST", body: form });
        expect(res.status).toBe(200);
        const body: any = await res.json();

        const logged: any = await auditEntry("upload", body._id);
        expect(logged).not.toBeNull();
        expect(logged.operation.collection).toBe(SLUG);
        expect(logged.operation.collectionType).toBe("file");
        expect(logged.operation.status).toBe("success");
        expect(logged.internal).toBe(false); // HTTP upload

        // parameters only: the file's metadata and which custom fields were sent
        expect(logged.operation.input.file.name).toBe("audited.png");
        expect(logged.operation.input.file.mimetype).toBe("image/png");
        expect(typeof logged.operation.input.file.size).toBe("number");
        expect(logged.operation.input.fields).toEqual(["label"]);
        expect(logged.operation.input.label).toBeUndefined(); // the value is NOT stored

        // and the generated id, never the stored document
        expect(logged.operation.result).toEqual({ _id: body._id });
    });

    it("records a file deletion", async () => {
        const form = new FormData();
        form.append("file", pngFile("deleted.png"));
        const uploaded: any = await (
            await fetch(`${url}/api/${TENANT}/upload/${SLUG}`, { method: "POST", body: form })
        ).json();

        const res = await fetch(`${url}/api/${TENANT}/files/${SLUG}/${uploaded._id}`, { method: "DELETE" });
        expect(res.status).toBe(200);

        const logged: any = await auditEntry("deleteFile");
        expect(logged).not.toBeNull();
        expect(logged.operation.input.id).toBe(uploaded._id);
        expect(logged.operation.input.filename).toBeString();
        expect(logged.operation.result).toEqual({ deleted: true });
        expect(logged.internal).toBe(false);
    });
});

describe("upload — single file (unchanged contract)", () => {
    it("returns a single object", async () => {
        const form = new FormData();
        form.append("file", pngFile("one.png"));
        form.append("label", "single");

        const res = await fetch(`${url}/api/${TENANT}/upload/${SLUG}`, { method: "POST", body: form });
        expect(res.status).toBe(200);

        const body: any = await res.json();
        expect(Array.isArray(body)).toBe(false);          // ← object, not an array
        expect(body._id).toBeString();
        expect(body._file.name).toBe("one.png");
        expect(body._file.mimetype).toBe("image/png");
        expect(body._file.url).toContain(`/api/${TENANT}/files/${SLUG}/`);
        expect(body.createdAt).toBeString();
        expect(body.updatedAt).toBeString();

        // metadata persisted on the document
        const doc: any = await rest.findOne(SLUG, body._id);
        expect(doc.label).toBe("single");

        // Stored as BSON Dates (same end result as collections via toBson)
        const raw: any = await rest.db.collection(SLUG).findOne({ _id: new ObjectId(body._id) });
        expect(raw.createdAt).toBeInstanceOf(Date);
        expect(raw.updatedAt).toBeInstanceOf(Date);
    });

    it("accepts the 'upload' field name too", async () => {
        const form = new FormData();
        form.append("upload", pngFile("alt.png"));

        const res = await fetch(`${url}/api/${TENANT}/upload/${SLUG}`, { method: "POST", body: form });
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

        const res = await fetch(`${url}/api/${TENANT}/upload/${SLUG}`, { method: "POST", body: form });
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
            expect(doc._file.url).toContain(`/api/${TENANT}/files/${SLUG}/`);
            // Uploads carry timestamps (required by the replication cursor)
            expect(doc.createdAt).toBeString();
            expect(doc.updatedAt).toBeString();
        }
    });

    it("still rejects a request without any file", async () => {
        const form = new FormData();
        form.append("label", "nofile");

        const res = await fetch(`${url}/api/${TENANT}/upload/${SLUG}`, { method: "POST", body: form });
        expect(res.status).toBe(400);
        const body: any = await res.json();
        expect(body.code).toBe("FILE_REQUIRED");
    });

    it("rejects the whole batch on an invalid file (per-file validation)", async () => {
        const form = new FormData();
        form.append("file", pngFile("ok.png"));
        form.append("file", new File([Buffer.from("nope")], "bad.exe", { type: "application/x-msdownload" }));

        const res = await fetch(`${url}/api/${TENANT}/upload/${SLUG}`, { method: "POST", body: form });
        expect(res.status).toBe(400);
        const body: any = await res.json();
        expect(body.code).toBe("MIMETYPE_NOT_ALLOWED");
    });
});

describe("upload — custom field types (toBson, like collections)", () => {
    it("converts a `date` field to a BSON Date", async () => {
        const form = new FormData();
        form.append("file", pngFile("dated.png"));
        form.append("label", "dated");
        form.append("takenAt", "2024-05-01T10:00:00.000Z");

        const res = await fetch(`${url}/api/${TENANT}/upload/${SLUG}`, { method: "POST", body: form });
        expect(res.status).toBe(200);
        const body: any = await res.json();

        const raw: any = await rest.db.collection(SLUG).findOne({ _id: new ObjectId(body._id) });
        expect(raw.takenAt).toBeInstanceOf(Date);
        expect(raw.takenAt.toISOString()).toBe("2024-05-01T10:00:00.000Z");
    });

    it("leaves `_file` untouched, even when a name looks like a date", async () => {
        const form = new FormData();
        form.append("file", pngFile("2024-01-01")); // ← a file literally named like a date

        const res = await fetch(`${url}/api/${TENANT}/upload/${SLUG}`, { method: "POST", body: form });
        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body._file.name).toBe("2024-01-01");

        const raw: any = await rest.db.collection(SLUG).findOne({ _id: new ObjectId(body._id) });
        expect(raw._file.name).toBe("2024-01-01"); // NOT converted to a Date
        expect(typeof raw._file.name).toBe("string");
    });
});

describe("api.files — the in-process facade", () => {
    it("builds a file URL, with the transformations the route understands", () => {
        const api = createApi(rest);

        expect(api.files.url(SLUG, "f1.png")).toBe(`/api/${TENANT}/files/${SLUG}/f1.png`);
        expect(api.files.url(SLUG, "f1.png", { width: 200, format: "webp" }))
            .toBe(`/api/${TENANT}/files/${SLUG}/f1.png?w=200&format=webp`);
        expect(api.files.url(SLUG, "f1.png", { width: 200, height: 100, format: "avif", quality: 70 }))
            .toBe(`/api/${TENANT}/files/${SLUG}/f1.png?w=200&h=100&format=avif&q=70`);
    });

    it("deletes the binary and the document — the same path as the route", async () => {
        const form = new FormData();
        form.append("file", pngFile("to-delete.png"));
        const uploaded: any = await (
            await fetch(`${url}/api/${TENANT}/upload/${SLUG}`, { method: "POST", body: form })
        ).json();

        const fs = await import("node:fs/promises");
        const storage = getFileCollection(SLUG, TENANT)?.storage as any;
        const dir = `${process.cwd()}/${storage?.path ?? "storage"}/${TENANT}/${SLUG}`;
        expect((await fs.readdir(dir)).some((name) => name.startsWith(uploaded._id))).toBe(true);

        const result = await createApi(rest).files.delete(SLUG, uploaded._id);

        expect(result).toEqual({ message: "File deleted", ok: true });
        expect(await rest.findOne(SLUG, uploaded._id)).toBeNull();
        expect((await fs.readdir(dir)).some((name) => name.startsWith(uploaded._id))).toBe(false);
    });
});
