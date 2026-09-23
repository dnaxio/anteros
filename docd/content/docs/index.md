---
title: Overview
description: Anteros documentation — install the framework, model your data, and ship to production.
navigation:
  icon: lucide:book-open
---

**Anteros Framework** is a robust backend server built on **Bun** as the JavaScript runtime and **MongoDB** as the database. It provides a complete suite of tools to build scalable APIs quickly with multi-tenant support, JWT authentication, real-time capabilities, and more.

```typescript
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

## Where to start

- **[Quick Start](/docs/getting-started/quick-start)** — create a minimal Anteros project and call the API in a few minutes.
- [Introduction](/docs/getting-started/introduction) — what Anteros is, the technology stack, and typical use cases.
- [Installation](/docs/getting-started/installation) and [project structure](/docs/getting-started/project-structure) — requirements and recommended repository layout.

## Sections

| Section                                                 | What it covers                                                                                                                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Getting Started](/docs/getting-started/introduction)   | Install, boot a server, project layout                                                                                                                                                                                                            |
| [Reference](/docs/reference/configuration)              | Configuration, tenants, collections, fields, hooks, authentication, access control, custom actions, files, services, WebSockets, middlewares, workflows, routes, scripts, lifecycle, caches, audit, utils, errors, crypto, replication, variables |
| [AI](/docs/ai/agents)                                   | LLM agents (instructions, tools, memory, structured output, HTTP API, SDK) and MCP servers for Claude, Cursor or VS Code                                                                                                               |
| [Manage Data](/docs/manage-data/internal-api)           | The internal `rest` API, the HTTP REST API, and the `@anteros/sdk` client                                                                                                                                                                         |
| [Query Language](/docs/query-language/query-predicates) | Query predicates, expressions, accumulators, and aggregate stages                                                                                                                                                                                 |
| [Anteros CLI](/docs/cli/installation)                   | `ant` (framework)                                                                                                                                                                                                                                 |
| [Changelog](/docs/changelog/changelog)                  | Release notes and version history                                                                                                                                                                                                                 |

## Technology stack

| Technology     | Role           | Description                                                     |
| -------------- | -------------- | --------------------------------------------------------------- |
| **Bun**        | Runtime        | Fast JavaScript/TypeScript runtime and package manager          |
| **Hono**       | Web Framework  | Ultrafast HTTP framework for routing and middleware             |
| **MongoDB**    | Database       | Document database with automatic schema validation and indexing |
| **Joi**        | Validation     | Schema validation auto-generated from field definitions         |
| **JWT (jose)** | Authentication | Stateless token-based auth with sign and verify helpers         |
| **Socket.IO**  | Real-Time      | WebSocket support available at `/socket.io/`                    |
