import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createApp } from "../server/hono";
import { cfg } from "../server/config";
import { logger } from "../utils/logger";

/**
 * Opt-in request-body capture (`logging.captureBody`) — file-only access log.
 * The handler must still receive the body intact (we read a clone).
 */

const DIR = path.join(import.meta.dir, ".tmp-access-body");
let server: any;
let url = "";
let originalLogging: any;

function readAccessEntries(): any[] {
    const file = path.join(DIR, "app.log");
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf-8")
        .trim().split("\n").filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.logger === "http.log.access");
}

async function boot(http: any = {}) {
    cfg.server = {
        ...cfg.server,
        logging: { file: true, dir: DIR, console: false, level: "info", http },
    };
    const app = createApp();
    app.post("/echo", async (c) => {
        const contentType = c.req.header("content-type") ?? "";
        if (contentType.includes("multipart/form-data")) {
            await c.req.formData();
            return c.json({ ok: true });
        }
        return c.json(await c.req.json());
    });
    app.put("/echo", async (c) => c.json(await c.req.json()));
    app.get("/no-body", (c) => c.json({ ok: true }));
    server = Bun.serve({ port: 0, fetch: app.fetch });
    url = `${server.url.href.replace(/\/$/, "")}`;
}

beforeAll(() => {
    originalLogging = cfg.server.logging;
});

beforeEach(() => {
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(DIR, { recursive: true });
    logger.configure({ dir: DIR, file: true, console: false, level: "info" });
});

afterEach(() => {
    try { server?.stop(true); } catch {}
    server = null;
    logger.configure({ file: false, console: false });
    cfg.server = { ...cfg.server, logging: originalLogging };
});

afterAll(() => {
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("access log — request body capture", () => {
    it("captures a JSON body without breaking the handler", async () => {
        await boot({ body: true });
        const res = await fetch(`${url}/echo`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: "ada@example.com", password: "SuperSecret123!" }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ email: "ada@example.com", password: "SuperSecret123!" });

        await logger.flush();
        const entry = readAccessEntries().find((line) => line.uri === "/echo");
        expect(entry).toBeDefined();
        expect(entry.request_body).toBe('{"email":"ada@example.com","password":"SuperSecret123!"}');
        expect(entry.request_body_bytes).toBeGreaterThan(0);
        expect(entry.request_body_truncated).toBe(false);
    });

    it("does not capture a body by default", async () => {
        await boot({ body: false });
        await fetch(`${url}/echo`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ secret: "hidden" }),
        });

        await logger.flush();
        const entry = readAccessEntries().find((line) => line.uri === "/echo");
        expect(entry).toBeDefined();
        expect(entry.request_body).toBeUndefined();
        expect("request_body" in entry).toBe(false);
    });

    it("truncates at maxBodyBytes", async () => {
        await boot({ body: true, maxBodyBytes: 10 });
        await fetch(`${url}/echo`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value: "x".repeat(100) }),
        });

        await logger.flush();
        const entry = readAccessEntries().find((line) => line.uri === "/echo");
        expect(entry.request_body_truncated).toBe(true);
        expect(entry.request_body.length).toBe(10);
        expect(entry.request_body_bytes).toBe(10);
    });

    it("skips multipart bodies", async () => {
        await boot({ body: true });
        const form = new FormData();
        form.append("file", new Blob(["binary"], { type: "application/octet-stream" }), "f.bin");
        await fetch(`${url}/echo`, { method: "POST", body: form });

        await logger.flush();
        const entry = readAccessEntries().find((line) => line.uri === "/echo");
        expect(entry).toBeDefined();
        expect(entry.request_body).toBeUndefined();
    });
});

describe("access log — HTTP options group", () => {
    it("can disable the access log entirely", async () => {
        await boot({ enabled: false });
        await fetch(`${url}/echo`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ hidden: true }),
        });
        await logger.flush();
        expect(readAccessEntries().length).toBe(0);

        // The request itself is unaffected
        const res = await fetch(`${url}/echo`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ok: true }),
        });
        expect(res.status).toBe(200);
    });

    it("still accepts the deprecated top-level captureBody", async () => {
        cfg.server = {
            ...cfg.server,
            logging: { file: true, dir: DIR, console: false, level: "info", captureBody: true },
        };
        const app = createApp();
        app.post("/echo", async (c) => c.json(await c.req.json()));
        server = Bun.serve({ port: 0, fetch: app.fetch });
        url = `${server.url.href.replace(/\/$/, "")}`;

        await fetch(`${url}/echo`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ legacy: true }),
        });
        await logger.flush();
        const entry = readAccessEntries().find((line) => line.uri === "/echo");
        expect(entry.request_body).toBe('{"legacy":true}');
    });
});

describe("access log — GET", () => {
    it("does not add request_body for a bodyless GET", async () => {
        await boot({ body: true });
        const res = await fetch(`${url}/no-body`);
        expect(res.status).toBe(200);

        await logger.flush();
        const entry = readAccessEntries().find((line) => line.uri === "/no-body");
        expect(entry).toBeDefined();
        expect("request_body" in entry).toBe(false);
    });
});

describe("access log — method selection", () => {
    it("captures only the configured methods, case-insensitively", async () => {
        await boot({ body: true, methods: ["post"] });

        await fetch(`${url}/echo`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ captured: true }),
        });
        await fetch(`${url}/echo`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ captured: false }),
        });
        await logger.flush();

        const entries = readAccessEntries().filter((line) => line.uri === "/echo");
        const post = entries.find((line) => line.method === "POST");
        const put = entries.find((line) => line.method === "PUT");
        expect(post.request_body).toBe('{"captured":true}');
        expect("request_body" in put).toBe(false);
    });

    it("an empty methods list disables body capture", async () => {
        await boot({ body: true, methods: [] });
        await fetch(`${url}/echo`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ hidden: true }),
        });
        await logger.flush();

        const entry = readAccessEntries().find((line) => line.uri === "/echo");
        expect(entry).toBeDefined();
        expect("request_body" in entry).toBe(false);
    });
});

describe("access log — deprecated option names", () => {
    it("still accepts nested captureBody/captureMethods", async () => {
        cfg.server = {
            ...cfg.server,
            logging: {
                file: true, dir: DIR, console: false, level: "info",
                http: { captureBody: true, captureMethods: ["POST"] },
            },
        };
        const app = createApp();
        app.post("/echo-deprecated", async (c) => c.json(await c.req.json()));
        app.put("/echo-deprecated", async (c) => c.json(await c.req.json()));
        server = Bun.serve({ port: 0, fetch: app.fetch });
        url = `${server.url.href.replace(/\/$/, "")}`;

        await fetch(`${url}/echo-deprecated`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ post: true }),
        });
        await fetch(`${url}/echo-deprecated`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ put: true }),
        });
        await logger.flush();

        const entries = readAccessEntries().filter((line) => line.uri === "/echo-deprecated");
        expect(entries.find((line) => line.method === "POST").request_body).toBe('{"post":true}');
        expect("request_body" in entries.find((line) => line.method === "PUT")).toBe(false);
    });
});
