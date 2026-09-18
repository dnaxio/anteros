---
title: Anteros Framework
description: The all-in-one backend framework — Bun, MongoDB, multi-tenant, workflows, MCP tools, and more.
seo:
  title: Anteros Framework — Build backends at light speed
  description: A robust backend for building business logic — Bun runtime, MongoDB, multi-tenant architecture, real-time, caching, crypto, workflows, MCP tools, files and audit trail.
---

::landing-hero{:siteName='"Anteros"' :badge='{"label":"v0.0.11","text":"Now available","href":"/docs/getting-started/quick-start"}' :headline='"Build backends at light speed."' :description='"A robust backend for building business logic — Bun runtime, MongoDB database, multi-tenant architecture, real-time Socket.IO, built-in caching, symmetric & asymmetric crypto, workflow engine, MCP tools for LLM agents, file management, and audit trail. All in one."' :navLinks='[{"label":"Docs","href":"/docs/getting-started/introduction"},{"label":"Quick Start","href":"/docs/getting-started/quick-start"},{"label":"CLI","href":"/docs/cli/installation"},{"label":"Reference","href":"/docs/reference/configuration"}]' :primaryCta='{"label":"Get Started","href":"/docs/getting-started/quick-start"}' :secondaryCta='{"label":"Read the docs","href":"/docs/getting-started/introduction"}' :iframe='{"src":"/docs/getting-started/quick-start","class":"border rounded-lg h-[580px] md:h-[700px]","iframeClass":"rounded-lg"}'}

::

::landing-features{:title='"Everything you need."' :description='"Batteries included. No stitching together disparate tools."'}
::prose-card{icon="lucide:zap" title="Bun Runtime" to="/docs/getting-started/introduction"}
Blazing fast APIs powered by Bun — one of the fastest JavaScript runtimes. Zero-config hot reload and native TypeScript support.
::

::prose-card{icon="lucide:database" title="MongoDB Native" to="/docs/reference/collections"}
Full database integration with automatic schema validation, indexing, aggregation pipelines, and change streams out of the box.
::

::prose-card{icon="lucide:layout-grid" title="Multi-Tenant" to="/docs/reference/tenants"}
Isolated databases, per-tenant code folders, scoped collections, routes, services, and middlewares. One server, infinite tenants.
::

::prose-card{icon="lucide:shield-check" title="Security" to="/docs/reference/access-control"}
JWT authentication, access control, rate limiting, IP restriction.
::

::prose-card{icon="lucide:key-round" title="Crypto" to="/docs/reference/crypto"}
AES-256-GCM symmetric & RSA-OAEP asymmetric encryption out of the box.
::

::prose-card{icon="lucide:network" title="Socket.IO" to="/docs/reference/websockets"}
Real-time WebSocket communication with room support and built-in auth.
::

::prose-card{icon="lucide:database-zap" title="Caching" to="/docs/reference/caches"}
In-memory, filesystem, and Redis caching with TTL, grace periods, stampede protection, and a DB query cache (`useCache`) with automatic invalidation.
::

::prose-card{icon="lucide:bot" title="MCP Tools & Resources" to="/docs/reference/mcp"}
Expose tenant tools & resources to LLM agents (Claude, Cursor, VS Code) via the Model Context Protocol at `/mcp/:tenant_id`.
::

::prose-card{icon="lucide:upload" title="File Upload" to="/docs/reference/files"}
Disk/S3 storage, image transforms, multi-destination replication.
::

::prose-card{icon="lucide:webhook" title="Hooks & Actions" to="/docs/reference/hooks"}
Lifecycle hooks, custom actions, services, before/after operations.
::

::prose-card{icon="lucide:workflow" title="Workflows" to="/docs/reference/workflows"}
Saga pattern, compensation, progress tracking, resume on failure.
::

::prose-card{icon="lucide:code" title="Business Logic" to="/docs/reference/services"}
Services, scripts, and custom actions to encapsulate your domain logic cleanly.
::
::

::landing-cta{:title='"Ready to build?"' :description='"Create your first Anteros project in seconds."' :primary='{"label":"Quick Start","href":"/docs/getting-started/quick-start"}' :secondary='{"label":"Explore the docs","href":"/docs/reference/configuration"}'}

::
