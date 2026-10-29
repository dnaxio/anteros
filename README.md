# Anteros

A backend framework for **Bun**, with **MongoDB** as its database: multi-tenant by design, typed end to end, and
batteries included — collections, services, routes, hooks, scripts, workflows, WebSockets, session variables,
file storage, LLM agents and an MCP surface.

```ts
import { app } from "@anteros/core";

app.boot({
  server: { port: 4000 },
  tenants: [
    {
      id: "v1",
      dir: "v1",
      database: { uri: "mongodb://localhost:27017/mydb" },
    },
  ],
});
```

## Requirements

- **Bun** — the runtime and the package manager (the server boots with `bun run`)
- **MongoDB** — one database per tenant

## Quick start

Scaffold a project with the CLI:

```bash
bunx @anteros/cli create server my-api
cd my-api
bun install
bun run dev
```

Or start from an empty folder:

```bash
mkdir my-api && cd my-api
bun init -y
bun add @anteros/core@latest
```

The entry file lives at the project root (`index.ts`, next to `package.json`); the tenant code lives in its own
folder (`v1/collections`, `v1/routes`, `v1/services`, `v1/ai/agents`…):

```ts
// v1/collections/items.model.ts
import { define } from "@anteros/core";

export default define.Collection({
  slug: "items",
  fields: [
    { name: "name", type: "string", required: true },
    { name: "price", type: "number", required: true },
  ],
});
```

```bash
bun run index.ts
# POST /api/v1/collections/items/insertOne
```

## Packages

| Package | What it is |
| --- | --- |
| `@anteros/core` | The framework: server, collections, services, routes, hooks, scripts, workflows, agents |
| `@anteros/cli` | The `anteros` binary — `create`, `dev`, `doctor` |
| `@anteros/sdk` | Typed client for the HTTP API |
| `@anteros/duckdb` | DuckDB over the Quack protocol — instance, attached client, server, the `antd` CLI, FTS, VSS, retention |

Agents and their tools live under `{tenant.dir}/ai/`:

```text
v1/ai/
├── agents/
│   ├── support.agent.ts    # define.Agent
│   └── support.tool.ts     # its tools, same directory, same basename
└── mcp/
    ├── tools/**/*.tool.ts
    └── resources/**/*.resource.ts
```

## Documentation

The documentation site is a Nuxt application in `docd/`:

```bash
cd docd
bun install
bunx nuxi dev
```

It covers the HTTP API, the query language, the SDK, workflows, replication, audit, agents (memory, tools,
MCP, semantic recall) and the DuckDB/Quack packages.

## Development

```bash
bun install          # workspaces: packages/*, demo/
bun test             # the whole test suite (some suites expect a local MongoDB)
```

Per-package type checking:

```bash
bunx tsc --noEmit -p packages/duckdb/tsconfig.json
```

## License

MIT — see [LICENSE](./LICENSE). Copyright (c) 2026 Dnax Inc.

## Security

Do **not** open a public issue for a vulnerability. Report it privately through GitHub's
**Security → Report a vulnerability** advisory on the repository, and read [SECURITY.md](./SECURITY.md) for
what to include, supported versions and scope.
