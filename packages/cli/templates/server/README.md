# {{name}}

An [Anteros](https://github.com/dnaxio/anteros) server — Bun runtime, MongoDB database, tenant `{{tenant}}`.

Scaffolded with [`@anteros/cli`](https://github.com/dnaxio/anteros):

```bash
anteros create server {{packageName}}
```

## Requirements

- [Bun](https://bun.com) `>= 1.3.0`
- MongoDB — local (`mongodb://localhost:27017`) or a hosted cluster

## Getting started

```bash
bun install
cp .env.example .env   # adjust MONGODB_URI / JWT_SECRET
bun run dev            # watch mode (or: bun run start)
```

The server listens on `http://localhost:{{port}}` and prints a boot banner with the
loaded tenants, collections, and the routes it registered.

## Layout

```
.
├── config/app.ts                              # boot options (server, tenants)
├── index.ts                                   # entrypoint → app.boot(config)
├── {{tenant}}/                                # tenant code root (`tenant.dir`)
│   ├── collections/items.model.ts             # collection (fields + access rules)
│   ├── routes/health.route.ts                 # custom HTTP route
│   └── mcp/tools/items-summary.tool.ts        # MCP tool for LLM clients
├── .env.example
└── package.json
```

Everything else is discovered by convention under `{{tenant}}/`: add
`services/`, `scripts/`, `sockets/`, `workflows/`, `files/`, `middlewares/`, and
`mcp/resources/` as you need them.

## Endpoints

| What | Method | URL |
| ---- | ------ | --- |
| Health | `GET` | `http://localhost:{{port}}/health` |
| Collection API | `POST` | `http://localhost:{{port}}/api/{{tenant}}/collections/items/:action` |
| Custom route | `GET` | `http://localhost:{{port}}/api/v1/healthz` |
| MCP (tools & resources) | `GET`/`POST` | `http://localhost:{{port}}/api/{{tenant}}/mcp` |
| Public config | `GET` | `http://localhost:{{port}}/_dnax/config/{{tenant}}` |

`tenant_id` in every URL is the `id` from `config/app.ts` — here `{{tenant}}`.

## Try the API

```bash
# Insert a document
curl -s -X POST http://localhost:{{port}}/api/{{tenant}}/items/insertOne \
  -H 'Content-Type: application/json' \
  -d '{"data":{"name":"First item"}}'

# List documents
curl -s -X POST http://localhost:{{port}}/api/{{tenant}}/items/find \
  -H 'Content-Type: application/json' \
  -d '{"params":{"$limit":10}}'

# Custom route
curl -s http://localhost:{{port}}/api/v1/healthz
```

## MCP

The tenant exposes its `mcp/tools/**/*.tool.ts` and `mcp/resources/**/*.resource.ts`
over the Model Context Protocol at `/api/{{tenant}}/mcp`, so agents (Claude, Cursor, VS
Code, …) can call them. Point an MCP client at:

```
http://localhost:{{port}}/api/{{tenant}}/mcp
```

## Access control

`items` ships with `api.access = { "*": true }` so you can call it immediately.
Replace that with real rules as soon as you add authentication:

```ts
api: {
  access: {
    find: true,
    insertOne: ({ token }) => !!token,
  },
}
```

## Learn more

- Framework docs, reference, and query language: <https://github.com/dnaxio/anteros>
- File uploads are stored under `storage/<tenant>/<collection>/` and are git-ignored.
