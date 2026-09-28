import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logger } from "../utils/logger";
import type { AgentTool } from "../types/agent";

/**
 * The **MCP client** — the other direction of the protocol the framework serves.
 *
 * An agent can consume a remote MCP server's tools (`mcp: ['https://host/mcp']`):
 * they are listed once, adapted into ordinary `AgentTool`s, and called over the
 * Streamable HTTP transport. The whole point is that nothing downstream knows the
 * difference — a remote tool goes through the same validation, the same audit, the
 * same timeouts and the same error reporting as a local one.
 *
 * A server is connected **lazily** (on the first run that needs it, never at boot:
 * a remote that is down must not slow a boot down) and memoized **per server**, so
 * a failure is retried on the next run while the servers that answered keep serving.
 */

/** Name we announce during `initialize` — the protocol requires one. */
const CLIENT_NAME = "anteros";
const CLIENT_VERSION = "1.0.0";

/** A remote server has to answer `initialize` + `tools/list` within this. */
const MCP_TIMEOUT_MS = 5_000;

/** Live clients, by URL — closed by `closeMcpClients()` (a reload, a shutdown). */
const clients = new Map<string, Client>();
/** Resolved tools per server, and the in-flight promise of one still connecting. */
const servers = new Map<string, { tools: AgentTool[] } | { pending: Promise<AgentTool[]> }>();

/** `['https://a/mcp']` or `{ docs: 'https://a/mcp' }` → what to connect to. */
function serverList(declared: string[] | Record<string, string> | undefined): Array<{ name: string; url: string }> {
    if (!declared) return [];
    if (Array.isArray(declared)) {
        return declared
            .filter((url) => typeof url === "string" && url.trim())
            .map((url) => ({ name: String(url).trim(), url: String(url).trim() }));
    }
    return Object.entries(declared)
        .filter(([, url]) => typeof url === "string" && url.trim())
        .map(([name, url]) => ({ name, url: String(url).trim() }));
}

/** Give up on a promise after `ms` — an unreachable server must not hold a run. */
async function bounded<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} did not answer within ${ms}ms`)), ms);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Connect, list, and adapt — one server's worth of work. */
async function loadTools(name: string, url: string): Promise<AgentTool[]> {
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
    await bounded(client.connect(new StreamableHTTPClientTransport(new URL(url))), MCP_TIMEOUT_MS, `MCP server '${name}'`);

    const listed = await bounded(client.listTools(), MCP_TIMEOUT_MS, `MCP server '${name}'`);
    clients.set(url, client);

    return (listed?.tools ?? []).map((tool: any) => ({
        id: tool.name,
        description: tool.description ?? `Remote MCP tool '${tool.name}'.`,
        // The protocol carries a plain JSON Schema, which `validateWithSchema` reads
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        execute: async (args: any) => {
            const result: any = await client.callTool({ name: tool.name, arguments: args ?? {} });
            // `serializeToolResult` already flattens MCP `{ content: [...] }`
            if (result?.isError) throw new Error(result?.content?.[0]?.text ?? `Remote tool '${tool.name}' failed`);
            return result;
        },
    })) as AgentTool[];
}

/**
 * The tools of the declared servers, connected on demand. A server that fails is
 * reported and contributes nothing (the agent keeps its own tools); the next run
 * tries again — nothing is cached but a success.
 */
async function mcpToolsFor(declared: string[] | Record<string, string> | undefined): Promise<AgentTool[]> {
    const out: AgentTool[] = [];

    for (const { name, url } of serverList(declared)) {
        let entry = servers.get(url);
        if (!entry) {
            const pending = loadTools(name, url)
                .then((tools) => {
                    servers.set(url, { tools });
                    logger.file("info", "agent mcp: server connected", { server: name, url, tools: tools.length });
                    return tools;
                })
                .catch((err: any) => {
                    servers.delete(url); // a failure is not memoized: the next run retries
                    logger.file("warn", "agent mcp: server unavailable", { server: name, url, error: err?.message });
                    return [] as AgentTool[];
                });
            entry = { pending };
            servers.set(url, entry);
        }

        out.push(...("tools" in entry ? entry.tools : await entry.pending));
    }

    return out;
}

/** Close every live MCP client — called on a reload, and by a shutdown. */
async function closeMcpClients(): Promise<void> {
    for (const client of clients.values()) {
        try { await client.close(); } catch { /* already gone */ }
    }
    clients.clear();
    servers.clear();
}

export {
    MCP_TIMEOUT_MS,
    closeMcpClients,
    mcpToolsFor,
    serverList,
};
