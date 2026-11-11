import type { Hono, Context } from "hono";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    ReadResourceRequestSchema,
    McpError,
    ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { cfg } from "./config";
import { useRest } from "../database/rest";
import { createAgents } from "../lib/agents";
import { createApi } from "../lib/api";
import { logger } from "../utils/logger";
import { evaluateAccess } from "./access";
import { rateLimit } from "./security";
import type { McpTool, McpResource } from "../types/mcp";
import type { HonoVariables } from "./env";
import { joiToJsonSchema } from "../lib/jsonSchema";
import { patterns } from "../lib/endpoints";

// The Joi → JSON Schema converter is shared with the agent runtime — a tool
// must look identical whether it is exposed over MCP or to a model.

// ─── URI template matching (users://{id} → params) ───────────────────────

function compileTemplate(template: string): { regex: RegExp; params: string[] } {
    const params: string[] = [];
    const pattern = template.replace(/\{([^}]+)\}/g, (_, name) => {
        params.push(name);
        return '([^/]+)';
    });
    return { regex: new RegExp(`^${pattern}$`), params };
}

function matchUri(uri: string, resources: McpResource[]): { resource: McpResource; params: Record<string, string> } | null {
    // Exact static match first
    const staticMatch = resources.find((r) => r.uri === uri);
    if (staticMatch) return { resource: staticMatch, params: {} };

    // Template match
    for (const resource of resources) {
        if (!resource.uri.includes('{')) continue;
        const { regex, params } = compileTemplate(resource.uri);
        const m = uri.match(regex);
        if (!m) continue;
        const extracted: Record<string, string> = {};
        params.forEach((name, i) => { extracted[name] = m[i + 1] ?? ''; });
        return { resource, params: extracted };
    }
    return null;
}

/** Fingerprint of an argument payload — audited, never the raw value. */
function fingerprint(value: unknown): string {
    try {
        return new Bun.CryptoHasher("sha256").update(JSON.stringify(value) ?? "").digest("hex");
    } catch {
        return "unserializable";
    }
}

// ─── MCP server (one fresh instance per request — stateless) ─────────────

function buildServer(tenantId: string, tools: McpTool[], resources: McpResource[], c: Context<{ Variables: HonoVariables }>): Server {
    const server = new Server(
        { name: 'anteros-mcp', version: cfg.version ?? '1.0.0' },
        { capabilities: { tools: {}, resources: {} } }
    );

    const ms = (start: number) => Math.round((performance.now() - start) * 10) / 10;

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const start = performance.now();
        const toolsList = tools.map((t) => ({
            name: t.name,
            title: t.name,
            description: t.description,
            inputSchema: joiToJsonSchema(t.inputSchema),
        }));
        logger.file('MCP tools/list', { method: 'tools/list', tenant: tenantId, count: toolsList.length, duration: ms(start) });
        return { tools: toolsList };
    });

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const start = performance.now();
        const tool = tools.find((t) => t.name === req.params.name);
        if (!tool) {
            logger.file('warn', 'MCP tools/call', { method: 'tools/call', tenant: tenantId, tool: req.params.name, error: 'unknown tool', duration: ms(start) });
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${req.params.name}`);
        }

        const raw = req.params.arguments ?? {};
        const { error, value } = tool.inputSchema.validate(raw, { allowUnknown: false });
        if (error) {
            logger.file('warn', 'MCP tools/call', { method: 'tools/call', tenant: tenantId, tool: req.params.name, argsFingerprint: fingerprint(raw), error: 'invalid arguments', duration: ms(start) });
            return {
                content: [{ type: 'text' as const, text: `Invalid arguments: ${error.message}` }],
                isError: true,
            };
        }

        const rest = new useRest({ tenant_id: tenantId });
        try {
            // Independent authorization per tool — no rule = denied (secure by default).
            await evaluateAccess(tool.api?.access as any, 'call', rest, `mcp:${tool.name}`, c, {
                tenant: tenantId,
                tool: tool.name,
                args: value,
            });
        } catch (err: any) {
            logger.file('warn', 'MCP tools/call', { method: 'tools/call', tenant: tenantId, tool: req.params.name, argsFingerprint: fingerprint(value), error: 'access denied', duration: ms(start) });
            await rest.audit.log({
                action: 'mcp.tools/call',
                collection: tool.name,
                input: { tenant: tenantId, tool: tool.name, argsFingerprint: fingerprint(value) },
                error: { message: 'Access denied', code: err?.code || 'ACCESS_DENIED' },
                duration: ms(start),
            }).catch(() => {});
            return {
                content: [{ type: 'text' as const, text: 'Access denied' }],
                isError: true,
            };
        }

        try {
            const result = await tool.exec({
                c,
                rest,
                args: value,
                agents: createAgents(tenantId, rest),
                api: createApi(rest),
            });
            const isError = !!(result as any)?.isError;
            logger[isError ? 'warn' : 'info']('MCP tools/call', { method: 'tools/call', tenant: tenantId, tool: req.params.name, argsFingerprint: fingerprint(value), isError, duration: ms(start) });
            await rest.audit.log({
                action: 'mcp.tools/call',
                collection: tool.name,
                input: { tenant: tenantId, tool: tool.name, argsFingerprint: fingerprint(value) },
                result: { isError },
                duration: ms(start),
            }).catch(() => {});
            if (result && Array.isArray(result.content)) return result;
            const text = typeof result === 'string' ? result : JSON.stringify(result);
            return { content: [{ type: 'text' as const, text }] };
        } catch (err: any) {
            logger.file('warn', 'MCP tools/call', { method: 'tools/call', tenant: tenantId, tool: req.params.name, argsFingerprint: fingerprint(value), error: err?.message ?? 'unknown', duration: ms(start) });
            await rest.audit.log({
                action: 'mcp.tools/call',
                collection: tool.name,
                input: { tenant: tenantId, tool: tool.name, argsFingerprint: fingerprint(value) },
                error: { message: err?.message ?? 'unknown', code: 'MCP_TOOL_ERROR' },
                duration: ms(start),
            }).catch(() => {});
            return {
                content: [{ type: 'text' as const, text: `Error: ${err?.message ?? 'unknown'}` }],
                isError: true,
            };
        }
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => {
        const start = performance.now();
        const resourcesList = resources
            .filter((r) => !r.uri.includes('{')) // static only; templates are listed separately
            .map((r) => ({
                uri: r.uri,
                name: r.name,
                description: r.description,
                mimeType: r.mimeType,
            }));
        logger.file('MCP resources/list', { method: 'resources/list', tenant: tenantId, count: resourcesList.length, duration: ms(start) });
        return { resources: resourcesList };
    });

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
        const start = performance.now();
        const templates = resources
            .filter((r) => r.uri.includes('{'))
            .map((r) => ({
                uriTemplate: r.uri,
                name: r.name,
                description: r.description,
                mimeType: r.mimeType,
            }));
        logger.file('MCP resources/templates/list', { method: 'resources/templates/list', tenant: tenantId, count: templates.length, duration: ms(start) });
        return { resourceTemplates: templates };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
        const start = performance.now();
        const uri = req.params.uri;
        const matched = matchUri(uri, resources);
        if (!matched) {
            logger.file('warn', 'MCP resources/read', { method: 'resources/read', tenant: tenantId, uri, error: 'unknown uri', duration: ms(start) });
            throw new McpError(ErrorCode.InvalidParams, `Unknown resource URI: ${uri}`);
        }

        const rest = new useRest({ tenant_id: tenantId });
        try {
            // Independent authorization per resource — no rule = denied.
            await evaluateAccess(matched.resource.api?.access as any, 'read', rest, `mcp:${matched.resource.name}`, c, {
                tenant: tenantId,
                resource: matched.resource.name,
                uri,
            });
        } catch (err: any) {
            logger.file('warn', 'MCP resources/read', { method: 'resources/read', tenant: tenantId, uri, resource: matched.resource.name, error: 'access denied', duration: ms(start) });
            await rest.audit.log({
                action: 'mcp.resources/read',
                collection: matched.resource.name,
                input: { tenant: tenantId, resource: matched.resource.name, uri },
                error: { message: 'Access denied', code: err?.code || 'ACCESS_DENIED' },
                duration: ms(start),
            }).catch(() => {});
            throw new McpError(ErrorCode.InvalidRequest, 'Access denied');
        }

        try {
            const result = await matched.resource.read({
                c,
                rest,
                agents: createAgents(tenantId, rest),
                api: createApi(rest),
                params: matched.params,
                uri,
            });
            logger.file('MCP resources/read', { method: 'resources/read', tenant: tenantId, uri, resource: matched.resource.name, params: matched.params, duration: ms(start) });
            await rest.audit.log({
                action: 'mcp.resources/read',
                collection: matched.resource.name,
                input: { tenant: tenantId, resource: matched.resource.name, uri },
                result: { ok: true },
                duration: ms(start),
            }).catch(() => {});
            return result;
        } catch (err: any) {
            logger.file('warn', 'MCP resources/read', { method: 'resources/read', tenant: tenantId, uri, error: err?.message ?? 'unknown', duration: ms(start) });
            await rest.audit.log({
                action: 'mcp.resources/read',
                collection: matched.resource.name,
                input: { tenant: tenantId, resource: matched.resource.name, uri },
                error: { message: err?.message ?? 'unknown', code: 'MCP_RESOURCE_ERROR' },
                duration: ms(start),
            }).catch(() => {});
            throw new McpError(ErrorCode.InternalError, `Failed to read resource: ${err?.message ?? 'unknown'}`);
        }
    });

    return server;
}

/**
 * Expose each tenant's MCP tools & resources over the Model Context Protocol
 * at `GET/POST /api/:tenant_id/mcp` (Streamable HTTP transport — works with
 * Claude, Cursor, VS Code, and any MCP client).
 *
 * Security: every MCP operation requires a verified, tenant-bound token. Each
 * `tools/call` / `resources/read` is additionally gated by its own `api.access`
 * (no rule = denied). See G-MCP-EXPOSE.
 */
export function initializeMcp(app: Hono<{ Variables: HonoVariables }>) {
    const toolsByTenant = new Map<string, McpTool[]>();
    for (const tool of cfg.mcpTools ?? []) {
        const list = toolsByTenant.get(tool._tenant_ ?? '') ?? [];
        list.push(tool);
        toolsByTenant.set(tool._tenant_ ?? '', list);
    }
    const resourcesByTenant = new Map<string, McpResource[]>();
    for (const resource of cfg.mcpResources ?? []) {
        const list = resourcesByTenant.get(resource._tenant_ ?? '') ?? [];
        list.push(resource);
        resourcesByTenant.set(resource._tenant_ ?? '', list);
    }

    // Per-tenant rate limit, in addition to the global/IP limit (server/hono.ts).
    // Keyed by the authenticated tenant claim (fallback: client IP).
    app.use(patterns.mcp, rateLimit({
        windowMs: 60_000,
        max: 300,
        keyGenerator: (c) => {
            const token = (c as any).get('token') as { decoded?: Record<string, unknown> } | undefined;
            const tenant = token?.decoded?.['tenant'] ?? token?.decoded?.['_tenant_'] ?? token?.decoded?.['tenant_id']
                ?? (c as any).get('clientIp') ?? 'unknown';
            return `rn:rl:mcp:${String(tenant)}`;
        },
    }));

    app.all(patterns.mcp, async (c: Context<{ Variables: HonoVariables }>) => {
        const tenantId = c.req.param('tenant_id') ?? '';

        // 1. Reject anonymous, invalid or expired tokens (same contract as /_dnax/config).
        const token = c.get('token') as { decoded: Record<string, unknown> | null; expired?: boolean; provided?: boolean } | undefined;
        if (!token?.decoded || token?.expired || !token?.provided) {
            return c.json({ message: 'Authentication required', code: 'AUTH_REQUIRED' }, 401);
        }

        // 2. Tenant isolation: the authenticated tenant must match the URL tenant.
        const claim = token.decoded['tenant'] ?? token.decoded['_tenant_'] ?? token.decoded['tenant_id'];
        if (claim !== undefined && String(claim) !== tenantId) {
            return c.json({ message: 'Token does not belong to this tenant', code: 'TENANT_MISMATCH' }, 401);
        }
        if (cfg.server.jwt?.requireTenantClaim === true && claim === undefined) {
            return c.json({ message: 'Tenant claim required', code: 'TENANT_CLAIM_REQUIRED' }, 401);
        }

        const tools = toolsByTenant.get(tenantId) ?? [];
        const resources = resourcesByTenant.get(tenantId) ?? [];
        // G-MCP-ENUM: generic response — never echo the tenant id or reveal configuration.
        if (!tools.length && !resources.length) {
            return c.json({ error: 'Not found' }, 404);
        }

        const server = buildServer(tenantId, tools, resources, c);
        const transport = new StreamableHTTPTransport();
        await server.connect(transport);
        return transport.handleRequest(c);
    });
}
