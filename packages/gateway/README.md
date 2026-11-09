# @anteros/gateway

A **passive L7 reverse proxy** for Anteros microservices. It routes `/api/<microservice>/…`
to the Anteros deployment declared for that name, and nothing else.

> Not an API gateway: no authentication, no rate limiting, no request transformation, no
> aggregation, no path rewriting. TLS, WAF and WebSocket stay at Caddy/Traefik in front.

## Install

```bash
bun add @anteros/gateway
```

## Configuration

```ts
import { defineGateway } from "@anteros/gateway";

export default defineGateway({
  port: 8080,
  microservices: [
    { name: "auth", upstream: "http://auth:4000" },
    { name: "pharmacie", upstream: "http://pharmacie:4000" },
    { name: "facturation", upstream: "http://facturation:4000" },
    { name: "stats", upstream: "http://stats:4000" },
  ],
  timeoutMs: 30_000,
  cors: {
    origins: ["https://app.example.com"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    headers: ["authorization", "content-type"],
    exposeHeaders: ["x-request-id"],
    credentials: false,
    maxAge: 600,
  },
  logging: {
    enabled: true,
    microservices: ["pharmacie", "facturation"], // "*" for every microservice
    name: "gateway",
    fields: { env: "prod", instance: "gw-1", version: "0.0.1" },
  },
});
```

`name` is the first URL segment **and** the Anteros tenant id the backend expects: the path
is forwarded unchanged, so `name: "pharmacie"` receives `/api/pharmacie/…`.

## Run

```bash
bunx anteros-gateway ./gateway.config.ts
# or, from the repository:
bun run packages/gateway/bin/gateway.ts ./gateway.config.ts
```

`SIGINT` / `SIGTERM` stop the server cleanly.

## Routing

| Request | Result |
| --- | --- |
| `POST /api/pharmacie/collections/ordonnances/insertOne` | forwarded to `http://pharmacie:4000` on the same path |
| `GET /api/stats/…` | forwarded to the `stats` upstream |
| `/health` | local `{ "status": "ok", "microservices": [...] }` |
| anything else, or an unknown name | `404 { "code": "MICROSERVICE_NOT_FOUND" }`, no upstream call |

No wildcard, no regex, no client-supplied upstream.

## What the proxy does

- Forwards method, path, query, body, `authorization`, cookies and application headers.
- Removes hop-by-hop headers in both directions (`connection`, `te`, `transfer-encoding`,
  `upgrade`, …) and `host`.
- Adds `x-forwarded-for`, `x-forwarded-proto`, `x-forwarded-host` and `x-request-id`
  (reuses an incoming request id).
- Streams request and response bodies; SSE passes through untouched.
- Calls `fetch(..., { decompress: false })` so a compressed upstream body keeps its
  `content-encoding`.
- `timeoutMs` covers connection and **upstream response headers** only; a stream is never
  cut by it.
- `502 UPSTREAM_UNAVAILABLE` when the upstream is unreachable, `504 UPSTREAM_TIMEOUT` when
  its headers are late. No retries.

## Request logs

One JSON line per request — **timestamp** (ISO 8601 UTC, when the request was received),
method, path, microservice, upstream, status, duration, request id. Add `durationMs` to the
timestamp to get the end. Never the token, the cookie or the body.

```json
{"timestamp":"2026-11-08T12:34:56.789Z","level":"info","logger":"gateway","requestId":"6f1c…","method":"POST","path":"/api/pharmacie/collections/x/find","microservice":"pharmacie","upstream":"http://pharmacie:4000","status":200,"durationMs":12,"env":"prod","instance":"gw-1"}
```

- `level` is `error` for a 5xx response and `info` otherwise.
- `logger` is `logging.name` (default `gateway`).
- `logging.fields` are copied onto every line; they cannot shadow a gateway field.

```ts
logging: {
  enabled: true,                                  // default true; false logs nothing
  microservices: ["pharmacie", "facturation"],    // default "*" (every microservice)
}
```

- `"*"` logs every routed request.
- An array restricts the logs to those microservices; the others still work, they are just
  not logged.
- A 404 has no microservice: it is logged only when the scope is `"*"`.
- `logger` replaces the default `console.log(JSON.stringify(entry))` sink.
- An unknown name in `microservices` is a startup error (`GATEWAY_CONFIG_INVALID`).

### Capturing request bodies

Off by default. `captureBody: true` uses the safe defaults; an object tunes them.

```ts
logging: {
  captureBody: {
    maxBytes: 4096,                       // only bodies with Content-Length ≤ this
    methods: ["POST", "PUT", "PATCH", "DELETE"],
    contentTypes: ["application/json", "application/x-www-form-urlencoded", "text/"],
    redact: ["password", "token", "secret", "authorization"], // extended default list
  },
}
```

- The body is logged as `requestBody`: a parsed JSON object, a form object, or a string.
- Sensitive keys are redacted at any depth (`[redacted]`); `redact: []` disables redaction
  (not recommended).
- Only bodies with a `Content-Length` at or below `maxBytes` and a textual content type are
  captured. Chunked, multipart and binary bodies are skipped.
- The copy is read from `request.clone()`: what the upstream receives is unchanged.
- In DuckDB the body lives in `raw`; query `raw::JSON->>'requestBody'`.
- Bodies can contain personal data or secrets. Enable this deliberately, keep redaction, bound
  `maxBytes`, and keep the retention (`ttl`) short.

### Where the logs are stored

`logging.engine` chooses the sink. The short names are the defaults; they live under `.logs/`,
which is git-ignored. Use a long name such as `gateway.jsonl` if you prefer the format in the
extension.

| `engine` | Destination | Default path |
| --- | --- | --- |
| `stdout` (default) | one JSON object per line on stdout | — |
| `file` | JSONL, one object per line | `.logs/gateway.log` |
| `duckdb` | a DuckDB database, table `logs` | `.logs/gateway.duckdb` |

```ts
logging: { engine: "file" }                     // .logs/gateway.log
logging: { engine: "file", file: "gateway.jsonl" }
logging: { engine: "duckdb" }                   // .logs/gateway.duckdb
logging: { engine: "duckdb", file: "/var/log/gateway.duckdb" }
```

`logging.file` is relative to the process working directory unless absolute.

**stdout** — storage and retention belong to the runtime: Docker `json-file` (`max-size` /
`max-file`), systemd journald, Kubernetes, or a collector (Vector, Fluent Bit, Promtail →
Loki/Elastic/Datadog).

**file** — JSONL. Rotation is configurable:

```ts
logging: {
  engine: "file",
  rotate: "size",        // size | hourly | daily | weekly | monthly | yearly
  maxSize: "10m",        // size mode only; default 10 MB ("500k", "1g", bytes)
  maxFiles: 5,           // archives kept; default 5
  compress: true,        // gzip each archive; default false
}
```

Archives, for a live `gateway.log`:

| Mode | Example |
| --- | --- |
| `size` | `gateway-2026-11-09-1.log` |
| `hourly` | `gateway-2026-11-09-14.log` |
| `daily` | `gateway-2026-11-09.log` |
| `weekly` | `gateway-2026-W45.log` |
| `monthly` | `gateway-2026-11.log` |
| `yearly` | `gateway-2026.log` |

With `compress: true` the archives end in `.gz`. Calendar archives are pruned by name
(chronological), size archives by mtime; the live file is never deleted. `rotate` is only valid
with the `file` engine, and `maxSize` only with `rotate: "size"`.

**duckdb** — table `logs`:

| Column | Type |
| --- | --- |
| `timestamp` | `VARCHAR` (ISO 8601) |
| `level`, `logger`, `request_id`, `method`, `path`, `microservice`, `upstream` | `VARCHAR` |
| `status` | `INTEGER` |
| `duration_ms` | `BIGINT` |
| `fields` | `VARCHAR` (JSON of the custom `logging.fields`) |
| `raw` | `VARCHAR` (the whole entry as JSON) |

The database opens asynchronously: `await gateway.ready` before sending traffic (the CLI does).
Rows are buffered by the DuckDB appender, flushed every 100 entries and on `stop()`.

```sql
SELECT timestamp, level, microservice, status, duration_ms, path
FROM logs ORDER BY timestamp DESC LIMIT 50;

SELECT raw::JSON->>'requestId' AS request_id
FROM logs WHERE level = 'error';
```

**Retention (TTL)** — delete rows older than a duration, with a periodic purge:

```ts
logging: {
  engine: "duckdb",
  ttl: "7d",           // 500ms, 30m, 24h, 7d, 2w
  purgeEvery: "1h",    // default 1h
  purgeOnStart: true,  // default true
}
```

The purge runs `DELETE FROM logs WHERE CAST(timestamp AS TIMESTAMP) < cutoff`, flushes the
appender first, and its timer is `unref()`ed. Without `ttl`, nothing is purged and the database
grows. `ttl` is only valid with the `duckdb` engine; `purgeEvery` / `purgeOnStart` require `ttl`.
Deleted rows free space for reuse, but DuckDB does not necessarily shrink the file on disk.

`stop()` is async — it flushes and closes the sink:

```ts
await gateway.stop();
```

A custom `logger` remains available (stdout engine only); it cannot be combined with `file` or
`duckdb`. A sink that throws is caught and reported on stderr — it never fails a request.

| Setting | Default | Role |
| --- | --- | --- |
| `logging.enabled` | `true` | Master switch |
| `logging.microservices` | `"*"` | Which services are logged |
| `logging.name` | `gateway` | `logger` field |
| `logging.fields` | `{}` | Static fields on every line |
| `logging.engine` | `stdout` | `stdout`, `file` or `duckdb` |
| `logging.file` | `.logs/gateway.log` / `.logs/gateway.duckdb` | Destination path |
| `logging.rotate` | off | `size`, `hourly`, `daily`, `weekly`, `monthly`, `yearly` |
| `logging.maxSize` | `10m` | Size threshold (size mode only) |
| `logging.maxFiles` | `5` | Archives kept |
| `logging.compress` | `false` | Gzip archives |
| `logging.ttl` | — | DuckDB retention (`7d`, `24h`…) |
| `logging.purgeEvery` | `1h` | DuckDB purge interval |
| `logging.purgeOnStart` | `true` | Purge when the database opens |
| `logging.captureBody` | off | Capture request bodies (`true` or options) |
| `logger` | JSON on stdout | Custom sink (stdout only) |

## CORS

CORS is **opt-in**: omit `cors` (or set it to `false`) and the upstream headers pass through
untouched. When you set it, the gateway owns the policy:

```ts
cors: {
  origins: ["https://app.example.com"],   // or "*" (not with credentials)
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  headers: ["authorization", "content-type"], // omitted → echo Access-Control-Request-Headers
  exposeHeaders: ["x-request-id"],
  credentials: false,
  maxAge: 600,
}
```

- A browser preflight (`OPTIONS` + `Origin` + `Access-Control-Request-Method`) is answered
  **locally**, with no upstream call.
- Actual responses get the policy, and the upstream `access-control-*` headers are **removed**
  — two `Access-Control-Allow-Origin` values make browsers reject the response.
- A disallowed origin gets no CORS headers (the browser blocks); the request is still proxied.
- `credentials: true` is refused with `origins: "*"`.
- Once the gateway owns CORS, disable CORS in the backends to keep one authority.

The policy is also **per microservice**: `microservice.cors` overrides the global `cors`, and
`cors: false` opts a service out (pass-through), even when the global policy is enabled.

```ts
cors: { origins: ["https://app.example.com"] }, // default for services without an override

microservices: [
  { name: "pharmacie", upstream: "http://pharmacie:4000", cors: { origins: ["https://pharmacie.example.com"] } },
  { name: "facturation", upstream: "http://facturation:4000" }, // inherits the global policy
  { name: "stats", upstream: "http://stats:4000", cors: false }, // pass-through, upstream owns CORS
],
```

Precedence: `microservice.cors` (object or `false`) → global `cors` → pass-through. A 404 has no
microservice and uses the global policy.

## What it does not do

No JWT verification, no authentication, no authorization, no rate limiting, no retries, no
cache, no aggregation, no rewrite, no WebSocket proxying. The gateway is **not a trust
boundary**: backends must stay on a private network and enforce their own access rules.

## Token contract

With a platform login (one auth backend signing for several Anteros deployments), the token
is HS256 with the shared `JWT_SECRET`, carries **no** `tenant` claim, and lists per-tenant
roles:

```json
{
  "sub": "usr_123",
  "roles": { "pharmacie": ["admin"], "facturation": ["reader"], "stats": ["reader"] },
  "iss": "auth",
  "aud": "anteros-platform",
  "exp": 1730000900
}
```

Each Anteros backend verifies the signature (Hono does it) and enforces roles in
`api.access`. No rules means denied; `access: { "*": true }` allows anonymous requests, so
never use it on a protected collection. The auth backend is your application — this package
does not issue tokens.

## Tests

```bash
cd packages/gateway
bun test
bunx tsc --noEmit -p tsconfig.json
```
