# @dnax/core

Server core for **multi-tenant** apps: generic **MongoDB** REST API, **Joi** validation, hooks, JWT auth, custom routes, and boot scripts. Built for **Bun** with **Hono** and **Socket.io**.

## Requirements

- [Bun](https://bun.sh) (recommended runtime for this package)
- A reachable MongoDB instance (per-tenant URI)
- TypeScript (peer dependency)

## Installation

```bash
bun add @dnax/core@0.0.0-rc.13
```

## Quick start

Typical entrypoint in your app (working directory = project root that contains tenant folders):

```ts
import { app, define } from "@dnax/core";

await app.boot({
  clusterMode: false,
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
| `utils` | Internal utilities exposed by the package |

## Folder layout (per tenant)

**`dir` is required** on every tenant: it is the path (relative to the project root) under which the folders below are resolved.

Paths are relative to `tenant.dir` (e.g. `v1/` when `id` and `dir` are `v1`):

| Path | Contents |
|------|----------|
| `collections/**/*.model.ts` | Collection models (`define.Collection({ ... })`) |
| `routes/**/*.route.ts` | Custom HTTP routes (`define.Route({ ... })`), requires `tenant.routes.prefix` |
| `scripts/**/*.run.ts` | Startup scripts (`define.Script({ ... })`) |

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

## Server configuration

Common options when calling `app.boot`:

- `clusterMode` — Bun `reusePort` for multiple workers
- `server.port`, `server.name`
- `server.cors` — origins, credentials, headers, and methods
- `server.ipRestriction` — allow/deny lists (Hono)
- `server.jwt` — secret and token lifetime

## Socket.io

The server mounts **Socket.io** at `/socket.io/`. Route handlers receive the `io` instance for real-time subscriptions.

## Environment variables

| Variable | Usage |
|----------|--------|
| `JWT_SECRET` | JWT signing when not set in config |
| `NODE_ENV` / `Bun.env.NODE_ENV` | Environment label at boot |
| `APP_NAME` | Server name when `server.name` is omitted |

## License

See the parent repository for the project license.
