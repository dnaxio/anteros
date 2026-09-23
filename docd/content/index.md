---
title: Anteros Framework
description: The all-in-one backend framework — Bun, MongoDB, multi-tenant, AI agents, workflows, MCP tools, and more.
seo:
  title: Anteros Framework — The backend for your whole team
  description: The backend for your whole team — Bun runtime, MongoDB, multi-tenant architecture, AI agents, real-time, caching, crypto, workflows, MCP tools, files and audit trail.
---

::landing-hero{:siteName='"Anteros"' :badge='{"label":"v0.0.41","text":"Now available","href":"/docs/getting-started/quick-start"}' :headline='"Build backends at light speed."' :description='"The backend for your whole team — Bun runtime, MongoDB, multi-tenancy, realtime, caching, workflows, AI agents, MCP tools and a built-in audit trail. All in one."' :navLinks='[{"label":"Docs","href":"/docs/getting-started/introduction"},{"label":"Quick Start","href":"/docs/getting-started/quick-start"},{"label":"AI","href":"/docs/ai/agents"},{"label":"CLI","href":"/docs/cli/installation"},{"label":"Reference","href":"/docs/reference/configuration"}]' :primaryCta='{"label":"Get Started","href":"/docs/getting-started/quick-start"}' :secondaryCta='{"label":"Read the docs","href":"/docs/getting-started/introduction"}'}

::

::landing-features{:title='"Everything included."' :description='"No stitching together a router, an ORM, a queue and a scheduler."'}
::prose-card{icon="lucide:zap" title="Bun Runtime" to="/docs/getting-started/introduction"}
One of the fastest JavaScript runtimes. TypeScript native, hot reload, no build step.
::

::prose-card{icon="lucide:database" title="MongoDB Native" to="/docs/reference/collections"}
Schema validation, indexes and aggregation — declared in TypeScript, enforced in the database.
::

::prose-card{icon="lucide:layout-grid" title="Multi-Tenant" to="/docs/reference/tenants"}
Isolated databases and code folders per tenant. One server, as many tenants as you need.
::

::prose-card{icon="lucide:sparkles" title="AI Agents" to="/docs/ai/agents"}
Instructions, tools, memory and streaming — a model loop your server runs, over HTTP and the SDK.
::

::prose-card{icon="lucide:plug" title="MCP Tools" to="/docs/ai/mcp"}
Expose tenant tools and resources to Claude, Cursor or VS Code over the Model Context Protocol.
::

::prose-card{icon="lucide:scroll-text" title="Audit Trail" to="/docs/reference/audit"}
Every read and write recorded — parameters only, secrets redacted, indexed and queryable.
::

::prose-card{icon="lucide:git-compare" title="Replication" to="/docs/reference/replication"}
One-way incremental copies to destination databases, on a schedule. No cluster to operate.
::

::prose-card{icon="lucide:database-zap" title="Caching & Vars" to="/docs/reference/caches"}
Memory, filesystem or Redis cache, plus a durable key/value store per tenant.
::

::prose-card{icon="lucide:workflow" title="Workflows & Jobs" to="/docs/reference/workflows"}
Saga pattern with compensation, scripts, hooks, services and custom actions.
::

::prose-card{icon="lucide:shield-check" title="Security & Crypto" to="/docs/reference/access-control"}
JWT, access rules, rate limiting, IP restriction, field-level encryption.
::
::

::landing-cta{:title='"Ready to build?"' :description='"Create your first Anteros project in seconds."' :primary='{"label":"Quick Start","href":"/docs/getting-started/quick-start","icon":"lucide:rocket"}' :secondary='{"label":"Explore the docs","href":"/docs/reference/configuration","icon":"lucide:book-open"}'}

::

::landing-footer
::
