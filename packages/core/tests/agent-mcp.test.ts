/**
 * The MCP **client** — an agent consuming a remote server's tools.
 *
 * The endpoint under test is the framework's own (`/api/:tenant/mcp`, served by
 * `@hono/mcp`): the SDK client and our server are two independent implementations of
 * the protocol, which is exactly what makes the round trip worth testing end to end —
 * list, call, and back into the conversation as if the tool were local.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Agent, define, v } from "../index";
import { cfg, formatConfig } from "../server/config";
import { syncTenants } from "../database/tenant";
import { syncMcpTools } from "../lib/mcp";
import { closeMcpClients } from "../lib/mcpClient";
import { createApp } from "../server/hono";
import { at, fakeProvider, openaiText, openaiTool, request, type Fake } from "./fixtures/fake-provider";

const TENANT = "mcp-client";
const DIR = "packages/core/tests/fixtures/mcp-tenant";

let server: any;
let mcpUrl: string;
const servers: Fake[] = [];

const track = (fake: Fake): Fake => (servers.push(fake), fake);

beforeAll(async () => {
    formatConfig({
        server: { port: 4000 },
        tenants: [{ id: TENANT, dir: DIR, database: { uri: "mongodb://localhost:27017/none" } }],
    });
    await syncTenants();
    await syncMcpTools();

    server = Bun.serve({ port: 0, fetch: createApp().fetch });
    mcpUrl = `${server.url.href.replace(/\/$/, "")}/api/${TENANT}/mcp`;
});

afterAll(async () => {
    for (const fake of servers) fake.stop();
    await closeMcpClients();
    try { server?.stop(true); } catch (_) {}
    cfg.agents = [];
});

function makeAgent(provider: Fake, overrides: Record<string, any> = {}) {
    return new Agent({
        id: "test",
        description: "A test agent.",
        instructions: "You are a test agent.",
        provider: { model: "test-model", apiKey: "test-key", baseUrl: provider.url, options: { retries: 0 } },
        mcp: [mcpUrl],
        ...overrides,
    } as any);
}

describe("agent mcp — a remote server's tools", () => {
    it("lists them as tools, calls one, and feeds the result back", async () => {
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? openaiTool("echo", { msg: "hello mcp", times: 1 }) : openaiText("done")));
        const agent = makeAgent(provider);

        const result = await agent.generate("echo something");

        // The remote tools are offered like any other
        const names = request(provider, 0).body.tools.map((tool: any) => tool.function.name);
        expect(names).toContain("echo");
        expect(names).toContain("badge");

        // …and the call really crossed the wire: the answer is the server's
        const entry = at(result.toolResults, 0);
        expect(entry.error).toBeUndefined();
        expect(entry.result.content[0].text).toContain("hello mcp");
        // What the model saw is the flattened text, not the protocol envelope
        const toolMessage = result.messages.find((message) => message.role === "tool");
        expect(toolMessage?.content).toContain("hello mcp");
        expect(result.text).toBe("done");
    });

    it("lets a declared tool win over a remote one of the same name", async () => {
        const provider = track(fakeProvider(() => openaiText("done")));
        const local = define.Tool({
            id: "echo",
            description: "The tenant's own echo.",
            inputSchema: v.object({}),
            execute: async () => "local",
        });
        const agent = makeAgent(provider, { tools: { echo: local } });

        await agent.generate("hi");

        const offered = request(provider, 0).body.tools.filter((tool: any) => tool.function.name === "echo");
        expect(offered).toHaveLength(1);
        expect(offered[0].function.description).toBe("The tenant's own echo.");
    });

    it("contacts nothing with `tools: false`", async () => {
        const provider = track(fakeProvider(() => openaiText("direct")));
        const agent = makeAgent(provider);

        await agent.generate("hi", { tools: false });

        expect(request(provider, 0).body.tools).toBeUndefined();
    });

    it("runs anyway when the server is unreachable", async () => {
        const provider = track(fakeProvider(() => openaiText("still here")));
        const agent = makeAgent(provider, { mcp: ["http://127.0.0.1:9/mcp"] });

        const result = await agent.generate("hi");

        // A remote that is down costs its tools, not the run
        expect(result.text).toBe("still here");
        expect(request(provider, 0).body.tools).toBeUndefined();
    }, 20_000);
});
