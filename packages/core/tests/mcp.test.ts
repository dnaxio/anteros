import { describe, it, expect, beforeEach } from "bun:test";
import { define, v } from "../index";
import { cfg } from "../server/config";
import { syncMcpTools } from "../lib/mcp";
import { createApp } from "../server/hono";
import { jwt } from "../utils/func";

const TENANT = "mcp-test";
const TENANT_DIR = "packages/core/tests/fixtures/mcp-tenant";
const SECRET = "mcp-auth-test-secret-0123456789abcdef";

/** A token bound to `tenant` (the tenant-binding middleware compares the claim). */
const token = (tenant = TENANT) => jwt.sign({ sub: "mcp-test", tenant });

// @hono/mcp frames every message as Server-Sent Events (MCP Streamable HTTP spec)
function parseSSE(text: string): any[] {
    const messages: any[] = [];
    let data: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        if (line.startsWith("data:")) {
            data.push(line.slice(5).trim());
        } else if (line === "" && data.length) {
            messages.push(JSON.parse(data.join("\n")));
            data = [];
        }
    }
    if (data.length) messages.push(JSON.parse(data.join("\n")));
    return messages;
}

function resetConfig() {
    cfg.server = {
        ...cfg.server,
        rateLimit: undefined,
        cors: undefined,
        ipRestriction: undefined,
        trustProxy: undefined,
        mcp: undefined, // authentication required (default)
        jwt: { secret: SECRET },
    };
    cfg.mcpTools = [];
    cfg.mcpResources = [];
    cfg.tenants = [];
}

beforeEach(() => {
    resetConfig();
    delete process.env.REDIS_URL;
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
    delete process.env.REDIS_PASSWORD;
});

describe("define.McpTool", () => {
    it("marks the tool and enables it by default", () => {
        const tool = define.McpTool({
            name: "greet",
            description: "greets",
            inputSchema: v.object({ name: v.string().required() }),
            exec: async () => ({ content: [{ type: "text", text: "hi" }] }),
        });
        expect(tool._isMcpTool_).toBe(true);
        expect(tool.enabled).toBe(true);
    });
});

describe("syncMcpTools", () => {
    it("loads tools + resources from mcp/tools and mcp/resources", async () => {
        cfg.tenants = [{ id: TENANT, dir: TENANT_DIR, database: { uri: "mongodb://localhost:27017/none" } }];
        await syncMcpTools();
        expect(cfg.mcpTools?.length).toBe(2);
        expect(cfg.mcpTools?.map((t) => t.name).sort()).toEqual(["badge", "echo"]);
        expect(cfg.mcpResources?.length).toBe(2);
        expect(cfg.mcpResources?.map((r) => r.uri).sort()).toEqual(["orders://summary", "users://{id}"]);
        expect(cfg.mcpTools?.[0]?._tenant_).toBe(TENANT);
    });
});

describe("MCP protocol (GET/POST /api/:tenant_id/mcp)", () => {
    it("serves tools/list and tools/call over JSON-RPC", async () => {
        cfg.tenants = [{ id: TENANT, dir: TENANT_DIR, database: { uri: "mongodb://localhost:27017/none" } }];
        await syncMcpTools();

        const app = createApp();
        const server = Bun.serve({ port: 0, fetch: app.fetch });
        const url = server.url.href.replace(/\/$/, "");
        const auth = { Authorization: `Bearer ${await token()}` };

        // 1. tools/list
        const listRes = await fetch(`${url}/api/${TENANT}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...auth },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        });
        expect(listRes.status).toBe(200);
        const list = parseSSE(await listRes.text())[0];
        const tools = list?.result?.tools ?? [];
        expect(tools.some((t: any) => t.name === "echo")).toBe(true);
        expect(tools.some((t: any) => t.name === "badge")).toBe(true);

        // 1b. resources/list — static resources
        const resListRes = await fetch(`${url}/api/${TENANT}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...auth },
            body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "resources/list", params: {} }),
        });
        const resList = parseSSE(await resListRes.text())[0];
        const resources = resList?.result?.resources ?? [];
        expect(resources.some((r: any) => r.uri === "orders://summary")).toBe(true);

        // 1c. resources/templates/list
        const tmplRes = await fetch(`${url}/api/${TENANT}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...auth },
            body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "resources/templates/list", params: {} }),
        });
        const tmplList = parseSSE(await tmplRes.text())[0];
        const templates = tmplList?.result?.resourceTemplates ?? [];
        expect(templates.some((t: any) => t.uriTemplate === "users://{id}")).toBe(true);

        // 1d. resources/read — static URI
        const readRes = await fetch(`${url}/api/${TENANT}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...auth },
            body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "resources/read", params: { uri: "orders://summary" } }),
        });
        const read = parseSSE(await readRes.text())[0];
        const readText = read?.result?.contents?.[0]?.text ?? "";
        expect(readText).toContain("\"total\":42");

        // 1e. resources/read — template URI with params
        const readTplRes = await fetch(`${url}/api/${TENANT}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...auth },
            body: JSON.stringify({ jsonrpc: "2.0", id: 12, method: "resources/read", params: { uri: "users://abc123" } }),
        });
        const readTpl = parseSSE(await readTplRes.text())[0];
        expect(readTpl?.result?.contents?.[0]?.text ?? "").toContain("\"id\":\"abc123\"");

        // 1f. resources/read — unknown URI → error
        const readBadRes = await fetch(`${url}/api/${TENANT}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...auth },
            body: JSON.stringify({ jsonrpc: "2.0", id: 13, method: "resources/read", params: { uri: "nope://x" } }),
        });
        const readBad = parseSSE(await readBadRes.text())[0];
        expect(readBad?.error).toBeDefined();

        // 2. tools/call (valid args + Joi defaults)
        const callRes = await fetch(`${url}/api/${TENANT}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...auth },
            body: JSON.stringify({
                jsonrpc: "2.0", id: 2, method: "tools/call",
                params: { name: "echo", arguments: { msg: "hello mcp" } },
            }),
        });
        const call = parseSSE(await callRes.text())[0];
        const block = call?.result?.content?.[0] ?? {};
        expect(block.type).toBe("text");
        expect(block.text ?? "").toContain("hello mcp");
        // Joi default applied (times=1)
        expect(block.text ?? "").toContain("\"times\":1");

        // 2b. protocol content blocks pass through unchanged (image block)
        const badgeRes = await fetch(`${url}/api/${TENANT}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...auth },
            body: JSON.stringify({
                jsonrpc: "2.0", id: 3, method: "tools/call",
                params: { name: "badge", arguments: {} },
            }),
        });
        const badge = parseSSE(await badgeRes.text())[0];
        expect(badge?.result?.content?.[0]?.type).toBe("image");
        expect(badge?.result?.content?.[0]?.mimeType).toBe("image/png");

        // 2b. invalid args → isError (Joi validation)
        const badRes = await fetch(`${url}/api/${TENANT}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...auth },
            body: JSON.stringify({
                jsonrpc: "2.0", id: 3, method: "tools/call",
                params: { name: "echo", arguments: { msg: 123 } },
            }),
        });
        const bad = parseSSE(await badRes.text())[0];
        expect(bad?.result?.isError).toBe(true);
        expect(bad?.result?.content?.[0]?.text ?? "").toContain("Invalid arguments");

        // 3. unknown tenant → 404 (token bound to that tenant, so it is not a mismatch)
        const notFound = await fetch(`${url}/api/ghost/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${await token("ghost")}` },
            body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }),
        });
        expect(notFound.status).toBe(404);

        server.stop(true);
    });
});

describe("MCP authentication (#28)", () => {
    async function serve() {
        const app = createApp();
        const server = Bun.serve({ port: 0, fetch: app.fetch });
        return { server, url: server.url.href.replace(/\/$/, "") };
    }

    async function load() {
        cfg.tenants = [{ id: TENANT, dir: TENANT_DIR, database: { uri: "mongodb://localhost:27017/none" } }];
        await syncMcpTools();
    }

    const rpc = (url: string, body: any, headers: Record<string, string> = {}) =>
        fetch(`${url}/api/${TENANT}/mcp`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify(body),
        });

    it("requires a token by default", async () => {
        await load();
        const { server, url } = await serve();
        try {
            const res = await rpc(url, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
            expect(res.status).toBe(401);
            expect(((await res.json()) as any).code).toBe("AUTH_REQUIRED");
        } finally { server.stop(true); }
    });

    it("accepts a valid token bound to the tenant", async () => {
        await load();
        const { server, url } = await serve();
        try {
            const res = await rpc(url, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { Authorization: `Bearer ${await token()}` });
            expect(res.status).toBe(200);
        } finally { server.stop(true); }
    });

    it("can be disabled with server.mcp.auth: false", async () => {
        await load();
        cfg.server = { ...cfg.server, mcp: { auth: false } };
        const { server, url } = await serve();
        try {
            const res = await rpc(url, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
            expect(res.status).toBe(200);
        } finally { server.stop(true); }
    });

    it("evaluates a tool's api.access — a declared block is deny-by-default", async () => {
        await load();
        const echo = cfg.mcpTools!.find((t) => t.name === "echo")!;
        echo.api = { access: { call: () => false } };

        const { server, url } = await serve();
        try {
            const denied = await rpc(
                url,
                { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { msg: "hi" } } },
                { Authorization: `Bearer ${await token()}` },
            );
            const refused = parseSSE(await denied.text())[0];
            expect(refused?.error).toBeDefined();
            expect(String(refused?.error?.message ?? "")).toContain("not allowed");

            // A tool with no rule stays available to the authenticated caller
            const allowed = await rpc(
                url,
                { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "badge", arguments: {} } },
                { Authorization: `Bearer ${await token()}` },
            );
            expect(parseSSE(await allowed.text())[0]?.result?.content?.[0]?.type).toBe("image");
        } finally { server.stop(true); }
    });

    it("evaluates a resource's api.access", async () => {
        await load();
        const summary = cfg.mcpResources!.find((r) => r.uri === "orders://summary")!;
        summary.api = { access: { read: () => false } };

        const { server, url } = await serve();
        try {
            const denied = await rpc(
                url,
                { jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "orders://summary" } },
                { Authorization: `Bearer ${await token()}` },
            );
            expect(parseSSE(await denied.text())[0]?.error).toBeDefined();
        } finally { server.stop(true); }
    });
});
