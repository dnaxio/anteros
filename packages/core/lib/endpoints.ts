/**
 * The URL of everything — one place.
 *
 * Every framework surface lives under a **single namespace**, `/api/:tenant_id`,
 * and a **family** segment says what it is:
 *
 * | Surface | Route |
 * | --- | --- |
 * | Collections (CRUD, actions, login…) | `POST /api/:tenant_id/collections/:collection/:action` |
 * | Services | `POST /api/:tenant_id/services/:service/:action` |
 * | Variables | `POST /api/:tenant_id/vars/:action` |
 * | Upload | `POST /api/:tenant_id/upload/:collection` |
 * | Files (serve, delete) | `GET\|DELETE /api/:tenant_id/files/:collection/:file` |
 * | Agents | `POST /api/:tenant_id/agents/:agent/:action` |
 * | MCP (tools & resources) | `GET\|POST /api/:tenant_id/mcp` |
 *
 * Two reasons for the shape. A tenant's own routes (`routes: { prefix: '/api/v1' }`)
 * are mounted **before** this one, so they always win — and nothing is ambiguous:
 * a collection may be called `services` or `login` without ever colliding with the
 * family segment, since a collection always sits under `/collections/`.
 *
 * `patterns` is what the server registers (Hono patterns); `endpoints` is what a
 * client builds — the two are read together, so a path is never written twice.
 */

/** The family segments — the component right after the tenant id. */
const FAMILIES = ["collections", "services", "vars", "upload", "files", "agents", "mcp"] as const;

const patterns = {
    collection: "/api/:tenant_id/collections/:collection/:action",
    /** The login action of an auth-enabled collection — its own rate limit. */
    login: "/api/:tenant_id/collections/:collection/login",
    service: "/api/:tenant_id/services/:service/:action",
    vars: "/api/:tenant_id/vars/:action",
    upload: "/api/:tenant_id/upload/:collection",
    file: "/api/:tenant_id/files/:collection/:file",
    agent: "/api/:tenant_id/agents/:agent/:action",
    mcp: "/api/:tenant_id/mcp",
} as const;

/** One path segment, encoded. */
function segment(value: string): string {
    return encodeURIComponent(String(value));
}

const endpoints = {
    /** Everything of a collection — `find`, `insertOne`, `login`, a custom action… */
    collection: (tenant: string, collection: string, action: string) =>
        `/api/${segment(tenant)}/collections/${segment(collection)}/${segment(action)}`,

    service: (tenant: string, service: string, action: string) =>
        `/api/${segment(tenant)}/services/${segment(service)}/${segment(action)}`,

    /** Variables — the namespace and the key travel in the body. */
    vars: (tenant: string, action: string) =>
        `/api/${segment(tenant)}/vars/${segment(action)}`,

    upload: (tenant: string, collection: string) =>
        `/api/${segment(tenant)}/upload/${segment(collection)}`,

    /** One file of a file collection — the document id, or its filename. */
    file: (tenant: string, collection: string, file: string) =>
        `/api/${segment(tenant)}/files/${segment(collection)}/${segment(file)}`,

    agent: (tenant: string, agent: string, action: string) =>
        `/api/${segment(tenant)}/agents/${segment(agent)}/${segment(action)}`,

    mcp: (tenant: string) => `/api/${segment(tenant)}/mcp`,
} as const;

/**
 * Is this a segment the framework owns? A tenant route mounted at
 * `/api/:tenant_id/<family>/…` is registered **first** and would shadow the
 * framework API silently — the route loader warns about it.
 */
function isReservedFamily(name: string): boolean {
    return (FAMILIES as readonly string[]).includes(name);
}

export { endpoints, FAMILIES, isReservedFamily, patterns, segment };
