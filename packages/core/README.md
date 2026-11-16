# @anteros/core

Server core for **multi-tenant** apps: generic **MongoDB** REST API, **Joi** validation, hooks, JWT auth, custom routes, and boot scripts. Built for **Bun** with **Hono** and **Socket.io**.

## Requirements

- [Bun](https://bun.sh) (recommended runtime for this package)
- A reachable MongoDB instance (per-tenant URI)
- TypeScript (peer dependency)

## Installation

```bash
bun add @anteros/core@latest
```

## Quick start

Typical entrypoint in your app (working directory = project root that contains tenant folders):

```ts
import { app, define } from "@anteros/core";

await app.boot({
  server: {
    port: 5000,
    jwt: {
      secret: process.env.JWT_SECRET, // or JWT_SECRET env var
      expiresIn: "1h",
    },
    cors: {
      origin: ["http://localhost:3000"],
      credentials: true,
    },
  },
  tenants: [
    {
      id: "v1",
      dir: "v1", // relative path to tenant code (collections, routes, scripts)
      routes: { prefix: "/api/v1" }, // required for loading declared routes
      database: {
        uri: "mongodb://localhost:27017/my_database",
      },
    },
  ],
});
```

On boot, the server syncs tenants, loads collections (`*.model.ts`), registers routes (`*.route.ts`), starts HTTP/WebSocket, then runs enabled scripts (`*.run.ts`).

## Public exports

| Export | Purpose |
|--------|---------|
| `define` | Factories: `define.Collection`, `define.Route`, `define.Script`, `define.Server` / `define.App` |
| `app` | `{ boot }` — starts the application |
| `useRest` | REST client / per-tenant Mongo access (programmatic use or in handlers) |
| `v` | **Joi** (re-export), for schemas in models |
| `cache` | Native caching: `useMemoryCache`, `useFilesystemCache`, `useRedisCache` (Bun.Redis) |
| `utils` | Internal utilities exposed by the package |
| `builtinToolsFor` · `BUILTIN_TOOL_NAMES` | The built-in agent tools (`read_file`, `shell`, `spawn`…), outside an agent |
| `tasks` | The scheduled-task registry: `list`, `get`, `update`, `run`, `ids`, `stats` |

## Folder layout (per tenant)

**`dir` is required** on every tenant: it is the path (relative to the project root) under which the folders below are resolved.

Paths are relative to `tenant.dir` (e.g. `v1/` when `id` and `dir` are `v1`):

| Path | Contents |
|------|----------|
| `collections/**/*.model.ts` | Collection models (`define.Collection({ ... })`) |
| `routes/**/*.route.ts` | Custom HTTP routes (`define.Route({ ... })`), requires `tenant.routes.prefix` |
| `scripts/**/*.run.ts` | Startup scripts (`define.Script({ ... })`) |
| `tasks/**/*.task.ts` | Scheduled tasks (`define.Task({ ... })`), armed with `Bun.cron` |

## Generic HTTP API

A single route handles collection operations:

```http
POST /api/:tenant_id/:collection/:action
Content-Type: application/json
```

Example `action` values: `find`, `findOne`, `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `findOneAndUpdate`, `aggregate`, `login`, `logout`, plus **named actions** declared on the model.

Typical JSON bodies: `{ "data": ... }`, `{ "params": ... }`, `{ "pipeline": ... }`, `{ "payload": ... }` (login), depending on the action.

The tenant must exist in config; the collection must be registered via a `*.model.ts` file.

### JWT and `Authorization` header

If the client sends `Authorization: Bearer <jwt>`, the core **verifies** it before your route handler runs. Invalid or expired tokens return **401** immediately.

When verification succeeds, the Hono context exposes:

| Field | Meaning |
|-------|--------|
| `token.value` | Raw JWT string (same as in the header) |
| `token.decoded` | Verified payload (claims), e.g. `sub`, `role` |

If there is **no** `Authorization` header, `token` is not set on the context. Collection **`api.access`** functions receive:

```ts
token: {
  value: string | null;       // raw JWT, or null if no Bearer was sent
  decoded: Record<string, unknown> | null; // verified claims, or null if unauthenticated
};
```

Use **`token.decoded`** for roles, `sub`, etc. Use **`token.value`** if you need the string (e.g. forwarding). Implement rules in `api.access` for each action you want to protect.

### Access control (`api.access`)

Per collection, `api.access` allows or denies each action (`boolean` or async function). Wildcard `'*'` applies when no specific rule exists for an action.

### Auth (`api.auth`)

When `api.auth.enabled` is set, define `onLogin` / `onLogout` on the model. The JWT secret is read from `server.jwt.secret` or the **`JWT_SECRET`** environment variable.

## Health & metrics

The server exposes a built-in **`GET /health`** endpoint (zero dependency) reporting live process metrics:

```json
{
  "pid": 10047,
  "startedAt": 1720000000000,
  "uptime": 3600,
  "env": "production",
  "connections": 0,
  "pendingRequests": 3,
  "pendingWebSockets": 7,
  "requests": {
    "total": 1523,
    "active": 3,
    "errors": 2,
    "byMethod": { "GET": 1200, "POST": 323 },
    "byStatus": { "200": 1500, "201": 21, "500": 2 }
  },
  "memory": { "rss": 13778944, "heapUsed": 112384, "heapTotal": 521216, "external": 10624 },
  "cpu": { "percent": 12.5, "cores": 8, "user": 120000, "system": 80000 }
}
```

| Field | Meaning |
|-------|---------|
| `pid` / `uptime` | Process id / seconds since boot |
| `requests.total` / `requests.errors` | Total requests served / responses ≥ 500 |
| `requests.byMethod` / `requests.byStatus` | Counters split by HTTP method / status |
| `memory` | V8 heap + RSS usage (bytes) |
| `pendingRequests` | Requests currently being processed |
| `pendingWebSockets` | Active WebSocket connections |
| `cpu.percent` | % of a single core over the last sample window |

With `reusePort`, each process exposes its **own** metrics — useful to see per-worker load.

## Cluster (reusePort + multiple processes)

Set `server.reusePort: true` to enable Bun's `SO_REUSEPORT`. The framework then acts as a **master**:

- Spawns N workers (`server.workers`, default = CPU count)
- Each worker serves the main port (the OS round-robins connections)
- Workers report metrics to the master **via IPC** every 5s
- The master **restarts any worker that crashes** (auto-respawn)
- The master exposes an **aggregated `/health`** on `server.metricsPort` (default: `port + 1`)

```typescript
await app.boot({
  server: {
    port: 5000,
    reusePort: true,     // cluster mode
    workers: 4,          // optional, default = CPU count
    metricsPort: 5001,   // optional, default = port + 1
  },
  // ...
});
```

```bash
curl http://localhost:5001/health   # aggregated across all workers
```

```json
{
  "status": "ok",
  "master": { "pid": 1000 },
  "workers": 4,
  "uptime": { "min": 12, "max": 15 },
  "requests": {
    "total": 1523,
    "active": 11,
    "errors": 2,
    "perSecond": 101,
    "byMethod": { "GET": 1200, "POST": 323 },
    "byStatus": { "200": 1500, "201": 21, "500": 2 }
  },
  "memory": { "rss": 54067200, "heapUsed": 589294 },
  "cpu": { "percent": 25.5, "cores": 8 },
  "pids": [1001, 1002, 1003, 1004]
}
```

> ⚠️ Each process has its own memory — use **Redis** for shared cache / Socket.io state.

## Server configuration

Common options when calling `app.boot`:

- `server.reusePort` — Bun `SO_REUSEPORT` (share the port across multiple processes)
- `server.port`, `server.name`
- `server.cors` — origins, credentials, headers, and methods
- `server.ipRestriction` — allow/deny lists (Hono)
- `server.jwt` — secret and token lifetime

## Agents — built-in tools

Agents can opt into **eleven built-in tools**, all **disabled by default**: `read_file`, `write_file`,
`edit_file`, `ls`, `grep`, `shell`, `bun`, `spawn`, `image`, `archive_file`, `browser_control`.

```ts
export default define.Agent({
  /* … */
  builtinTools: ["read_file", "grep", "shell"], // or `true` for all eleven
  builtinToolsOptions: { root: process.cwd() },  // the workspace
});
```

- **File tools** (`read_file`, `write_file`, `edit_file`, `ls`, `grep`, `image`, `archive_file`) are confined
  to `builtinToolsOptions.root` — a `..` escape, an absolute path outside, or a symlink leading outside is refused
  with `BUILTIN_TOOL_PATH_ESCAPE`.
- **`shell`, `bun` and `spawn` are not sandboxed**: they run with the process's own permissions, with the root
  as their `cwd`. Enable them only for an agent meant to act on the machine.
- Every process call has a deadline (`timeoutMs`, default 30 s) and capped output; `read_file` caps at
  `maxReadBytes`; `grep` skips files over 1 MB.
- A declared tool wins over a built-in of the same id; `tools: false` or an allow-list filters them.

`browser_control` uses `Bun.WebView` (WebKit on macOS, or `backend: "chrome"`), `image` uses `Bun.Image`, and
`archive_file` uses `Bun.Archive` (tar / tar.gz — not zip). Bun 1.4.4+ is required for those three.

Full reference — every tool, argument, default, limit and error code — in the documentation's **Built-in tools** page.

## Tasks

A tenant schedules work in `{tenant.dir}/tasks/**/*.task.ts`:

```ts
export default define.Task({
  id: "weekly-report",
  schedule: "0 10 * * MON",     // every Monday at 10:00
  timezone: "Africa/Abidjan",
  run: async ({ rest, api, logger }) => { /* … */ },
});
```

The first boot creates a `_tasks_` row per task **only when missing**; the row (`schedule`, `timezone`,
`enabled`, `lastRunAt`, `nextRunAt`…) wins over the code and survives a restart. `tasks.update(tenantId, id,
{ enabled: false })` — or a direct edit of the collection — is applied by a **change stream**, no restart.
Every run takes an atomic `lockedUntil` lock, so a cluster runs a fire once, not once per worker;
`catchUp: 'once'` replays a missed occurrence at boot.

```ts
import { tasks } from "@anteros/core";

await tasks.list("v1");
await tasks.update("v1", "weekly-report", { schedule: "0 8 * * TUE" });
await tasks.run("v1", "weekly-report");
await tasks.remove("v1", "weekly-report");   // durable: disarmed, hidden from list(), not recreated at boot
await tasks.restore("v1", "weekly-report");  // undo it
```

Full reference: the documentation's **Tasks** page (`/docs/reference/tasks`).

## Socket.io

The server mounts **Socket.io** at `/socket.io/`. Route handlers receive the `io` instance for real-time subscriptions.

## Environment variables

| Variable | Usage |
|----------|--------|
| `JWT_SECRET` | JWT signing when not set in config |
| `NODE_ENV` / `Bun.env.NODE_ENV` | Environment label at boot |
| `APP_NAME` | Server name when `server.name` is omitted |

## License

[MIT License](./LICENSE) — SPDX: `MIT`.
