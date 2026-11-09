# Anteros Gateway v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@anteros/gateway`, a passive L7 reverse proxy that routes `/api/<microservice>/…` to independent Anteros deployments, preserving method, path, headers, body and response streams, with no authentication or other control.

**Architecture:** A Bun + Hono process reads a typed `microservices` table and forwards each request to the matching upstream without rewriting the path. Proxy concerns are isolated in pure modules (`router`, `proxy`, `headers`) so they can be tested against fake `Bun.serve` upstreams; `server.ts` only wires HTTP, `/health`, 404s and logs.

**Tech Stack:** Bun 1.4+, TypeScript, Hono, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-08-anteros-gateway-design.md`

## Global Constraints

- **No core changes**, no change to any Anteros application in this repo.
- **No control** in the gateway: no JWT verification, no authentication, no rate limiting, no retries, no cache, no aggregation, no path rewrite.
- The first path segment is both the **microservice name** and the **Anteros tenant id** the backend expects; it is forwarded unchanged.
- `timeoutMs` covers connection and **upstream response headers**, never the response body.
- Defaults: `port` 8080, `timeoutMs` 30_000.
- Never log `authorization`, `cookie`, or request/response bodies.
- **Do not commit**: the user has not asked for commits. End each task with tests and typecheck green; leave changes in the working tree.
- Runtime dependency limited to `hono`; tests use `bun test` and `Bun.serve`.

## Review Focus

- **Compressed upstream response (gzip/br):** the proxy must forward the original compressed bytes and headers, not a body decoded by `fetch` while `content-encoding` stays set. Test in Task 3 with `decompress: false`.
- **Multiple `Set-Cookie` headers:** both cookies must reach the client separately; a `Headers` copy can collapse them. Test in Task 3 with `getSetCookie()`.
- **Streaming request body:** a chunked/streamed upload must arrive intact (`duplex: "half"`); buffering or dropping the body breaks large uploads. Test in Task 3.
- **SSE:** the first event must be readable before the upstream closes; a buffered proxy or an over-eager timeout breaks agents and live views. Test in Task 3.
- **204/304 responses:** they must be forwarded with a `null` body; constructing `new Response(stream, { status: 204 })` throws. Test in Task 3.

---

## File Structure

```text
packages/gateway/
├── package.json
├── tsconfig.json
├── LICENSE                 (copy of packages/core/LICENSE)
├── README.md               (Task 6)
├── index.ts
├── bin/gateway.ts          (Task 5)
├── lib/
│   ├── config.ts           defineGateway, resolveGatewayConfig, GatewayConfigError
│   ├── router.ts           matchMicroservice
│   ├── headers.ts          hop-by-hop filtering, X-Forwarded-*, request id
│   ├── proxy.ts            proxyRequest (fetch upstream, streaming, errors)
│   ├── server.ts           createGateway (Hono app + Bun.serve)
│   └── configFile.ts       loadGatewayConfig (Task 5)
├── types/index.ts          public types + GatewayLogEntry
└── tests/
    ├── config.test.ts
    ├── router.test.ts
    ├── proxy.test.ts
    ├── server.test.ts
    ├── configFile.test.ts
    └── fixtures/gateway.config.ts
```

---

### Task 1: Package scaffold and configuration

**Files:**
- Create: `packages/gateway/package.json`
- Create: `packages/gateway/tsconfig.json`
- Create: `packages/gateway/LICENSE` (copy `packages/core/LICENSE`)
- Create: `packages/gateway/types/index.ts`
- Create: `packages/gateway/lib/config.ts`
- Create: `packages/gateway/index.ts`
- Test: `packages/gateway/tests/config.test.ts`

**Interfaces:**
- Produces: `GatewayMicroservice { name: string; upstream: string }`, `GatewayConfig { port?: number; microservices: GatewayMicroservice[]; timeoutMs?: number; logger?: (entry: GatewayLogEntry) => void }`, `ResolvedGatewayConfig { port: number; timeoutMs: number; microservices: readonly GatewayMicroservice[]; logger: (entry: GatewayLogEntry) => void }`, `GatewayLogEntry`, `GatewayConfigError`, `defineGateway(config)`, `resolveGatewayConfig(config)`.

- [ ] **Step 1: Create the package files**

`package.json`:

```json
{
  "name": "@anteros/gateway",
  "version": "0.0.1",
  "description": "Anteros Gateway — passive reverse proxy for Anteros microservices",
  "type": "module",
  "main": "index.ts",
  "module": "index.ts",
  "types": "index.ts",
  "license": "MIT",
  "private": false,
  "files": ["bin", "lib", "types", "index.ts", "README.md"],
  "exports": {
    ".": {
      "types": "./index.ts",
      "import": "./index.ts",
      "default": "./index.ts"
    },
    "./package.json": "./package.json"
  },
  "bin": { "anteros-gateway": "./bin/gateway.ts" },
  "scripts": {
    "test": "bun test",
    "typecheck": "bunx tsc --noEmit -p tsconfig.json"
  },
  "dependencies": { "hono": "^4.13.1" },
  "devDependencies": { "@types/bun": "latest" },
  "peerDependencies": { "typescript": "^6.0.3" }
}
```

`tsconfig.json`: copy `packages/reco/tsconfig.json` unchanged, with `"include": ["types/**/*.ts", "lib/**/*.ts", "bin/**/*.ts", "tests/**/*.ts", "index.ts"]`.

`LICENSE`: copy `packages/core/LICENSE`.

- [ ] **Step 2: Write the failing configuration test**

```ts
// packages/gateway/tests/config.test.ts
import { describe, expect, test } from "bun:test";
import { defineGateway, GatewayConfigError, resolveGatewayConfig } from "../index";

const valid = defineGateway({
    microservices: [
        { name: "pharmacie", upstream: "http://pharmacie:4000" },
        { name: "stats", upstream: "https://stats.internal" },
    ],
});

describe("resolveGatewayConfig", () => {
    test("applies the defaults and indexes the microservices", () => {
        const config = resolveGatewayConfig(valid);
        expect(config.port).toBe(8080);
        expect(config.timeoutMs).toBe(30_000);
        expect(config.microservices).toHaveLength(2);
    });

    test("refuses a duplicate microservice name", () => {
        expect(() =>
            resolveGatewayConfig(
                defineGateway({
                    microservices: [
                        { name: "stats", upstream: "http://a:4000" },
                        { name: "stats", upstream: "http://b:4000" },
                    ],
                }),
            ),
        ).toThrow(GatewayConfigError);
    });

    test("refuses a name that is not a safe URL segment", () => {
        expect(() =>
            resolveGatewayConfig(defineGateway({ microservices: [{ name: "a/b", upstream: "http://a:4000" }] })),
        ).toThrow(GatewayConfigError);
    });

    test("refuses an upstream with a path, a query, or a non-http scheme", () => {
        for (const upstream of ["ftp://a", "http://a/base", "http://a/?x=1", "not a url"]) {
            expect(() =>
                resolveGatewayConfig(defineGateway({ microservices: [{ name: "a", upstream }] })),
            ).toThrow(GatewayConfigError);
        }
    });

    test("refuses invalid port and timeout values", () => {
        expect(() => resolveGatewayConfig(defineGateway({ port: 0, microservices: valid.microservices }))).toThrow(
            GatewayConfigError,
        );
        expect(() =>
            resolveGatewayConfig(defineGateway({ timeoutMs: -1, microservices: valid.microservices })),
        ).toThrow(GatewayConfigError);
    });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/gateway && bun test tests/config.test.ts`
Expected: FAIL — `Cannot find module '../index'`.

- [ ] **Step 4: Implement the types and config**

`types/index.ts` exports the interfaces and `GatewayConfigError` (`name = "GatewayConfigError"`, `code = "GATEWAY_CONFIG_INVALID"`).

`lib/config.ts`:

```ts
export function defineGateway(config: GatewayConfig): GatewayConfig {
    return config;
}

export function resolveGatewayConfig(config: GatewayConfig): ResolvedGatewayConfig;
```

Validation rules:
- `microservices` is a non-empty array.
- `name` matches `/^[A-Za-z0-9][A-Za-z0-9_-]*$/` and is unique.
- `upstream` parses as `http:` or `https:`, with `pathname === "/"`, no `search`, no `hash`.
- `port` is an integer in `1..65535`, default 8080.
- `timeoutMs` is a positive integer, default 30_000.
- default logger: `console.log(JSON.stringify(entry))`.
- every failure throws `GatewayConfigError` with a message naming the offending value.

`index.ts` re-exports the types and `defineGateway`, `resolveGatewayConfig`, `GatewayConfigError`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/gateway && bun test tests/config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck**

Run: `cd packages/gateway && bunx tsc --noEmit -p tsconfig.json`
Expected: no output, exit 0.

---

### Task 2: Route matching

**Files:**
- Create: `packages/gateway/lib/router.ts`
- Test: `packages/gateway/tests/router.test.ts`

**Interfaces:**
- Consumes: `ResolvedGatewayConfig`, `GatewayMicroservice`.
- Produces: `RouteMatch { microservice: GatewayMicroservice; path: string }`, `matchMicroservice(pathname: string, config: ResolvedGatewayConfig): RouteMatch | null`.

- [ ] **Step 1: Write the failing router test**

```ts
import { describe, expect, test } from "bun:test";
import { defineGateway, resolveGatewayConfig } from "../index";
import { matchMicroservice } from "../lib/router";

const config = resolveGatewayConfig(
    defineGateway({
        microservices: [
            { name: "pharmacie", upstream: "http://pharmacie:4000" },
            { name: "stats", upstream: "http://stats:4000" },
        ],
    }),
);

describe("matchMicroservice", () => {
    test("matches the first segment and keeps the path unchanged", () => {
        const match = matchMicroservice("/api/pharmacie/collections/ordonnances/find", config);
        expect(match?.microservice.name).toBe("pharmacie");
        expect(match?.path).toBe("/api/pharmacie/collections/ordonnances/find");
    });

    test("matches without a trailing segment or slash", () => {
        expect(matchMicroservice("/api/stats", config)?.path).toBe("/api/stats");
        expect(matchMicroservice("/api/stats/", config)?.path).toBe("/api/stats/");
    });

    test("returns null outside /api and for an unknown microservice", () => {
        expect(matchMicroservice("/health", config)).toBeNull();
        expect(matchMicroservice("/api/", config)).toBeNull();
        expect(matchMicroservice("/api/inconnu/x", config)).toBeNull();
        expect(matchMicroservice("/api//x", config)).toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/gateway && bun test tests/router.test.ts`
Expected: FAIL — module `../lib/router` not found.

- [ ] **Step 3: Implement `matchMicroservice`**

Require `pathname.startsWith("/api/")`; take `pathname.slice(5).split("/")[0]`; empty → `null`; find the microservice by exact `name`; return `{ microservice, path: pathname }`. Do not decode or rewrite.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/gateway && bun test tests/router.test.ts`
Expected: PASS (3 tests).

---

### Task 3: Headers and upstream proxying

**Files:**
- Create: `packages/gateway/lib/headers.ts`
- Create: `packages/gateway/lib/proxy.ts`
- Test: `packages/gateway/tests/proxy.test.ts`

**Interfaces:**
- Consumes: `RouteMatch`.
- Produces: `buildUpstreamHeaders(request, { requestId, clientIp })`, `buildDownstreamHeaders(response)`, `proxyRequest(request, match, { timeoutMs, requestId, clientIp })`.

- [ ] **Step 1: Write the failing proxy test**

```ts
import { afterEach, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { proxyRequest } from "../lib/proxy";
import type { RouteMatch } from "../lib/router";

const microservice = { name: "pharmacie", upstream: "http://127.0.0.1:1" };
let server: ReturnType<typeof Bun.serve> | undefined;
let received: { method: string; headers: Headers; body: string } | undefined;

function start(fetch: (req: Request) => Response | Promise<Response>): string {
    server = Bun.serve({ port: 0, fetch });
    return server.url.origin;
}

function match(upstream: string): RouteMatch {
    return { microservice: { ...microservice, upstream }, path: "/api/pharmacie/echo" };
}

afterEach(() => {
    server?.stop(true);
    server = undefined;
    received = undefined;
});

test("forwards method, body, authorization and tracing headers", async () => {
    const upstream = start(async (req) => {
        received = { method: req.method, headers: req.headers, body: await req.text() };
        return Response.json({ ok: true });
    });

    const request = new Request("http://gateway/api/pharmacie/echo?x=1", {
        method: "POST",
        headers: {
            authorization: "Bearer token",
            "content-type": "application/json",
            connection: "keep-alive",
        },
        body: JSON.stringify({ hello: "world" }),
    });

    const response = await proxyRequest(request, match(upstream), {
        timeoutMs: 1000,
        requestId: "req-1",
        clientIp: "127.0.0.1",
    });

    expect(response.status).toBe(200);
    expect(received?.method).toBe("POST");
    expect(received?.body).toBe('{"hello":"world"}');
    expect(received?.headers.get("authorization")).toBe("Bearer token");
    expect(received?.headers.get("connection")).toBeNull();
    expect(received?.headers.get("x-request-id")).toBe("req-1");
    expect(received?.headers.get("x-forwarded-for")).toContain("127.0.0.1");
});

test("keeps a compressed upstream body and its content-encoding", async () => {
    const upstream = start(
        () =>
            new Response(gzipSync("hello"), {
                headers: { "content-encoding": "gzip", "content-type": "text/plain" },
            }),
    );

    const response = await proxyRequest(new Request("http://gateway/api/pharmacie/echo"), match(upstream), {
        timeoutMs: 1000,
        requestId: "req-2",
    });

    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(Buffer.from(await response.bytes()).toString()).not.toBe("hello");
});

test("preserves multiple Set-Cookie headers", async () => {
    const upstream = start(() => {
        const headers = new Headers();
        headers.append("set-cookie", "a=1; Path=/");
        headers.append("set-cookie", "b=2; Path=/");
        return new Response("ok", { headers });
    });

    const response = await proxyRequest(new Request("http://gateway/api/pharmacie/echo"), match(upstream), {
        timeoutMs: 1000,
        requestId: "req-3",
    });

    expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
});

test("streams the request body without buffering", async () => {
    const upstream = start(async (req) => {
        received = { method: req.method, headers: req.headers, body: await req.text() };
        return new Response("ok");
    });

    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode("part1"));
            controller.enqueue(new TextEncoder().encode("part2"));
            controller.close();
        },
    });
    const request = new Request("http://gateway/api/pharmacie/echo", {
        method: "POST",
        body,
        duplex: "half",
    } as RequestInit);

    await proxyRequest(request, match(upstream), { timeoutMs: 1000, requestId: "req-4" });
    expect(received?.body).toBe("part1part2");
});

test("does not touch an event-stream body", async () => {
    const upstream = start(
        () =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode("data: one\n\n"));
                        setTimeout(() => {
                            controller.enqueue(new TextEncoder().encode("data: two\n\n"));
                            controller.close();
                        }, 100);
                    },
                }),
                { headers: { "content-type": "text/event-stream" } },
            ),
    );

    const response = await proxyRequest(new Request("http://gateway/api/pharmacie/events"), match(upstream), {
        timeoutMs: 5000,
        requestId: "req-5",
    });
    const reader = response.body!.getReader();
    const first = await reader.read();

    expect(new TextDecoder().decode(first.value)).toBe("data: one\n\n");
    await reader.cancel();
});

test("forwards 204 with a null body", async () => {
    const upstream = start(() => new Response(null, { status: 204 }));
    const response = await proxyRequest(new Request("http://gateway/api/pharmacie/echo"), match(upstream), {
        timeoutMs: 1000,
        requestId: "req-6",
    });

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
});

test("maps connection failures to 502 and header timeouts to 504", async () => {
    const unreachable = await proxyRequest(
        new Request("http://gateway/api/pharmacie/echo"),
        match("http://127.0.0.1:1"),
        { timeoutMs: 1000, requestId: "req-7" },
    );
    expect(unreachable.status).toBe(502);

    const slow = start(async () => {
        await Bun.sleep(200);
        return new Response("late");
    });
    const timedOut = await proxyRequest(new Request("http://gateway/api/pharmacie/echo"), match(slow), {
        timeoutMs: 50,
        requestId: "req-8",
    });
    expect(timedOut.status).toBe(504);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/gateway && bun test tests/proxy.test.ts`
Expected: FAIL — module `../lib/proxy` not found.

- [ ] **Step 3: Implement headers**

`lib/headers.ts`:
- `HOP_BY_HOP` set: `connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`.
- `buildUpstreamHeaders(request, { requestId, clientIp })`: copy the request headers, delete hop-by-hop and `host`; set `x-request-id`; set `x-forwarded-proto` from the existing header or the request URL protocol without `:`; set `x-forwarded-host` from `host`; append `clientIp` to `x-forwarded-for` when present.
- `buildDownstreamHeaders(response)`: copy headers except hop-by-hop; copy `set-cookie` with `response.headers.getSetCookie()` (one `append` per cookie).

- [ ] **Step 4: Implement `proxyRequest`**

- Build `new URL(match.path, match.microservice.upstream)`.
- Send `request.body` only for methods other than `GET`/`HEAD`; pass `decompress: false`, `redirect: "manual"`, `duplex: "half"` when a body is present.
- Abort on timeout with an `AbortController`; clear the timer as soon as the headers arrive (the body is not timed). Also combine `request.signal` so a client disconnect aborts the upstream.
- Catch: timeout → `504 { code: "UPSTREAM_TIMEOUT" }`; other fetch failures → `502 { code: "UPSTREAM_UNAVAILABLE" }`.
- Response: `new Response(status === 204 || status === 304 ? null : upstream.body, { status, statusText, headers: buildDownstreamHeaders(upstream) })`.

- [ ] **Step 5: Run the proxy test to verify it passes**

Run: `cd packages/gateway && bun test tests/proxy.test.ts`
Expected: PASS (8 tests). If the compression test fails, confirm `decompress: false` is actually passed to `fetch`.

---

### Task 4: HTTP server

**Files:**
- Create: `packages/gateway/lib/server.ts`
- Test: `packages/gateway/tests/server.test.ts`

**Interfaces:**
- Consumes: `resolveGatewayConfig`, `matchMicroservice`, `proxyRequest`.
- Produces: `createGateway(config: GatewayConfig): Gateway` with `{ server, config, stop(force?) }`.

- [ ] **Step 1: Write the failing server test**

```ts
import { afterEach, expect, test } from "bun:test";
import { createGateway } from "../index";
import type { GatewayLogEntry } from "../index";

let gateway: ReturnType<typeof createGateway> | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
    gateway?.stop(true);
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
        logger: (entry) => logs.push(entry),
    });

    const routed = await fetch(`${gateway.server.url}api/pharmacie/collections/x/find`);
    expect(await routed.json()).toEqual({ from: "pharmacie" });

    const health = await fetch(`${gateway.server.url}health`);
    expect(await health.json()).toEqual({ status: "ok", microservices: ["pharmacie"] });

    const unknown = await fetch(`${gateway.server.url}api/unknown/x`);
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).code).toBe("MICROSERVICE_NOT_FOUND");

    expect(logs.map((entry) => entry.status)).toEqual([200, 404]);
    expect(logs[0]?.microservice).toBe("pharmacie");
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/gateway && bun test tests/server.test.ts`
Expected: FAIL — `createGateway` is not exported.

- [ ] **Step 3: Implement `createGateway`**

- Resolve the config once.
- Build a Hono app: `GET /health` returns `{ status: "ok", microservices: names }`; every other path goes through a single `app.all("*")` handler.
- Handler: `matchMicroservice(new URL(request.url).pathname, resolved)`; if null → `404 { code: "MICROSERVICE_NOT_FOUND", message: "..." }`; else read `x-request-id` or generate `crypto.randomUUID()`, resolve `clientIp` with `getConnInfo(c).remote.address` (catch and leave `undefined`), call `proxyRequest`, then log `{ requestId, method, path, microservice, upstream, status, durationMs }` through the config logger.
- Start `Bun.serve({ port: resolved.port, fetch: (request, server) => app.fetch(request, server) })`.
- Return `{ server, config: resolved, stop: (force = true) => server.stop(force) }`.
- Export `createGateway` and `Gateway` from `index.ts`.

- [ ] **Step 4: Run the server test to verify it passes**

Run: `cd packages/gateway && bun test tests/server.test.ts`
Expected: PASS (2 tests).

---

### Task 5: Config file loader and CLI

**Files:**
- Create: `packages/gateway/lib/configFile.ts`
- Create: `packages/gateway/bin/gateway.ts`
- Create: `packages/gateway/tests/fixtures/gateway.config.ts`
- Test: `packages/gateway/tests/configFile.test.ts`

**Interfaces:**
- Produces: `loadGatewayConfig(path: string): Promise<GatewayConfig>`.
- CLI: `anteros-gateway [configPath]`, default `./gateway.config.ts`.

- [ ] **Step 1: Write the failing loader test**

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadGatewayConfig } from "../lib/configFile";

describe("loadGatewayConfig", () => {
    test("imports the default export of a TypeScript config", async () => {
        const config = await loadGatewayConfig(join(import.meta.dir, "fixtures/gateway.config.ts"));
        expect(config.microservices[0]?.name).toBe("pharmacie");
        expect(config.port).toBe(0);
    });

    test("refuses a module without a default config", async () => {
        await expect(loadGatewayConfig(join(import.meta.dir, "fixtures/empty.ts"))).rejects.toThrow();
    });
});
```

Add `tests/fixtures/gateway.config.ts`:

```ts
import { defineGateway } from "../../index";

export default defineGateway({
    port: 0,
    microservices: [{ name: "pharmacie", upstream: "http://127.0.0.1:4000" }],
});
```

Add `tests/fixtures/empty.ts` with `export const nothing = true;`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/gateway && bun test tests/configFile.test.ts`
Expected: FAIL — module `../lib/configFile` not found.

- [ ] **Step 3: Implement the loader and the CLI**

`lib/configFile.ts`: resolve the path against `process.cwd()`, `await import(pathToFileURL(resolved).href)`, require a default export, return it. Throw a `GatewayConfigError` naming the path when it is missing or has no default export.

`bin/gateway.ts`: shebang `#!/usr/bin/env bun`; read `process.argv[2] ?? "./gateway.config.ts"`; `loadGatewayConfig`; `createGateway`; log `Anteros Gateway listening on <server.url>`; on `SIGINT`/`SIGTERM`, `stop(true)` and exit 0.

- [ ] **Step 4: Run the loader test to verify it passes**

Run: `cd packages/gateway && bun test tests/configFile.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Manual CLI smoke test**

Run: `cd packages/gateway && bun bin/gateway.ts tests/fixtures/gateway.config.ts`
Expected: prints a listening URL; a second terminal can `curl <url>health` and get `{"status":"ok","microservices":["pharmacie"]}`; `Ctrl+C` exits cleanly.

---

### Task 6: Documentation and changelog

**Files:**
- Create: `packages/gateway/README.md`
- Create: `docd/content/docs/07.packages/03.gateway.md`
- Modify: `README.md` (packages table)
- Modify: `docd/content/docs/08.changelog/01.changelog.md` (`[Unreleased] / Added`)
- Create: `.memory/gateway.md`, modify `.memory/README.md`

- [ ] **Step 1: Write the package README**

Sections: what it is (reverse proxy, **not** an API gateway), install, config example, routing contract (`name` = path segment = Anteros tenant id), proxy behavior (headers, streaming, SSE, timeout), limits (no auth/rate limit/retry/WebSocket), security (not a trust boundary; platform token rules live in the backends), tests.

- [ ] **Step 2: Write the docd page**

Frontmatter:

```yaml
---
title: Gateway
description: "@anteros/gateway — a passive reverse proxy that routes /api/<microservice>/… to Anteros deployments."
navigation:
  icon: lucide:network
---
```

Sections: What it is, Configuration, Routing, What the proxy does, Token contract (platform token without a tenant claim), Security, Limits. State explicitly that it does no control and that the auth backend and `api.access` do.

- [ ] **Step 3: Update the root README and changelog**

Add to the packages table:

```md
| `@anteros/gateway` | Passive reverse proxy — routes `/api/<microservice>/…` to separate Anteros deployments |
```

Add an `[Unreleased] / Added` bullet summarising the package, the routing contract, the passive behavior, the 10 tests and the security caveat (platform token + `api.access`).

- [ ] **Step 4: Write `.memory/gateway.md` and index it**

Frontmatter and a dated entry covering: the name is a product name, the role is reverse proxy; `name` = URL segment = Anteros tenant id; `decompress: false` is required; multiple `Set-Cookie` via `getSetCookie()`; timeout covers headers only; the gateway is not a trust boundary. Add the row to `.memory/README.md`.

- [ ] **Step 5: Verify the documentation build**

Run: `cd docd && bun run generate`
Expected: route count increases by one, `/docs/packages/gateway` is prerendered, no 404.

- [ ] **Step 6: Final verification**

Run: `cd packages/gateway && bun test && bunx tsc --noEmit -p tsconfig.json`
Expected: all tests pass, typecheck clean.

---

## Self-Review Notes

- **Spec coverage:** config, routing, proxy behavior, timeout semantics, platform-token contract, backend contract, security, limits, CLI and docs each have a task. The auth backend and application changes are documented, not built, as the spec states.
- **Type consistency:** `GatewayConfig` → `ResolvedGatewayConfig` → `RouteMatch` → `proxyRequest` → `createGateway`; names are used identically across tasks.
- **Review Focus coverage:** compression, `Set-Cookie`, streamed request body, SSE and 204 are each pinned by a test in Task 3.
- **No commit steps** on purpose: the user has not asked for commits; changes stay in the working tree.
