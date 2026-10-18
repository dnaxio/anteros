import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createApp, collectHeaders, redactUri } from "../server/hono";
import { cfg } from "../server/config";
import { AppError } from "../lib/error";
import { HTTPException } from "hono/http-exception";

const base = (server: any) => server.url.href.replace(/\/$/, "");

function resetServerConfig() {
    cfg.server = {
        ...cfg.server,
        cors: undefined,
        ipRestriction: undefined,
        trustProxy: undefined,
        rateLimit: undefined,
        security: undefined,
        files: undefined,
    };
}

beforeEach(() => {
    resetServerConfig();
    delete process.env.REDIS_URL;
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
    delete process.env.REDIS_PASSWORD;
});

afterEach(() => {
    resetServerConfig();
});

// ─── Error handling (C2) ─────────────────────────────────────────────────
// Note: these use a real Bun.serve — ipRestriction returns 403 when there is
// no real socket address (app.request() without a server).

async function bootAppWith(register: (app: any) => void) {
    const app = createApp();
    register(app);
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    return { url: `${base(server)}`, server };
}

describe("onError", () => {
    it("maps AppError to its status + code + message", async () => {
        const { url, server } = await bootAppWith((app) => {
            app.get("/app-error", () => {
                throw new AppError("Validation failed", { status: 400, code: "VALIDATION_ERROR" });
            });
        });
        const res = await fetch(`${url}/app-error`);
        expect(res.status).toBe(400);
        const body: any = await res.json();
        expect(body.code).toBe("VALIDATION_ERROR");
        expect(body.message).toBe("Validation failed");
        server.stop(true);
    });

    it("lets HTTPException respond with its own status", async () => {
        const { url, server } = await bootAppWith((app) => {
            app.get("/exc", () => {
                throw new HTTPException(401, { message: "Unauthorized" });
            });
        });
        const res = await fetch(`${url}/exc`);
        expect(res.status).toBe(401);
        server.stop(true);
    });

    it("returns 500 INTERNAL_SERVER_ERROR for unexpected errors", async () => {
        const { url, server } = await bootAppWith((app) => {
            app.get("/crash", () => {
                throw new Error("boom");
            });
        });
        const res = await fetch(`${url}/crash`);
        expect(res.status).toBe(500);
        const body: any = await res.json();
        expect(body.code).toBe("INTERNAL_SERVER_ERROR");
        server.stop(true);
    });
});

// ─── CORS (C1) ───────────────────────────────────────────────────────────

describe("CORS origin", () => {
    it("throws on credentials + wildcard", () => {
        cfg.server.cors = { origin: "*", credentials: true };
        expect(() => createApp()).toThrow(/CORS misconfiguration/);
    });

    it("accepts a string origin with credentials", () => {
        cfg.server.cors = { origin: "https://example.com", credentials: true };
        expect(() => createApp()).not.toThrow();
    });

    it("accepts a string[] origin", () => {
        cfg.server.cors = { origin: ["https://a.com", "https://b.com"], credentials: true };
        expect(() => createApp()).not.toThrow();
    });

    it("accepts a function origin", () => {
        cfg.server.cors = {
            origin: (ctx) => (ctx.origin === "https://ok.com" ? "https://ok.com" : "https://fallback.com"),
            credentials: true,
        };
        expect(() => createApp()).not.toThrow();
    });
});

// ─── Client IP / trustProxy (S1) ─────────────────────────────────────────

describe("client IP resolution", () => {
    it("ignores proxy headers by default (spoof-proof)", async () => {
        const app = createApp();
        app.get("/echo-ip", (c) => c.json({ ip: c.get("clientIp") }));
        const server = Bun.serve({ port: 0, fetch: app.fetch });

        cfg.server.trustProxy = false;
        const res = await fetch(`${base(server)}/echo-ip`, { headers: { "X-Forwarded-For": "1.2.3.4" } });
        const body: any = await res.json();
        expect(body.ip).not.toBe("1.2.3.4");

        server.stop(true);
    });

    it("uses the header when trustProxy is enabled", async () => {
        const app = createApp();
        app.get("/echo-ip", (c) => c.json({ ip: c.get("clientIp") }));
        const server = Bun.serve({ port: 0, fetch: app.fetch });

        cfg.server.trustProxy = true;
        const res = await fetch(`${base(server)}/echo-ip`, { headers: { "X-Forwarded-For": "1.2.3.4" } });
        const body: any = await res.json();
        expect(body.ip).toBe("1.2.3.4");

        server.stop(true);
    });
});

// ─── Health ──────────────────────────────────────────────────────────────

describe("Cross-Origin-Resource-Policy", () => {
    it("keeps API responses same-origin but lets served files be embedded", async () => {
        const { url, server } = await bootAppWith((app) => {
            app.get("/api/v1/files/photos/size/pic.png", () => new Response("image"));
        });

        const api = await fetch(`${url}/health`);
        expect(api.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");

        // Files are meant to be embedded by another origin (an `<img>` in the front).
        const file = await fetch(`${url}/api/v1/files/photos/size/pic.png`);
        expect(file.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");

        server.stop(true);
    });

    it("honours server.security.crossOriginResourcePolicy", async () => {
        cfg.server = { ...cfg.server, security: { crossOriginResourcePolicy: "cross-origin" } };
        const { url, server } = await bootAppWith(() => {});

        const res = await fetch(`${url}/health`);
        expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");

        server.stop(true);
    });

    it("honours server.files.crossOriginResourcePolicy", async () => {
        cfg.server = { ...cfg.server, files: { crossOriginResourcePolicy: "same-origin" } };
        const { url, server } = await bootAppWith((app) => {
            app.get("/api/v1/files/photos/size/pic.png", () => new Response("image"));
        });

        const res = await fetch(`${url}/api/v1/files/photos/size/pic.png`);
        expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");

        server.stop(true);
    });
});

describe("GET /health", () => {
    it("returns metrics + client ip", async () => {
        const { url, server } = await bootAppWith(() => {});
        const res = await fetch(`${url}/health`);
        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(typeof body.pid).toBe("number");
        expect(typeof body.ip).toBe("string");
        expect(body.requests).toBeDefined();
        expect(body.memory).toBeDefined();
        expect(body.cpu).toBeDefined();
        server.stop(true);
    });
});

// ─── Rate limiting ───────────────────────────────────────────────────────

describe("rate limiting (in-memory)", () => {
    it("serves X-RateLimit-* headers and blocks after max", async () => {
        cfg.server.rateLimit = { enabled: true, windowMs: 60_000, max: 3 };
        const app = createApp();
        app.get("/echo", (c) => c.json({ ok: true }));
        const server = Bun.serve({ port: 0, fetch: app.fetch });
        const url = `${base(server)}/echo`;

        const statuses: number[] = [];
        let first: Response | undefined;
        for (let i = 0; i < 4; i++) {
            const r = await fetch(url);
            if (i === 0) first = r;
            statuses.push(r.status);
        }
        expect(statuses).toEqual([200, 200, 200, 429]);

        // headers present on the first request
        expect(first!.headers.get("X-RateLimit-Limit")).toBe("3");
        expect(first!.headers.get("X-RateLimit-Remaining")).toBe("2");

        server.stop(true);
    });

    it("login limiter uses a distinct counter (not blocked by global)", async () => {
        cfg.server.rateLimit = { enabled: true, windowMs: 60_000, max: 100, login: { max: 2 } };
        const app = createApp();
        app.get("/echo", (c) => c.json({ ok: true }));
        const server = Bun.serve({ port: 0, fetch: app.fetch });
        const url = `${base(server)}`;

        // The login limiter has its own bucket: the third call is refused even though
        // the global limit (100) is nowhere near. What the framework answers before
        // that (unknown tenant here) is not the point.
        const statuses: number[] = [];
        for (let i = 0; i < 3; i++) {
            statuses.push((await fetch(`${url}/api/x/collections/users/login`, { method: "POST" })).status);
        }
        expect(statuses.slice(0, 2).some((status) => status === 429)).toBe(false);
        expect(statuses[2]).toBe(429);

        // same IP on a normal route → still allowed (distinct key)
        expect((await fetch(`${url}/echo`)).status).toBe(200);

        server.stop(true);
    });

    it("falls back to in-memory when Redis is configured but unreachable (auto-detect)", async () => {
        cfg.server.rateLimit = { enabled: true, max: 100, redis: { host: "localhost", port: 1 } };
        const app = createApp();
        app.get("/echo", (c) => c.json({ ok: true }));
        const server = Bun.serve({ port: 0, fetch: app.fetch });
        const res = await fetch(`${base(server)}/echo`);
        expect(res.status).toBe(200);
        server.stop(true);
    });
});

describe("access log sanitisation (#39)", () => {
    it("removes sensitive headers", () => {
        const headers = collectHeaders(new Headers({
            authorization: "Bearer secret",
            cookie: "sid=secret",
            "x-api-key": "key-secret",
            "x-team": "core",
        }));
        expect(headers["authorization"]).toBeUndefined();
        expect(headers["cookie"]).toBeUndefined();
        expect(headers["x-api-key"]).toBeUndefined();
        expect(headers["x-team"]).toEqual(["core"]);
    });

    it("redacts sensitive query parameters", () => {
        expect(redactUri("/api/v1/collections/users/find?token=secret&page=2"))
            .toBe("/api/v1/collections/users/find?token=%5Bredacted%5D&page=2");
        expect(redactUri("/health")).toBe("/health");
        expect(redactUri("/x?query=hello")).toBe("/x?query=hello");
    });
});

describe("body limit (#51)", () => {
    it("rejects a request body over the 16MB default", async () => {
        const { url, server } = await bootAppWith((app) => {
            app.post("/echo", async (c) => c.json({ ok: true }));
        });

        const res = await fetch(`${url}/echo`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "x".repeat(17 * 1024 * 1024),
        });
        expect(res.status).toBe(413);

        server.stop(true);
    });
});
