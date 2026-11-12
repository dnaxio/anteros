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
import type { McpTool, McpResource } from "../types/mcp";
import type { HonoVariables } from "./env";
import { joiToJsonSchema } from "../lib/jsonSchema";
import { patterns } from "../lib/endpoints";
import { evaluateAccess } from "./access";

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

// ─── MCP server (one fresh instance per request — stateless) ─────────────

/** JSON-RPC code of a refused tool call / resource read (server-defined range). */
const ACCESS_DENIED = -32001;

/**
 * Evaluate a tool's / resource's `api.access` rule, when it declares one.
 *
 * No block → the endpoint's own authentication is the gate (any authenticated caller
 * of the tenant). A block is **deny-by-default**, like every other `api.access` in the
 * framework: a rule for another operation, or an empty block, refuses this one.
 */
async function assertMcpAccess(
    access: Record<string, boolean | ((ctx: any) => boolean | Promise<boolean>) | undefined> | undefined,
    operation: "call" | "read",
    label: string,
    tenantId: string,
    rest: InstanceType<typeof useRest>,
    c: Context<{ Variables: HonoVariables }>,
    extra: Record<string, any>,
): Promise<void> {
    if (!access) return;
    try {
        await evaluateAccess(access as any, operation, rest, label, c, { tenant: tenantId, ...extra });
    } catch (error: any) {
        throw new McpError(ACCESS_DENIED, error?.message ?? "Access denied");
    }
}

function buildServer(
    tenantId: string,
    tools: McpTool[],
    resources: McpResource[],
    c: Context<{ Variables: HonoVariables }>,
): Server {
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

        const rest = new useRest({ tenant_id: tenantId, internal: false });

        // Access first: a refused caller must not be able to probe the schema
        // (`api.access` on the tool, when declared — denied by default, like everywhere)
        const raw = req.params.arguments ?? {};
        await assertMcpAccess(tool.api?.access, 'call', `mcp:${tool.name}`, tenantId, rest, c, {
            tool: tool.name,
            args: raw,
        });

        const { error, value } = tool.inputSchema.validate(raw, { allowUnknown: false });
        if (error) {
            logger.file('warn', 'MCP tools/call', { method: 'tools/call', tenant: tenantId, tool: req.params.name, args: raw, error: 'invalid arguments', duration: ms(start) });
            return {
                content: [{ type: 'text' as const, text: `Invalid arguments: ${error.message}` }],
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
            logger[isError ? 'warn' : 'info']('MCP tools/call', { method: 'tools/call', tenant: tenantId, tool: req.params.name, args: value, isError, duration: ms(start) });
            if (result && Array.isArray(result.content)) return result;
            const text = typeof result === 'string' ? result : JSON.stringify(result);
            return { content: [{ type: 'text' as const, text }] };
        } catch (err: any) {
            logger.file('warn', 'MCP tools/call', { method: 'tools/call', tenant: tenantId, tool: req.params.name, args: value, error: err?.message ?? 'unknown', duration: ms(start) });
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

        const rest = new useRest({ tenant_id: tenantId, internal: false });
        await assertMcpAccess(matched.resource.api?.access, 'read', `mcp:${matched.resource.name}`, tenantId, rest, c, {
            resource: matched.resource.name,
            uri,
        });

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
            return result;
        } catch (err: any) {
            logger.file('warn', 'MCP resources/read', { method: 'resources/read', tenant: tenantId, uri, error: err?.message ?? 'unknown', duration: ms(start) });
            throw new McpError(ErrorCode.InternalError, `Failed to read resource: ${err?.message ?? 'unknown'}`);
        }
    });

    return server;
}

/**
 * Expose each tenant's MCP tools & resources over the Model Context Protocol
 * at `GET/POST /api/:tenant_id/mcp` (Streamable HTTP transport — works with
 * Claude, Cursor, VS Code, and any MCP client).
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

    app.all(patterns.mcp, async (c: Context<{ Variables: HonoVariables }>) => {
        // Authentication (#28): a verified, non-expired token is required on every MCP
        // request unless `server.mcp.auth` is explicitly `false`. An invalid or expired
        // token never gets here — the global middleware rejects it (#52). Checked before
        // the tenant lookup, so an anonymous caller cannot probe tenant existence.
        if (cfg.server.mcp?.auth !== false) {
            const token = (c as any).get('token') as { value?: string | null; provided?: boolean; expired?: boolean } | undefined;
            if (!token?.provided || !token.value) {
                return c.json({
                    message: token?.expired ? 'Token expired' : 'Authentication required',
                    code: token?.expired ? 'TOKEN_EXPIRED' : 'AUTH_REQUIRED',
                }, 401);
            }
        }

        const tenantId = c.req.param('tenant_id') ?? '';
        const tools = toolsByTenant.get(tenantId) ?? [];
        const resources = resourcesByTenant.get(tenantId) ?? [];
        if (!tools.length && !resources.length) {
            return c.json({ error: `No MCP tools or resources for tenant '${tenantId}'` }, 404);
        }

        const server = buildServer(tenantId, tools, resources, c);
        const transport = new StreamableHTTPTransport();
        await server.connect(transport);
        return transport.handleRequest(c);
    });
}
