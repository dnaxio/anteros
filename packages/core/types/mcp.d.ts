import type Joi from "joi";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "hono";
import type { useRest } from "../database/rest";

/**
 * MCP tool result — the Model Context Protocol `CallToolResult` shape.
 * `exec` must return this (or a Promise of it).
 */
export type McpToolResult = {
    content: ContentBlock[];
    isError?: boolean;
    structuredContent?: unknown;
};

/**
 * MCP tool definition — auto-loaded from `{tenant.dir}/mcp/tools/**\/*.tool.ts`.
 * Served over the MCP protocol at `GET/POST /mcp/:tenant_id` (Streamable HTTP).
 */
export type McpTool = {
    _isMcpTool_?: boolean;
    _tenant_?: string;
    /** Tool name — unique per tenant (how the LLM calls it) */
    name: string;
    /** Short description shown to the LLM */
    description?: string;
    enabled?: boolean;
    /** Joi schema describing the tool arguments (same language as collections — `v`) */
    inputSchema: Joi.Schema;
    /** Handler executed when the LLM calls the tool (args are Joi-validated).
     * Must return the MCP protocol result shape: `{ content: [{ type, text | data… }] }`. */
    exec: (ctx: {
        c: Context;
        rest: InstanceType<typeof useRest>;
        /** Parsed & validated arguments */
        args: Record<string, any>;
    }) => McpToolResult | Promise<McpToolResult>;
};

/**
 * MCP resource read result — the protocol `ReadResourceResult` shape.
 * `contents` is an array of text or blob (base64) content blocks.
 */
export type McpResourceResult = {
    contents: Array<{
        uri: string;
        mimeType?: string;
        text?: string;
        blob?: string;
    }>;
};

/**
 * MCP resource — read-only data exposed by URI (like a file the LLM can open).
 * Auto-loaded from `{tenant.dir}/mcp/resources/**\/*.resource.ts`.
 *
 * The `uri` can be static (`orders://summary`) or a template
 * (`users://{id}`) — template params are extracted and passed to `read`.
 */
export type McpResource = {
    _isMcpResource_?: boolean;
    _tenant_?: string;
    /** Resource name — unique per tenant */
    name: string;
    /** Short description shown to the LLM */
    description?: string;
    enabled?: boolean;
    /** Static URI (e.g. `orders://summary`) or template (e.g. `users://{id}`) */
    uri: string;
    /** Content type of the resource (default: application/json) */
    mimeType?: string;
    /** Handler called when the LLM reads the resource */
    read: (ctx: {
        c: Context;
        rest: InstanceType<typeof useRest>;
        /** Params extracted from the URI template (e.g. `{ id: '123' }`) */
        params: Record<string, string>;
        /** The exact URI the client requested */
        uri: string;
    }) => McpResourceResult | Promise<McpResourceResult>;
};
