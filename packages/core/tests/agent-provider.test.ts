/**
 * What an agent puts **on the wire** for the two things the provider can enforce
 * better than a prompt: a JSON **schema**, and the prompt **cache** of the stable
 * prefix.
 *
 * Anthropic has no `response_format` — the schema travels as a tool the model is
 * forced to call, and the adapter turns that call back into text, so the runtime
 * never sees a tool call it would try to execute. A streaming run gets the same
 * treatment, delta by delta.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { define, v, Agent } from "../index";
import {
    anthropicText,
    anthropicTool,
    at,
    fakeProvider,
    openaiText,
    request,
    sse,
    type Fake,
} from "./fixtures/fake-provider";

const servers: Fake[] = [];
function track(fake: Fake): Fake {
    servers.push(fake);
    return fake;
}

afterAll(() => {
    for (const server of servers) server.stop();
});

const priority = v.object({ priority: v.string().required() });

function makeAgent(
    overrides: Record<string, any> = {},
    provider: Record<string, any> = {},
    options: Record<string, any> = {},
) {
    return new Agent({
        id: "test",
        description: "A test agent.",
        instructions: "You are a test agent.",
        provider: {
            model: "test-model",
            apiKey: "test-key",
            compatible: "openai",
            options: { retries: 0, ...options },
            ...provider,
        },
        ...overrides,
    } as any);
}

const tool = () => define.Tool({
    id: "forecast",
    description: "Current weather for a city",
    inputSchema: v.object({ city: v.string().required() }),
    execute: async ({ city }: any) => ({ city, celsius: 21 }),
});

describe("structured output on an OpenAI-compatible gateway", () => {
    it("sends the real `json_schema`, not just `json_object`", async () => {
        const provider = track(fakeProvider(() => openaiText('{"priority":"high"}')));
        const agent = makeAgent({}, { baseUrl: provider.url });

        const result = await agent.generate("Triage this", { schema: priority });

        expect(result.object).toEqual({ priority: "high" });

        const format = request(provider, 0).body.response_format;
        expect(format.type).toBe("json_schema");
        // The agent id names the schema when nothing else does
        expect(format.json_schema.name).toBe("test");
        expect(format.json_schema.schema.type).toBe("object");
        expect(format.json_schema.schema.properties.priority.type).toBe("string");
    });

    it("names it from `api.object`, and describes it", async () => {
        const provider = track(fakeProvider(() => openaiText('{"priority":"low"}')));
        // What the HTTP `object` action runs: a structured call carrying `api.object`
        const api = { object: { schema: priority, name: "triage", description: "The triage verdict." } };
        const agent = makeAgent({ api }, { baseUrl: provider.url });

        await agent.generate("Triage this", { structuredOutput: api.object });

        const format = request(provider, 0).body.response_format.json_schema;
        expect(format.name).toBe("triage");
        expect(format.description).toBe("The triage verdict.");
    });

    it("sanitizes a name a provider would refuse", async () => {
        const provider = track(fakeProvider(() => openaiText('{"priority":"low"}')));
        const agent = makeAgent({
            api: { object: { schema: priority, name: "support.billing" } },
        }, { baseUrl: provider.url });

        await agent.generate("Triage this", { structuredOutput: { schema: priority, name: "support.billing" } });

        expect(request(provider, 0).body.response_format.json_schema.name).toBe("support_billing");
    });

    it("falls back to `json_object` once when the gateway refuses the schema", async () => {
        const provider = track(fakeProvider((body) => {
            if (body.response_format?.type === "json_schema") {
                return new Response(JSON.stringify({ error: { message: "response_format json_schema is not supported" } }), {
                    status: 400,
                    headers: { "Content-Type": "application/json" },
                });
            }
            return openaiText('{"priority":"high"}');
        }));
        const agent = makeAgent({}, { baseUrl: provider.url });

        const result = await agent.generate("Triage this", { schema: priority });

        expect(result.object).toEqual({ priority: "high" });
        expect(request(provider, 0).body.response_format.type).toBe("json_schema");
        expect(request(provider, 1).body.response_format).toEqual({ type: "json_object" });
    });

    it("does not mask an unrelated 400", async () => {
        const provider = track(fakeProvider(() => new Response(
            JSON.stringify({ error: { message: "I do not like your temperature" } }),
            { status: 400, headers: { "Content-Type": "application/json" } },
        )));
        const agent = makeAgent({}, { baseUrl: provider.url });

        await expect(agent.generate("Triage this", { schema: priority }))
            .rejects.toMatchObject({ code: "AGENT_PROVIDER_ERROR" });
        expect(provider.hits()).toBe(1); // no retry: the schema was not the problem
    });
});

describe("structured output on Anthropic", () => {
    it("forces a schema tool, and turns its call back into the answer", async () => {
        const provider = track(fakeProvider(() => anthropicTool("structured_output", { priority: "high" })));
        const agent = makeAgent({}, { compatible: "anthropic", baseUrl: provider.url });

        const result = await agent.generate("Triage this", { schema: priority });

        const body = request(provider, 0).body;
        expect(body.tool_choice).toEqual({ type: "tool", name: "structured_output" });
        expect(body.tools).toHaveLength(1);
        expect(body.tools[0].name).toBe("structured_output");
        expect(body.tools[0].input_schema.type).toBe("object");

        // The forced call **is** the answer: parsed and validated, never a tool call
        expect(result.object).toEqual({ priority: "high" });
        expect(result.toolCalls).toEqual([]);
    });

    it("keeps the agent's own tools, and the schema tool beside them", async () => {
        const provider = track(fakeProvider(() => anthropicTool("structured_output", { priority: "low" })));
        const agent = makeAgent({ tools: { forecast: tool() } }, { compatible: "anthropic", baseUrl: provider.url });

        await agent.generate("Triage this", { schema: priority });

        expect(request(provider, 0).body.tools.map((tool: any) => tool.name))
            .toEqual(["forecast", "structured_output"]);
    });

    it("does not force a tool when extended thinking is on, and still parses", async () => {
        const provider = track(fakeProvider(() => anthropicText('{"priority":"high"}')));
        const agent = makeAgent({}, { compatible: "anthropic", baseUrl: provider.url });

        const result = await agent.generate("Triage this", { schema: priority, thinking: true });

        const body = request(provider, 0).body;
        expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
        // `tool_choice` is refused alongside thinking — the prompt carries the schema
        expect(body.tool_choice).toBeUndefined();
        expect(body.tools).toBeUndefined();
        expect(result.object).toEqual({ priority: "high" });
    });

    it("streams the forced tool's JSON as text", async () => {
        const provider = track(fakeProvider(() => sse([
            JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } }),
            JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "structured_output" } }),
            JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"priority"' } }),
            JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ':"high"}' } }),
            JSON.stringify({ type: "content_block_stop", index: 0 }),
            JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }),
            JSON.stringify({ type: "message_stop" }),
        ])));
        const agent = makeAgent({}, { compatible: "anthropic", baseUrl: provider.url });

        const stream = agent.stream("Triage this", { schema: priority });
        const chunks: any[] = [];
        for await (const chunk of stream.fullStream) chunks.push(chunk);

        expect(await stream.text).toBe('{"priority":"high"}');
        expect(await stream.object).toEqual({ priority: "high" });
        expect(await stream.toolCalls).toEqual([]);
        // It arrived as text deltas — never as a tool call the run would execute
        expect(chunks.filter((chunk) => chunk.type === "tool_call")).toHaveLength(0);
        expect(at<any>(chunks, 0).type).toBe("text");
    });
});

describe("prompt cache", () => {
    it("marks the stable prefix on Anthropic — system and last tool", async () => {
        const provider = track(fakeProvider(() => anthropicText("ok")));
        const agent = makeAgent({ tools: { forecast: tool() } }, { compatible: "anthropic", baseUrl: provider.url }, { cache: true });

        await agent.generate("hi");

        const body = request(provider, 0).body;
        expect(body.system).toEqual([{ type: "text", text: "You are a test agent.", cache_control: { type: "ephemeral" } }]);
        expect(body.tools[body.tools.length - 1].cache_control).toEqual({ type: "ephemeral" });
    });

    it("leaves the payload alone when it is not asked for", async () => {
        const provider = track(fakeProvider(() => anthropicText("ok")));
        const agent = makeAgent({ tools: { forecast: tool() } }, { compatible: "anthropic", baseUrl: provider.url });

        await agent.generate("hi");

        const body = request(provider, 0).body;
        expect(body.system).toBe("You are a test agent.");
        expect(body.tools[0].cache_control).toBeUndefined();
    });

    it("is a no-op on an OpenAI-compatible gateway, which caches by itself", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const agent = makeAgent({}, { baseUrl: provider.url }, { cache: true });

        await agent.generate("hi");

        expect(request(provider, 0).body.messages[0]).toEqual({ role: "system", content: "You are a test agent." });
    });
});
