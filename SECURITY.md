# Security Policy

## Supported versions

Security fixes are released on the **latest published version** of each package:

- `@anteros/core`
- `@anteros/cli`
- `@anteros/sdk`
- `@anteros/duckdb`

Older 0.x versions are not maintained — upgrade before reporting, when you can.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a vulnerability.**

Use GitHub's private reporting: **Security → Report a vulnerability** on the repository. That opens a private
advisory visible only to the maintainers.

Please include:

- the package and version (`@anteros/core@0.0.x`), plus the Bun version and OS;
- the smallest reproduction you can manage — code, request, or a failing test;
- what an attacker gains, and what access it requires (anonymous? a valid JWT? a given tenant?);
- whether the issue also affects a default deployment, or only a specific configuration.

We aim to acknowledge within **3 business days**, keep you informed during triage, and credit you in the
published advisory unless you ask otherwise. Please give us a reasonable window — **90 days** — before public
disclosure, or coordinate a date with us if you need longer.

## Scope

**In scope**

- Authentication and authorization: JWT signing and verification, `api.access` rules, tenant isolation,
  per-tenant databases, agent and collection access.
- Request handling: body parsing, validation, uploads, file paths, size limits, error responses that could
  leak internals.
- Secret handling: what reaches logs, audit entries, error payloads and agent memory.
- The SDK, the CLI (`anteros`, `antd`) and the DuckDB/Quack wrappers.

**Out of scope**

- Vulnerabilities in Bun, MongoDB, Hono, DuckDB or another dependency — report them upstream (we still want
  to know if it affects us).
- A deployment misconfiguration: open MongoDB, a weak or shared JWT secret, an exposed admin surface,
  missing TLS.
- Denial of service with no code-level flaw (traffic volume, resource exhaustion by design).
- Social engineering, physical access, or compromised developer machines.

## Secrets

Never paste tokens, API keys, connection strings or JWTs into an issue, an advisory or a pull request. If you
sent one by mistake, rotate it immediately and tell us.

## Deployment hardening

A short checklist, not a substitute for the documentation:

- JWT secret from the environment, per deployment — never a default or a committed value.
- `api.access` stated explicitly on every exposed surface. For agents, **no `api` block means every action is
  denied** — expose only what you mean to.
- TLS in front of the HTTP API; MongoDB reachable only from the application network.
- Request bodies and uploads are bounded by the framework (16 MB body, 100 MB file); keep those limits unless
  you have a reason to raise them.
- Pin the DuckDB/Quack dependency (`@duckdb/node-api`); the protocol is experimental through DuckDB 2.0.
- Rotate credentials on a schedule, and treat agent memory and audit collections as sensitive data.
