import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { define, v, Agent, agents as agentApi } from "../index";
import { cfg } from "../server/config";
import { syncAgents, createAgents, agentsStats } from "../lib/agents";
import { InMemoryAgentMemory } from "../lib/agent";
import {
    anthropicMessages,
    normalizeFinishReason,
    openaiMessages,
    resolveBaseUrl,
    sseData,
} from "../lib/providers";
import { joiToJsonSchema, toJsonSchema, validateWithSchema } from "../lib/jsonSchema";
import { AppError } from "../lib/error";

// ─── Fake providers ──────────────────────────────────────────────────────

type Recorded = { path: string; body: any; headers: Record<string, string> };

type Fake = {
    requests: Recorded[];
    url: string;
    hits: () => number;
    stop: () => void;
};

/** A local HTTP endpoint that records what the agent sent and answers from a handler. */
function fakeProvider(handler: (body: any, req: Request, hits: number) => Response | Promise<Response>): Fake {
    const requests: Recorded[] = [];
    let hits = 0;
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: async (req) => {
            const body = await req.json().catch(() => null);
            requests.push({
                path: new URL(req.url).pathname,
                body,
                headers: Object.fromEntries(req.headers.entries()),
            });
            hits += 1;
            return handler(body, req, hits);
        },
    });
    return {
        requests,
        url: `http://127.0.0.1:${server.port}`,
        hits: () => hits,
        stop: () => server.stop(true),
    };
}

function request(provider: Fake, index = 0): Recorded {
    const recorded = provider.requests[index];
    if (!recorded) throw new Error(`No request #${index} was recorded (got ${provider.requests.length})`);
    return recorded;
}

/** Typed element access (`noUncheckedIndexedAccess` is on). */
function at<T>(list: T[], index = 0): T {
    const item = list[index];
    if (item === undefined) throw new Error(`No element #${index} (length ${list.length})`);
    return item;
}

const USAGE = { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 };
const A_USAGE = { input_tokens: 13, output_tokens: 6 };

function openaiText(text: string, finishReason = "stop"): Response {
    return Response.json({
        choices: [{ message: { role: "assistant", content: text }, finish_reason: finishReason }],
        usage: USAGE,
    });
}

function openaiTool(name: string, args: any, id = "call_1"): Response {
    return Response.json({
        choices: [{
            message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
            },
            finish_reason: "tool_calls",
        }],
        usage: USAGE,
    });
}

function openaiStream(pieces: string[]): Response {
    const events = pieces.map((text) => JSON.stringify({ choices: [{ delta: { content: text } }] }));
    events.push(JSON.stringify({ choices: [], usage: USAGE }));
    events.push(JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }));
    events.push("[DONE]");
    return new Response(events.map((event) => `data: ${event}\n\n`).join(""), {
        headers: { "Content-Type": "text/event-stream" },
    });
}

function anthropicText(text: string, stopReason = "end_turn"): Response {
    return Response.json({
        content: [{ type: "text", text }],
        stop_reason: stopReason,
        usage: A_USAGE,
    });
}

function anthropicTool(name: string, input: any, id = "toolu_1"): Response {
    return Response.json({
        content: [{ type: "tool_use", id, name, input }],
        stop_reason: "tool_use",
        usage: A_USAGE,
    });
}

function anthropicStream(pieces: string[]): Response {
    const events: string[] = [
        JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 9, output_tokens: 0 } } }),
        JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ];
    for (const text of pieces) {
        events.push(JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }));
    }
    events.push(JSON.stringify({ type: "content_block_stop", index: 0 }));
    events.push(JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }));
    events.push(JSON.stringify({ type: "message_stop" }));
    return new Response(events.map((event) => `data: ${event}\n\n`).join(""), {
        headers: { "Content-Type": "text/event-stream" },
    });
}

/** The tool used by most tests: a Joi-validated object, executed for real. */
function forecastTool(calls: any[] = []) {
    return define.Tool({
        description: "Current weather for a city",
        inputSchema: v.object({ city: v.string().required() }),
        execute: async ({ city }: any) => {
            calls.push(city);
            return { city, celsius: 21 };
        },
    });
}

function makeAgent(
    overrides: Record<string, any> = {},
    provider: Record<string, any> = {},
    options: Record<string, any> = {},
) {
    return new Agent({
        id: "test",
        instructions: "You are a test agent.",
        provider: {
            model: "test-model",
            apiKey: "test-key",
            compatible: "openai",
            // Deterministic by default: a test must not wait on the retry backoff
            options: { retries: 0, ...options },
            ...provider,
        },
        ...overrides,
    } as any);
}

const servers: Fake[] = [];
function track<T extends Fake>(fake: T): T {
    servers.push(fake);
    return fake;
}

afterAll(() => {
    for (const server of servers) server.stop();
});

// ─── Pure conversions ────────────────────────────────────────────────────

describe("providers — conversion", () => {
    it("normalizes finish reasons across both protocols", () => {
        expect(normalizeFinishReason("tool_calls")).toBe("tool_use");
        expect(normalizeFinishReason("end_turn")).toBe("stop");
        expect(normalizeFinishReason("max_tokens")).toBe("length");
        expect(normalizeFinishReason(null)).toBe("stop");
        expect(normalizeFinishReason("something_new")).toBe("something_new");
    });

    it("normalizes the base URL — a bare host gets /v1 on OpenAI-compatible", () => {
        expect(resolveBaseUrl({ model: "m" }, "openai")).toBe("https://api.openai.com/v1");
        expect(resolveBaseUrl({ model: "m", baseUrl: "http://localhost:11434" }, "openai")).toBe("http://localhost:11434/v1");
        expect(resolveBaseUrl({ model: "m", baseUrl: "https://api.groq.com/openai/" }, "openai")).toBe("https://api.groq.com/openai");
        expect(resolveBaseUrl({ model: "m", baseUrl: "https://api.anthropic.com/" }, "anthropic")).toBe("https://api.anthropic.com");
    });

    it("converts messages to the OpenAI shape (tool calls echoed, images inlined)", () => {
        const messages = openaiMessages("sys", [
            { role: "user", content: "hi" },
            { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "f", args: { a: 1 }, argsText: '{"a":1}' }] },
            { role: "tool", toolCallId: "c1", name: "f", content: "42" },
            { role: "user", content: [{ type: "image", data: "AAA", mimeType: "image/jpeg" }] },
        ]);

        expect(messages[0]).toEqual({ role: "system", content: "sys" });
        expect(messages[2].tool_calls[0]).toEqual({
            id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' },
        });
        expect(messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "42" });
        expect(messages[4].content[0].image_url.url).toBe("data:image/jpeg;base64,AAA");
    });

    it("converts messages to the Anthropic shape (tool results merged into one user turn)", () => {
        const { system, messages } = anthropicMessages([
            { role: "system", content: "inline system" },
            { role: "user", content: "hi" },
            { role: "assistant", content: "let me check", toolCalls: [{ id: "t1", name: "f", args: { a: 1 } }] },
            { role: "tool", toolCallId: "t1", name: "f", content: "42" },
            { role: "tool", toolCallId: "t2", name: "g", content: "43", isError: true },
        ]);

        expect(system).toBe("inline system");
        expect(messages[1].content[0]).toEqual({ type: "text", text: "let me check" });
        expect(messages[1].content[1]).toEqual({ type: "tool_use", id: "t1", name: "f", input: { a: 1 } });
        // Both results land in a single `user` message
        expect(messages[2].role).toBe("user");
        expect(messages[2].content).toHaveLength(2);
        expect(messages[2].content[0]).toEqual({ type: "tool_result", tool_use_id: "t1", content: "42" });
        expect(messages[2].content[1].is_error).toBe(true);
    });

    it("reads SSE data payloads (CRLF and multi-line included)", async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                const encoder = new TextEncoder();
                controller.enqueue(encoder.encode("data: one\r\n\r\n"));
                controller.enqueue(encoder.encode("data: two\n\n: comment\ndata: three\n\n"));
                controller.close();
            },
        });
        const seen: string[] = [];
        for await (const data of sseData(stream)) seen.push(data);
        expect(seen).toEqual(["one", "two", "three"]);
    });
});

describe("jsonSchema", () => {
    it("converts a Joi object to JSON Schema, required fields included", () => {
        const schema = joiToJsonSchema(v.object({
            city: v.string().required().description("City name"),
            days: v.number().integer().default(3),
            tags: v.array().items(v.string()),
        }));
        expect(schema.type).toBe("object");
        expect(schema.properties.city).toEqual({ type: "string", description: "City name" });
        expect(schema.properties.days.type).toBe("number");
        expect(schema.properties.tags).toEqual({ type: "array", items: { type: "string" } });
        expect(schema.required).toEqual(["city"]);
    });

    it("validates with Joi and reports the offending path", async () => {
        const schema = v.object({ city: v.string().required() });
        expect(await validateWithSchema(schema, { city: "Paris" })).toEqual({ value: { city: "Paris" }, error: null });
        const invalid = await validateWithSchema(schema, { city: 12 });
        expect(invalid.error).toContain("city");
    });

    it("passes a plain JSON Schema through and keeps an open object by default", async () => {
        const raw = { type: "object", properties: { a: { type: "string" } } };
        expect(await toJsonSchema(raw)).toBe(raw);
        expect(await toJsonSchema(undefined)).toEqual({ type: "object", properties: {}, additionalProperties: true });
    });
});

// ─── Agent — identity, tools, provider ───────────────────────────────────

describe("Agent", () => {
    it("refuses a definition without instructions or provider.model", () => {
        expect(() => new Agent({ provider: { model: "m" } } as any)).toThrow(/instructions/);
        expect(() => new Agent({ instructions: "x" } as any)).toThrow(/provider\.model/);
    });

    it("marks definitions through define.Agent / define.Tool", () => {
        const definition = define.Agent({ instructions: "x", provider: { model: "m" } });
        expect(definition._isAgent_).toBe(true);
        expect(definition.enabled).toBe(true);

        const tool = define.Tool({ execute: () => 1 });
        expect(tool._isTool_).toBe(true);
        expect(tool.enabled).toBe(true);
    });

    it("registers tools by key, validates their handler, and lists them", () => {
        const agent = makeAgent({ tools: { forecast: forecastTool() } });
        expect(agent.hasTool("forecast")).toBe(true);
        expect(Object.keys(agent.getTools())).toEqual(["forecast"]);

        expect(() => agent.addTool({ description: "no handler" } as any, "broken")).toThrow(/execute/);
        expect(agent.removeTool("forecast")).toBe(true);
        expect(agent.hasTool("forecast")).toBe(false);
    });

    it("never exposes the API key in getProvider() / toJSON()", () => {
        const agent = makeAgent({ tools: { forecast: forecastTool() } }, { apiKey: "super-secret" });
        expect(agent.getProvider().apiKey).toBeUndefined();
        const json = JSON.stringify(agent.toJSON());
        expect(json).not.toContain("super-secret");
        expect(json).toContain("test-model");
        expect(agent.toJSON().tools).toEqual(["forecast"]);
    });

    it("keeps the provider's options under `provider.options`", () => {
        const agent = makeAgent({}, {}, { temperature: 0.2, maxTokens: 1000 });
        const declared = { model: "test-model", compatible: "openai", options: { retries: 0, temperature: 0.2, maxTokens: 1000 } };

        expect(agent.getProvider()).toEqual(declared);
        expect(agent.toJSON().provider.options).toEqual(declared.options);
        expect(agent.setOptions({ topP: 0.5 }).getOptions().topP).toBe(0.5);
        expect(agent.setProvider({ model: "other" }).getOptions()).toEqual({ retries: 0, temperature: 0.2, maxTokens: 1000, topP: 0.5 });
    });

    it("resolves dynamic instructions per call", async () => {
        const agent = makeAgent({ instructions: ({ resourceId }: any) => `Hello ${resourceId}` });
        expect(await agent.resolveInstructions({ resourceId: "acme" })).toBe("Hello acme");
        expect(agent.getInstructions()).toBeInstanceOf(Function);
        expect(agent.setInstructions("static").getInstructions()).toBe("static");
    });

    it("exposes the in-memory memory through the public helper", async () => {
        const memory = new InMemoryAgentMemory();
        const agent = makeAgent({ memory });
        expect(agent.getMemory()).toBe(memory);
        await memory.save("t", [{ role: "user", content: "hi" }]);
        expect(await agent.getMessages("t")).toHaveLength(1);
        await agent.clearMessages("t");
        expect(await agent.getMessages("t")).toEqual([]);
        expect(agentApi.memory.InMemory).toBe(InMemoryAgentMemory);
    });
});

// ─── generate() ──────────────────────────────────────────────────────────

describe("agent.generate", () => {
    it("sends the instructions as a system message and returns text + usage", async () => {
        const provider = track(fakeProvider(() => openaiText("Hello world")));
        const agent = makeAgent({}, { baseUrl: provider.url });

        const result = await agent.generate("hi");

        expect(result.text).toBe("Hello world");
        expect(result.finishReason).toBe("stop");
        expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 4, totalTokens: 15, requests: 1 });
        expect(result.steps).toHaveLength(1);
        // A bare host gets `/v1` appended on the OpenAI-compatible protocol
        expect(request(provider, 0).path).toBe("/v1/chat/completions");
        expect(request(provider, 0).headers.authorization).toBe("Bearer test-key");
        expect(request(provider, 0).body.messages).toEqual([
            { role: "system", content: "You are a test agent." },
            { role: "user", content: "hi" },
        ]);
    });

    it("sends the generation options, and lets a call override them", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const agent = makeAgent({}, { baseUrl: provider.url }, { temperature: 0.3, maxTokens: 100, topP: 0.9 });

        await agent.generate("hi");
        expect(request(provider, 0).body.temperature).toBe(0.3);
        expect(request(provider, 0).body.max_tokens).toBe(100);
        expect(request(provider, 0).body.top_p).toBe(0.9);

        await agent.generate("hi", { provider: { options: { temperature: 0, maxTokens: 500 } } });
        expect(request(provider, 1).body.temperature).toBe(0);
        expect(request(provider, 1).body.max_tokens).toBe(500);
        expect(request(provider, 1).body.top_p).toBe(0.9); // untouched by the call
    });

    it("enforces the configured timeout", async () => {
        const provider = track(fakeProvider(async () => {
            await Bun.sleep(150);
            return openaiText("too late");
        }));
        const agent = makeAgent({}, { baseUrl: provider.url }, { timeout: 40 });

        await expect(agent.generate("hi")).rejects.toMatchObject({ code: "AGENT_PROVIDER_TIMEOUT" });
    });

    it("runs the tool loop and feeds the result back to the model", async () => {
        const cities: any[] = [];
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? openaiTool("forecast", { city: "Paris" }) : openaiText("Paris is 21°C.")));

        const agent = makeAgent({ tools: { forecast: forecastTool(cities) } }, { baseUrl: provider.url });
        const result = await agent.generate("Weather?");

        expect(cities).toEqual(["Paris"]);
        expect(result.text).toBe("Paris is 21°C.");
        expect(result.finishReason).toBe("stop");
        expect(result.toolCalls).toEqual([{ id: "call_1", name: "forecast", args: { city: "Paris" }, argsText: '{"city":"Paris"}' }]);
        expect(at(result.toolResults, 0).result).toEqual({ city: "Paris", celsius: 21 });
        expect(at(result.toolResults, 0).error).toBeUndefined();
        expect(result.steps).toHaveLength(2);
        expect(result.usage.requests).toBe(2);

        // The tool was advertised in JSON Schema…
        const tools = request(provider, 0).body.tools;
        expect(tools[0].function.name).toBe("forecast");
        expect(tools[0].function.description).toBe("Current weather for a city");
        expect(tools[0].function.parameters.properties.city.type).toBe("string");
        expect(tools[0].function.parameters.required).toEqual(["city"]);

        // …and the second call carries the assistant turn + the tool result
        const second = request(provider, 1).body.messages;
        expect(second).toHaveLength(4);
        expect(second[2].role).toBe("assistant");
        expect(second[2].tool_calls[0].id).toBe("call_1");
        expect(second[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: '{"city":"Paris","celsius":21}' });
    });

    it("reports invalid tool arguments instead of running the tool", async () => {
        const cities: any[] = [];
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? openaiTool("forecast", { city: 42 }) : openaiText("sorry")));

        const agent = makeAgent({ tools: { forecast: forecastTool(cities) } }, { baseUrl: provider.url });
        const result = await agent.generate("Weather?");

        expect(cities).toEqual([]);
        expect(at(result.toolResults, 0).error).toContain("Invalid arguments for tool 'forecast'");
        expect(request(provider, 1).body.messages[3].content).toContain("Error:");
    });

    it("reports an unknown tool and a throwing tool, and keeps going", async () => {
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1
                ? openaiTool("nope", {})
                : hits === 2
                    ? openaiTool("boom", {}, "call_2")
                    : openaiText("done")));

        const agent = makeAgent({
            tools: {
                boom: define.Tool({ execute: () => { throw new Error("kaboom"); } }),
            },
        }, { baseUrl: provider.url });

        const result = await agent.generate("go");

        expect(result.text).toBe("done");
        expect(at(result.toolResults, 0).error).toBe("Unknown tool 'nope'");
        expect(at(result.toolResults, 1).error).toBe("kaboom");
        expect(result.usage.requests).toBe(3);
    });

    it("flattens an MCP tool result to its text", async () => {
        const mcpTool = define.McpTool({
            name: "echo",
            description: "Echoes the message",
            inputSchema: v.object({ msg: v.string().required() }),
            exec: async ({ args }: any) => ({ content: [{ type: "text", text: `echoed:${args.msg}` }] }),
        });
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? openaiTool("echo", { msg: "hi" }) : openaiText("ok")));

        const agent = makeAgent({ tools: { echo: mcpTool } }, { baseUrl: provider.url });
        const result = await agent.generate("ping");

        expect(result.text).toBe("ok");
        expect(request(provider, 1).body.messages[3].content).toBe("echoed:hi");
    });

    it("stops at maxSteps and says so", async () => {
        const provider = track(fakeProvider(() => openaiTool("forecast", { city: "Paris" })));
        const agent = makeAgent({ tools: { forecast: forecastTool() }, maxSteps: 3 }, { baseUrl: provider.url });

        const result = await agent.generate("Weather?");

        expect(provider.hits()).toBe(3);
        expect(result.finishReason).toBe("max_steps");
        expect(result.steps).toHaveLength(3);
    });

    it("returns a partial result when the caller aborts before the first call", async () => {
        const provider = track(fakeProvider(() => openaiText("never")));
        const agent = makeAgent({}, { baseUrl: provider.url });

        const result = await agent.generate("hi", { signal: AbortSignal.abort() });

        expect(result.finishReason).toBe("aborted");
        expect(result.text).toBe("");
        expect(provider.hits()).toBe(0);
    });

    it("raises a stable error when the provider rejects the request", async () => {
        const provider = track(fakeProvider(() => Response.json({ error: { message: "bad model" } }, { status: 400 })));
        const agent = makeAgent({}, { baseUrl: provider.url });

        await expect(agent.generate("hi")).rejects.toThrow(/bad model/);
        expect(provider.hits()).toBe(1); // 400 is not retried
    });

    it("retries 5xx up to the configured count", async () => {
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits < 3 ? new Response("upstream down", { status: 503 }) : openaiText("finally")));
        const agent = makeAgent({}, { baseUrl: provider.url }, { retries: 2 });

        const result = await agent.generate("hi");

        expect(result.text).toBe("finally");
        expect(provider.hits()).toBe(3);
    });

    it("requires an API key, with the environment as fallback", async () => {
        const provider = track(fakeProvider(() => anthropicText("ok")));
        const previous = { a: Bun.env.ANTEROS_AI_API_KEY, o: Bun.env.ANTHROPIC_API_KEY };
        delete Bun.env.ANTEROS_AI_API_KEY;
        delete Bun.env.ANTHROPIC_API_KEY;

        try {
            const agent = makeAgent({}, { compatible: "anthropic", apiKey: undefined, baseUrl: provider.url });
            await expect(agent.generate("hi")).rejects.toMatchObject({ code: "AGENT_PROVIDER_NO_API_KEY" });

            Bun.env.ANTHROPIC_API_KEY = "from-env";
            const result = await agent.generate("hi");
            expect(result.text).toBe("ok");
            expect(request(provider, 0).headers["x-api-key"]).toBe("from-env");
        } finally {
            if (previous.a === undefined) delete Bun.env.ANTEROS_AI_API_KEY;
            else Bun.env.ANTEROS_AI_API_KEY = previous.a;
            if (previous.o === undefined) delete Bun.env.ANTHROPIC_API_KEY;
            else Bun.env.ANTHROPIC_API_KEY = previous.o;
        }
    });
});

// ─── Anthropic ───────────────────────────────────────────────────────────

describe("agent with an Anthropic-compatible provider", () => {
    it("puts the system prompt out of band and returns the text", async () => {
        const provider = track(fakeProvider(() => anthropicText("Bonjour")));
        const agent = makeAgent({}, { compatible: "anthropic", baseUrl: provider.url });

        const result = await agent.generate("salut");

        expect(result.text).toBe("Bonjour");
        expect(result.usage).toEqual({ inputTokens: 13, outputTokens: 6, totalTokens: 19, requests: 1 });
        expect(request(provider, 0).path).toBe("/v1/messages");
        expect(request(provider, 0).headers["x-api-key"]).toBe("test-key");
        expect(request(provider, 0).headers["anthropic-version"]).toBe("2023-06-01");
        expect(request(provider, 0).body.system).toBe("You are a test agent.");
        expect(request(provider, 0).body.max_tokens).toBe(4096);
    });

    it("parses tool_use and sends the result back as a tool_result user turn", async () => {
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? anthropicTool("forecast", { city: "Lyon" }) : anthropicText("Lyon: 21°C")));

        const agent = makeAgent({ tools: { forecast: forecastTool() } }, { compatible: "anthropic", baseUrl: provider.url });
        const result = await agent.generate("Weather in Lyon?");

        expect(result.text).toBe("Lyon: 21°C");
        expect(result.toolCalls[0]).toEqual({ id: "toolu_1", name: "forecast", args: { city: "Lyon" }, argsText: '{"city":"Lyon"}' });

        const tools = request(provider, 0).body.tools;
        expect(tools[0].name).toBe("forecast");
        expect(tools[0].input_schema.properties.city.type).toBe("string");

        const second = request(provider, 1).body.messages;
        // system is out of band — the conversation starts at the user turn
        expect(second[1].content[0]).toEqual({ type: "tool_use", id: "toolu_1", name: "forecast", input: { city: "Lyon" } });
        expect(second[2].content[0].type).toBe("tool_result");
        expect(second[2].content[0].tool_use_id).toBe("toolu_1");
    });

    it("streams text deltas and merges the partial usage", async () => {
        const provider = track(fakeProvider(() => anthropicStream(["Bon", "jour"])));
        const agent = makeAgent({}, { compatible: "anthropic", baseUrl: provider.url });

        const stream = agent.stream("salut");
        let text = "";
        for await (const chunk of stream.textStream) text += chunk;

        expect(text).toBe("Bonjour");
        expect(await stream.text).toBe("Bonjour");
        expect(await stream.usage).toEqual({ inputTokens: 9, outputTokens: 5, totalTokens: 14, requests: 1 });
        expect(await stream.finishReason).toBe("stop");
    });
});

// ─── stream() ────────────────────────────────────────────────────────────

describe("agent.stream", () => {
    it("streams the tokens and resolves the promises at the end of the run", async () => {
        const provider = track(fakeProvider(() => openaiStream(["Hel", "lo ", "world"])));
        const agent = makeAgent({}, { baseUrl: provider.url });

        const stream = agent.stream("hi");
        const chunks: string[] = [];
        for await (const chunk of stream.textStream) chunks.push(chunk);

        expect(chunks).toEqual(["Hel", "lo ", "world"]);
        expect(await stream.text).toBe("Hello world");
        expect(await stream.steps).toHaveLength(1);
        expect(await stream.finishReason).toBe("stop");
        expect((await stream.usage).requests).toBe(1);
        expect(await stream.messages).toHaveLength(2); // system is not part of the conversation
    });

    it("streams a tool round and exposes both channels", async () => {
        const provider = track(fakeProvider((_body, _req, hits) => {
            if (hits > 1) return openaiStream(["21", "°C"]);
            const events = [
                JSON.stringify({ choices: [{ delta: { content: "Let me check. " } }] }),
                JSON.stringify({
                    choices: [{
                        delta: {
                            tool_calls: [{
                                index: 0, id: "call_1", function: { name: "forecast", arguments: '{"city":' },
                            }],
                        },
                    }],
                }),
                JSON.stringify({
                    choices: [{
                        delta: {
                            tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }],
                        },
                        finish_reason: "tool_calls",
                    }],
                }),
                JSON.stringify({ choices: [], usage: USAGE }),
                "[DONE]",
            ];
            return new Response(events.map((event) => `data: ${event}\n\n`).join(""), {
                headers: { "Content-Type": "text/event-stream" },
            });
        }));

        const agent = makeAgent({ tools: { forecast: forecastTool() } }, { baseUrl: provider.url });
        const stream = agent.stream("Weather?");
        const kinds: string[] = [];
        for await (const chunk of stream.fullStream) kinds.push(chunk.type);

        expect(kinds).toContain("text");
        expect(kinds).toContain("tool_result");
        expect(kinds).toContain("finish");
        expect(await stream.toolCalls).toEqual([
            { id: "call_1", name: "forecast", args: { city: "Paris" }, argsText: '{"city":"Paris"}' },
        ]);
        expect(await stream.text).toBe("21°C");
        expect((await stream.usage).requests).toBe(2);
    });

    it("fails the stream when the provider is rejected", async () => {
        const provider = track(fakeProvider(() => new Response("nope", { status: 400 })));
        const agent = makeAgent({}, { baseUrl: provider.url });

        const stream = agent.stream("hi");
        let thrown: any;
        try {
            for await (const _chunk of stream.textStream) { /* draining */ }
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(AppError);
        expect(thrown.code).toBe("AGENT_PROVIDER_ERROR");
    });
});

// ─── Memory ──────────────────────────────────────────────────────────────

describe("agent memory", () => {
    it("replays the thread and stores the new exchange", async () => {
        const provider = track(fakeProvider((_body, _req, hits) => openaiText(`answer ${hits}`)));
        const memory = new InMemoryAgentMemory();
        const agent = makeAgent({ memory }, { baseUrl: provider.url });

        await agent.generate("first", { threadId: "t1" });
        await agent.generate("second", { threadId: "t1" });

        const second = request(provider, 1).body.messages;
        expect(second.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "user"]);
        expect(second[1].content).toBe("first");
        expect(second[2].content).toBe("answer 1");
        expect(second[3].content).toBe("second");

        expect(await agent.getMessages("t1")).toHaveLength(4);
        // A different thread starts over
        await agent.generate("other", { threadId: "t2" });
        expect(request(provider, 2).body.messages).toHaveLength(2);
    });

    it("reads without writing when the memory is read-only", async () => {
        const memory = new InMemoryAgentMemory();
        await memory.save("t1", [{ role: "user", content: "old" }]);
        const provider = track(fakeProvider(() => openaiText("ok")));
        const agent = makeAgent({ memory }, { baseUrl: provider.url });

        await agent.generate("new", { threadId: "t1", memory: { threadId: "t1", readOnly: true } });

        expect(request(provider, 0).body.messages.map((m: any) => m.content)).toEqual([
            "You are a test agent.", "old", "new",
        ]);
        expect(await agent.getMessages("t1")).toHaveLength(1);
    });
});

// ─── Structured output ───────────────────────────────────────────────────

describe("agent structured output", () => {
    const schema = v.object({ city: v.string().required(), celsius: v.number().required() });
    const answer = '```json\n{"city":"Paris","celsius":21}\n```';

    it("parses and validates the answer (generateObject)", async () => {
        const provider = track(fakeProvider(() => openaiText(answer)));
        const agent = makeAgent({}, { baseUrl: provider.url });

        const object = await agent.generateObject("Weather?", { schema });

        expect(object).toEqual({ city: "Paris", celsius: 21 });
        // The schema was injected in the prompt and asked for a JSON object
        expect(request(provider, 0).body.messages[0].content).toContain("JSON Schema");
        expect(request(provider, 0).body.response_format).toEqual({ type: "json_object" });
    });

    it("repairs an invalid answer with one extra turn", async () => {
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? openaiText("I think it is 21 degrees in Paris") : openaiText(answer)));
        const agent = makeAgent({}, { baseUrl: provider.url });

        const result = await agent.generate("Weather?", { schema });

        expect(result.object).toEqual({ city: "Paris", celsius: 21 });
        expect(provider.hits()).toBe(2);
        expect(request(provider, 1).body.messages.at(-1).content).toContain("rejected");
    });

    it("fails with AGENT_OUTPUT_INVALID when it stays invalid", async () => {
        const provider = track(fakeProvider(() => openaiText("still not json")));
        const agent = makeAgent({}, { baseUrl: provider.url });

        await expect(agent.generate("Weather?", { schema })).rejects.toMatchObject({ code: "AGENT_OUTPUT_INVALID" });
        expect(provider.hits()).toBe(2);
    });

    it("refuses generateObject without a schema", async () => {
        const agent = makeAgent({});
        await expect(agent.generateObject("hi")).rejects.toThrow(/requires a `schema`/);
    });
});

// ─── Loader ──────────────────────────────────────────────────────────────

describe("syncAgents", () => {
    const TENANT = "agent-fixture";
    const TENANT_DIR = "packages/core/tests/fixtures/agent-tenant";

    beforeAll(async () => {
        cfg.tenants = [{ id: TENANT, dir: TENANT_DIR, database: { uri: "mongodb://localhost:27017/none" } }] as any;
        await syncAgents();
    });

    afterAll(() => {
        cfg.agents = [];
        cfg.tenants = [];
    });

    it("loads the definitions, the file name becoming the default id", () => {
        expect(cfg.agents?.map((agent) => agent.id).sort()).toEqual(["support", "weather"]);
    });

    it("instantiates them per tenant with their tools", () => {
        const registry = createAgents(TENANT);
        expect(registry.ids().sort()).toEqual(["support", "weather"]);
        expect(registry.has("weather")).toBe(true);

        const weather = registry.get("weather")!;
        expect(weather).toBeInstanceOf(Agent);
        expect(weather.getTenant()).toBe(TENANT);
        expect(weather.getName()).toBe("Weather Agent");
        expect(weather.hasTool("forecast")).toBe(true);

        expect(registry.get("support")!.getModel()).toBe("claude-test");
        expect(registry.get("missing")).toBeUndefined();
        expect(registry.list()).toHaveLength(2);
    });

    it("binds the calling rest to the returned agent", () => {
        const fakeRest = { tenant_id: TENANT } as any;
        const agent = createAgents(TENANT, fakeRest).get("weather")!;
        expect(agent.getRest()).toBe(fakeRest);
    });

    it("is reachable through `rest.agents` on a real client", async () => {
        const { useRest } = await import("../database/rest");
        const rest = new useRest({ tenant_id: TENANT });

        expect(rest.agents.ids().sort()).toEqual(["support", "weather"]);
        expect(rest.agents.has("weather")).toBe(true);
        expect(rest.agents.get("weather")!.getRest()).toBe(rest);
        expect(rest.agents.get("support")!.getModel()).toBe("claude-test");
    });

    it("counts what it loaded for the boot banner", () => {
        expect(agentsStats()).toEqual({ total: 2, tenants: [TENANT] });
    });
});
