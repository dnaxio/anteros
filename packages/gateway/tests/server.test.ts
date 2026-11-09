import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../index";
import type { GatewayLogEntry } from "../index";

let gateway: ReturnType<typeof createGateway> | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;

afterEach(async () => {
    await gateway?.stop(true);
    upstream?.stop(true);
    gateway = undefined;
    upstream = undefined;
});

test("routes /api/<microservice>, exposes /health and 404s the rest", async () => {
    upstream = Bun.serve({ port: 0, fetch: () => Response.json({ from: "pharmacie" }) });
    const logs: GatewayLogEntry[] = [];

    gateway = createGateway({
        port: 0,
        microservices: [{ name: "pharmacie", upstream: upstream.url.origin }],
        logging: { name: "gw-test", fields: { env: "test", instance: "i-1" } },
        logger: (entry) => logs.push(entry),
    });

    const routed = await fetch(`${gateway.server.url}api/pharmacie/collections/x/find`);
    expect(await routed.json()).toEqual({ from: "pharmacie" });

    const health = await fetch(`${gateway.server.url}health`);
    expect(await health.json()).toEqual({ status: "ok", microservices: ["pharmacie"] });

    const unknown = await fetch(`${gateway.server.url}api/unknown/x`);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as any).code).toBe("MICROSERVICE_NOT_FOUND");

    expect(logs.map((entry) => entry.status)).toEqual([200, 404]);
    expect(logs[0]?.microservice).toBe("pharmacie");

    const loggedAt = Date.parse(logs[0]!.timestamp);
    expect(Number.isNaN(loggedAt)).toBe(false);
    expect(Math.abs(Date.now() - loggedAt)).toBeLessThan(5000);

    expect(logs[0]?.level).toBe("info");
    expect(logs[0]?.logger).toBe("gw-test");
    expect(logs[0]?.env).toBe("test");
    expect(logs[0]?.instance).toBe("i-1");
});

test("relays a request with no Authorization header unchanged", async () => {
    let authorization: string | null = "unset";
    upstream = Bun.serve({
        port: 0,
        fetch: (req) => {
            authorization = req.headers.get("authorization");
            return new Response("ok");
        },
    });
    gateway = createGateway({
        port: 0,
        microservices: [{ name: "pharmacie", upstream: upstream.url.origin }],
        logger: () => {},
    });

    const response = await fetch(`${gateway.server.url}api/pharmacie/anything`);
    expect(response.status).toBe(200);
    expect(authorization).toBeNull();
});

test("logs only the microservices named in logging.microservices", async () => {
    const pharmacie = Bun.serve({ port: 0, fetch: () => new Response("p") });
    const stats = Bun.serve({ port: 0, fetch: () => new Response("s") });
    const logs: GatewayLogEntry[] = [];

    try {
        gateway = createGateway({
            port: 0,
            microservices: [
                { name: "pharmacie", upstream: pharmacie.url.origin },
                { name: "stats", upstream: stats.url.origin },
            ],
            logging: { microservices: ["pharmacie"] },
            logger: (entry) => logs.push(entry),
        });

        await fetch(`${gateway.server.url}api/pharmacie/x`);
        await fetch(`${gateway.server.url}api/stats/x`);
        await fetch(`${gateway.server.url}api/unknown/x`);

        expect(logs.map((entry) => entry.microservice)).toEqual(["pharmacie"]);
        expect(logs).toHaveLength(1);
    } finally {
        pharmacie.stop(true);
        stats.stop(true);
    }
});

test("writes no request log when logging is disabled", async () => {
    upstream = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const logs: GatewayLogEntry[] = [];

    gateway = createGateway({
        port: 0,
        microservices: [{ name: "pharmacie", upstream: upstream.url.origin }],
        logging: { enabled: false },
        logger: (entry) => logs.push(entry),
    });

    await fetch(`${gateway.server.url}api/pharmacie/x`);
    await fetch(`${gateway.server.url}api/unknown/x`);

    expect(logs).toEqual([]);
});

test("marks a 5xx response as error", async () => {
    upstream = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500 }) });
    const logs: GatewayLogEntry[] = [];

    gateway = createGateway({
        port: 0,
        microservices: [{ name: "pharmacie", upstream: upstream.url.origin }],
        logger: (entry) => logs.push(entry),
    });

    const response = await fetch(`${gateway.server.url}api/pharmacie/x`);
    expect(response.status).toBe(500);
    expect(logs[0]?.level).toBe("error");
    expect(logs[0]?.logger).toBe("gateway");
});

test("answers CORS preflight locally and owns the response headers", async () => {
    let hits = 0;
    upstream = Bun.serve({
        port: 0,
        fetch: () => {
            hits += 1;
            return new Response("ok", { headers: { "access-control-allow-origin": "*" } });
        },
    });

    gateway = createGateway({
        port: 0,
        microservices: [{ name: "pharmacie", upstream: upstream.url.origin }],
        cors: { origins: ["https://app.example.com"], exposeHeaders: ["x-request-id"] },
        logger: () => {},
    });

    const preflight = await fetch(`${gateway.server.url}api/pharmacie/x`, {
        method: "OPTIONS",
        headers: {
            origin: "https://app.example.com",
            "access-control-request-method": "GET",
            "access-control-request-headers": "authorization",
        },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(preflight.headers.get("access-control-allow-headers")).toBe("authorization");
    expect(hits).toBe(0);

    const response = await fetch(`${gateway.server.url}api/pharmacie/x`, {
        headers: { origin: "https://app.example.com" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(response.headers.get("access-control-allow-methods")).toBeNull();
    expect(response.headers.get("access-control-expose-headers")).toBe("x-request-id");
    expect(hits).toBe(1);

    const refused = await fetch(`${gateway.server.url}api/pharmacie/x`, {
        headers: { origin: "https://evil.example.com" },
    });
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
});

test("a failing logger does not fail the request", async () => {
    upstream = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    gateway = createGateway({
        port: 0,
        microservices: [{ name: "pharmacie", upstream: upstream.url.origin }],
        logger: () => {
            throw new Error("disk full");
        },
    });

    const response = await fetch(`${gateway.server.url}api/pharmacie/x`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
});

test("applies CORS per microservice and lets one opt out", async () => {
    let statsHits = 0;
    const pharmacie = Bun.serve({ port: 0, fetch: () => new Response("p") });
    const stats = Bun.serve({
        port: 0,
        fetch: () => {
            statsHits += 1;
            return new Response("s", { headers: { "access-control-allow-origin": "*" } });
        },
    });

    try {
        gateway = createGateway({
            port: 0,
            microservices: [
                {
                    name: "pharmacie",
                    upstream: pharmacie.url.origin,
                    cors: { origins: ["https://pharma.example.com"] },
                },
                { name: "stats", upstream: stats.url.origin, cors: false },
            ],
            logger: () => {},
        });

        const preflight = await fetch(`${gateway.server.url}api/pharmacie/x`, {
            method: "OPTIONS",
            headers: {
                origin: "https://pharma.example.com",
                "access-control-request-method": "GET",
            },
        });
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get("access-control-allow-origin")).toBe("https://pharma.example.com");

        const statsPreflight = await fetch(`${gateway.server.url}api/stats/x`, {
            method: "OPTIONS",
            headers: {
                origin: "https://pharma.example.com",
                "access-control-request-method": "GET",
            },
        });
        expect(statsPreflight.status).toBe(200);
        expect(statsHits).toBe(1);
        expect(statsPreflight.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
        pharmacie.stop(true);
        stats.stop(true);
    }
});

test("stores JSONL lines when logging.engine is file", async () => {
    upstream = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const dir = mkdtempSync(join(tmpdir(), "gateway-file-"));
    const file = join(dir, "gtw.log");

    try {
        gateway = createGateway({
            port: 0,
            microservices: [{ name: "pharmacie", upstream: upstream.url.origin }],
            logging: { engine: "file", file, fields: { env: "test" } },
        });
        await gateway.ready;

        await fetch(`${gateway.server.url}api/pharmacie/x`);
        await gateway.stop(true);

        const lines = (await Bun.file(file).text()).trim().split("\n");
        expect(lines).toHaveLength(1);
        const entry = JSON.parse(lines[0]!);
        expect(entry.microservice).toBe("pharmacie");
        expect(entry.status).toBe(200);
        expect(entry.env).toBe("test");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("stores rows in a DuckDB database when logging.engine is duckdb", async () => {
    upstream = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const dir = mkdtempSync(join(tmpdir(), "gateway-duckdb-"));
    const file = join(dir, "gtw.log.duckdb");

    try {
        gateway = createGateway({
            port: 0,
            microservices: [{ name: "pharmacie", upstream: upstream.url.origin }],
            logging: { engine: "duckdb", file, fields: { env: "test" } },
        });
        await gateway.ready;

        await fetch(`${gateway.server.url}api/pharmacie/x`);
        await gateway.stop(true);

        const { DuckDBInstance } = await import("@duckdb/node-api");
        const instance = await DuckDBInstance.create(file);
        const connection = await instance.connect();
        try {
            const reader = await connection.runAndReadAll(
                "SELECT level, microservice, status, fields, raw FROM logs",
            );
            const rows = reader.getRowObjectsJson();
            expect(rows).toHaveLength(1);
            expect(rows[0]?.microservice).toBe("pharmacie");
            expect(rows[0]?.status).toBe(200);
            expect(rows[0]?.level).toBe("info");
        } finally {
            connection.closeSync();
            instance.closeSync();
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("rotates the file by size and keeps maxFiles archives", async () => {
    upstream = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const dir = mkdtempSync(join(tmpdir(), "gateway-rotate-"));
    const file = join(dir, "gateway.log");

    try {
        gateway = createGateway({
            port: 0,
            microservices: [{ name: "pharmacie", upstream: upstream.url.origin }],
            logging: { engine: "file", file, rotate: "size", maxSize: "100b", maxFiles: 2 },
        });
        await gateway.ready;

        for (let request = 0; request < 4; request += 1) {
            await fetch(`${gateway.server.url}api/pharmacie/x`);
        }
        await gateway.stop(true);

        const files = readdirSync(dir);
        expect(files).toContain("gateway.log");
        const archives = files.filter((entry) => entry !== "gateway.log");
        expect(archives).toHaveLength(2);
        expect(archives.every((entry) => entry.startsWith("gateway-"))).toBe(true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("purges DuckDB rows older than the configured TTL", async () => {    upstream = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const dir = mkdtempSync(join(tmpdir(), "gateway-ttl-"));
    const file = join(dir, "gateway.duckdb");

    try {
        gateway = createGateway({
            port: 0,
            microservices: [{ name: "pharmacie", upstream: upstream.url.origin }],
            logging: { engine: "duckdb", file, ttl: "100ms", purgeEvery: "50ms", purgeOnStart: false },
        });
        await gateway.ready;

        await fetch(`${gateway.server.url}api/pharmacie/x`);
        await Bun.sleep(400);
        await gateway.stop(true);

        const { DuckDBInstance } = await import("@duckdb/node-api");
        const instance = await DuckDBInstance.create(file);
        const connection = await instance.connect();
        try {
            const reader = await connection.runAndReadAll("SELECT count(*) AS n FROM logs");
            expect(Number(reader.getRowObjectsJson()[0]?.n)).toBe(0);
        } finally {
            connection.closeSync();
            instance.closeSync();
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("captures and redacts a JSON body without altering the upstream request", async () => {
    let received: unknown;
    upstream = Bun.serve({
        port: 0,
        fetch: async (req) => {
            received = await req.json();
            return new Response("ok");
        },
    });
    const logs: GatewayLogEntry[] = [];

    gateway = createGateway({
        port: 0,
        microservices: [{ name: "pharmacie", upstream: upstream.url.origin }],
        logging: { captureBody: true },
        logger: (entry) => logs.push(entry),
    });

    const payload = { user: "ada", password: "s3cret", nested: { token: "abc", ok: 1 } };
    const response = await fetch(`${gateway.server.url}api/pharmacie/x`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);
    expect(received).toEqual(payload);
    expect(logs[0]?.requestBody).toEqual({
        user: "ada",
        password: "[redacted]",
        nested: { token: "[redacted]", ok: 1 },
    });
});

test("skips a body above maxBytes or outside the captured content types", async () => {
    upstream = Bun.serve({
        port: 0,
        fetch: async (req) => {
            await req.text();
            return new Response("ok");
        },
    });
    const logs: GatewayLogEntry[] = [];

    gateway = createGateway({
        port: 0,
        microservices: [{ name: "pharmacie", upstream: upstream.url.origin }],
        logging: { captureBody: { maxBytes: 10 } },
        logger: (entry) => logs.push(entry),
    });

    await fetch(`${gateway.server.url}api/pharmacie/x`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "longer than ten bytes" }),
    });
    await fetch(`${gateway.server.url}api/pharmacie/x`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: "binary",
    });

    expect(logs).toHaveLength(2);
    expect(logs[0]?.requestBody).toBeUndefined();
    expect(logs[1]?.requestBody).toBeUndefined();
});
