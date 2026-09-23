import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { define, v, Agent, agents } from "../index";
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
import {
    A_USAGE,
    USAGE,
    anthropicStream,
    anthropicText,
    anthropicTool,
    at,
    fakeProvider,
    openaiStream,
    openaiText,
    openaiTool,
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

/** The tool used by most tests: a Joi-validated object, executed for real. */
function forecastTool(calls: any[] = []) {
    return define.Tool({
        id: "forecast",
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
        description: "A test agent.",
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

describe("agent … files", () => {
    const attachmentAgent = (providerOverrides: Record<string, any> = {}, overrides: Record<string, any> = {}) =>
        new Agent({
            id: "files",
            description: "A test agent.",
            instructions: "You are a test agent.",
            provider: {
                model: "test-model",
                apiKey: "test-key",
                compatible: "openai",
                options: { retries: 0 },
                ...providerOverrides,
            },
            ...overrides,
        } as any);

    it("attaches a file to the turn being asked, as a text part", async () => {
        const provider = track(fakeProvider(() => openaiText("got it")));
        const agent = attachmentAgent({ baseUrl: provider.url });

        const result = await agent.generate("What are the totals?", {
            files: ["packages/core/tests/fixtures/attachment/data.csv"],
        });

        expect(result.text).toBe("got it");
        const user = at<any>(request(provider, 0).body.messages, 1);
        expect(user.role).toBe("user");
        expect(user.content[0]).toEqual({ type: "text", text: "What are the totals?" });
        expect(user.content[1].text).toContain("--- data.csv ---");
        expect(user.content[1].text).toContain("ref,total");
    });

    it("sends an image as an image part (base64)", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const agent = attachmentAgent({ baseUrl: provider.url });

        await agent.generate("What is on this screenshot?", {
            files: [{ name: "shot.png", data: Buffer.from("PNG!").toString("base64") }],
        });

        const user = at<any>(request(provider, 0).body.messages, 1);
        expect(user.content[1]).toEqual({
            type: "image_url",
            image_url: { url: `data:image/png;base64,${Buffer.from("PNG!").toString("base64")}` },
        });
    });

    it("keeps the text in the memory, and a note for the binaries", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const memory = new InMemoryAgentMemory();
        const agent = attachmentAgent({ baseUrl: provider.url }, { memory });

        await agent.generate("Summarize this", {
            thread: "f1",
            files: [
                "packages/core/tests/fixtures/attachment/data.csv",
                { name: "shot.png", data: Buffer.from("PNG!").toString("base64") },
                { name: "invoice.pdf", data: Buffer.from("%PDF-1.7").toString("base64") },
            ],
        });

        const stored = await agent.getMessages("f1");
        const content = at(stored, 0).content as any;

        expect(content).toContain("Summarize this");
        // A text file is conversational: it replays with the thread
        expect(content).toContain("--- data.csv ---");
        expect(content).toContain("ref,total");
        // A binary is not: the payload never reaches the store
        expect(content).toContain("[image]");
        expect(content).toContain("[file invoice.pdf]");
        expect(content).not.toContain(Buffer.from("PNG!").toString("base64"));
        expect(content).not.toContain("%PDF-1.7");
    });

    it("refuses an unreadable file before calling the model", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const agent = attachmentAgent({ baseUrl: provider.url });

        await expect(agent.generate("hi", { files: [{ name: "old.doc", data: "AAAA" }] }))
            .rejects.toMatchObject({ code: "AGENT_FILE_UNSUPPORTED" });
        expect(provider.hits()).toBe(0);
    });
});

describe("agent … unified messages", () => {
    it("accepts one message, or a whole conversation", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const agent = makeAgent({}, { baseUrl: provider.url });

        await agent.generate({ role: "user", content: "hi" });
        expect(request(provider, 0).body.messages.map((m: any) => m.role)).toEqual(["system", "user"]);
        expect(at<any>(request(provider, 0).body.messages, 1).content).toBe("hi");

        await agent.generate([
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
            { role: "user", content: "and?" },
        ]);
        expect(request(provider, 1).body.messages.map((m: any) => m.role))
            .toEqual(["system", "user", "assistant", "user"]);
    });

    it("replays a tool round written with `tool-call` / `tool-result` parts", async () => {
        const provider = track(fakeProvider(() => openaiText("21°C and sunny")));
        const agent = makeAgent({}, { baseUrl: provider.url });

        const result = await agent.generate([
            { role: "user", content: "Weather in Paris?" },
            {
                role: "assistant",
                content: [{ type: "tool-call", id: "call_1", name: "forecast", arguments: { city: "Paris" } }],
            },
            {
                role: "user",
                content: [{ type: "tool-result", id: "call_1", name: "forecast", result: { celsius: 21 } }],
            },
            { role: "user", content: [{ type: "text", text: "and in Lyon?" }] },
        ] as any);

        // The parts become the turns they mean — the provider sees a normal tool round
        const messages = request(provider, 0).body.messages;
        expect(messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
        expect(messages[2].tool_calls[0]).toEqual({
            id: "call_1",
            type: "function",
            function: { name: "forecast", arguments: '{"city":"Paris"}' },
        });
        expect(messages[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: '{"celsius":21}' });
        expect(messages[4].content).toEqual([{ type: "text", text: "and in Lyon?" }]);

        expect(result.text).toBe("21°C and sunny");
    });

    it("refuses a conversation the model could not have seen", async () => {
        const agent = makeAgent({}, { baseUrl: "http://127.0.0.1:1" });

        const error: any = await agent.generate([
            { role: "assistant", content: [{ type: "image", url: "https://example.com/a.png" }] },
        ] as any).catch((err) => err);

        expect(error).toBeInstanceOf(Error);
        expect(error.code).toBe("INVALID_INPUT");
        expect(error.status).toBe(400);
    });
});

describe("agent … tools & thinking options", () => {
    const toolAgent = (providerOverrides: Record<string, any> = {}, overrides: Record<string, any> = {}) =>
        new Agent({
            id: "opts",
            description: "A test agent.",
            instructions: "You are a test agent.",
            provider: {
                model: "test-model",
                apiKey: "test-key",
                compatible: "openai",
                options: { retries: 0 },
                ...providerOverrides,
            },
            tools: {
                forecast: forecastTool(),
                echo: { id: "echo", description: "echo", execute: () => "ok" },
            },
            ...overrides,
        } as any);

    it("sends no tool at all with `tools: false`", async () => {
        const provider = track(fakeProvider(() => openaiText("direct")));
        const agent = toolAgent({ baseUrl: provider.url });

        const result = await agent.generate("hi", { tools: false });

        expect(result.text).toBe("direct");
        expect(request(provider, 0).body.tools).toBeUndefined();
        expect(request(provider, 0).body.tool_choice).toBeUndefined();
        // Nothing was offered, and the step says so
        expect(at(result.steps, 0).tools).toBeUndefined();
    });

    it("restricts the run to a list of tool names", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const agent = toolAgent({ baseUrl: provider.url });

        const result = await agent.generate("hi", { tools: ["echo", "not-declared"] });

        const names = request(provider, 0).body.tools.map((tool: any) => tool.function.name);
        expect(names).toEqual(["echo"]); // an unknown name is ignored, not fatal

        // What was sent is on the step — the answer to "why didn't it call X?"
        expect(at(result.steps, 0).tools).toEqual(["echo"]);
    });

    it("`tools: true` sends everything the agent declares, and a record merges in", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const agent = toolAgent({ baseUrl: provider.url });

        await agent.generate("hi", { tools: true });
        expect(request(provider, 0).body.tools.map((tool: any) => tool.function.name)).toEqual(["forecast", "echo"]);

        await agent.generate("hi", { tools: { extra: { id: "extra", description: "extra", execute: () => "x" } } });
        expect(request(provider, 1).body.tools.map((tool: any) => tool.function.name))
            .toEqual(["forecast", "echo", "extra"]);
    });

    it("forwards `toolChoice` to the provider", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const agent = toolAgent({ baseUrl: provider.url });

        await agent.generate("hi", { toolChoice: "required" });
        expect(request(provider, 0).body.tool_choice).toBe("required");

        await agent.generate("hi", { toolChoice: "none" });
        expect(request(provider, 1).body.tool_choice).toBe("none");

        await agent.generate("hi", { toolChoice: { name: "forecast" } });
        expect(request(provider, 2).body.tool_choice).toEqual({ type: "function", function: { name: "forecast" } });

        // `'auto'` is the default — it reaches OpenAI as `'auto'`, and is omitted on Anthropic
        await agent.generate("hi", { toolChoice: "auto" });
        expect(request(provider, 3).body.tool_choice).toBe("auto");
    });

    it("lets a call release a tool choice declared on the agent", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const agent = toolAgent({ baseUrl: provider.url }, { toolChoice: { name: "forecast" } });

        await agent.generate("hi");
        expect(request(provider, 0).body.tool_choice).toEqual({ type: "function", function: { name: "forecast" } });

        // The declaration is a default: `'auto'` gives the choice back to the model
        await agent.generate("hi", { toolChoice: "auto" });
        expect(request(provider, 1).body.tool_choice).toBe("auto");

        const anthropic = track(fakeProvider(() => anthropicText("ok")));
        const forced = toolAgent({ compatible: "anthropic", baseUrl: anthropic.url }, { toolChoice: { name: "forecast" } });
        await forced.generate("hi");
        expect(request(anthropic, 0).body.tool_choice).toEqual({ type: "tool", name: "forecast" });
        await forced.generate("hi", { toolChoice: "auto" });
        expect(request(anthropic, 1).body.tool_choice).toBeUndefined();
    });

    it("maps `thinking` to a reasoning effort on OpenAI-compatible endpoints", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const agent = toolAgent({ baseUrl: provider.url });

        await agent.generate("hi");
        expect(request(provider, 0).body.reasoning_effort).toBeUndefined();

        await agent.generate("hi", { thinking: "high" });
        expect(request(provider, 1).body.reasoning_effort).toBe("high");

        await agent.generate("hi", { thinking: { budgetTokens: 2048 } });
        expect(request(provider, 2).body.reasoning_effort).toBe("low"); // a budget, rounded to a level
    });

    it("takes `thinking` from the declaration, and lets a call override or switch it off", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const agent = toolAgent({ baseUrl: provider.url }, { thinking: "high" });

        // Declared once — no per-call option needed
        await agent.generate("hi");
        expect(request(provider, 0).body.reasoning_effort).toBe("high");

        await agent.generate("hi", { thinking: "low" });
        expect(request(provider, 1).body.reasoning_effort).toBe("low");

        // `false` is a value, not an absence: it turns the declaration off for one run
        await agent.generate("hi", { thinking: false });
        expect(request(provider, 2).body.reasoning_effort).toBeUndefined();
    });

    it("maps `thinking` to a real budget on Anthropic, and raises max_tokens above it", async () => {
        const provider = track(fakeProvider(() => anthropicText("ok")));
        const agent = toolAgent(
            { compatible: "anthropic", baseUrl: provider.url, options: { retries: 0, maxTokens: 2000, temperature: 0.5 } },
        );

        await agent.generate("hi", { thinking: true });

        const body = request(provider, 0).body;
        expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
        expect(body.max_tokens).toBe(4096 + 1024);        // raised above the budget
        expect(body.temperature).toBeUndefined();          // thinking requires the default

        await agent.generate("hi", { thinking: { budgetTokens: 1_500 } });
        expect(request(provider, 1).body.thinking).toEqual({ type: "enabled", budget_tokens: 1_500 });
    });

    it("refuses a thinking budget that makes no sense", async () => {
        const agent = toolAgent();
        await expect(agent.generate("hi", { thinking: { budgetTokens: 12 } }))
            .rejects.toMatchObject({ code: "AGENT_THINKING_INVALID" });
    });

    it("surfaces the reasoning without mixing it into the answer", async () => {
        const provider = track(fakeProvider(() => Response.json({
            content: [
                { type: "thinking", thinking: "Let me check the tool list.", signature: "sig-1" },
                { type: "text", text: "I need the forecast." },
                { type: "tool_use", id: "toolu_1", name: "forecast", input: { city: "Paris" } },
            ],
            stop_reason: "tool_use",
            usage: A_USAGE,
        })));
        const agent = toolAgent({ compatible: "anthropic", baseUrl: provider.url });

        await agent.generate("Weather?", { thinking: 'medium' });

        // The tool round echoes the **signed** reasoning block first
        const second = request(provider, 1).body.messages;
        const assistant = second[second.length - 2];
        expect(assistant.role).toBe("assistant");
        expect(assistant.content[0]).toEqual({ type: "thinking", thinking: "Let me check the tool list.", signature: "sig-1" });
        expect(assistant.content[1]).toEqual({ type: "text", text: "I need the forecast." });
        expect(assistant.content[2].type).toBe("tool_use");
    });

    it("exposes the reasoning on the result and the step", async () => {
        const provider = track(fakeProvider((_body, _req, hits) => hits === 1
            ? Response.json({
                content: [
                    { type: "thinking", thinking: "Step one: think. ", signature: "sig-a" },
                    { type: "text", text: "Checking." },
                    { type: "tool_use", id: "toolu_1", name: "echo", input: {} },
                ],
                stop_reason: "tool_use",
                usage: A_USAGE,
            })
            : Response.json({
                content: [
                    { type: "thinking", thinking: "Step two: answer.", signature: "sig-b" },
                    { type: "text", text: "Done." },
                ],
                stop_reason: "end_turn",
                usage: A_USAGE,
            })));
        const agent = toolAgent({ compatible: "anthropic", baseUrl: provider.url });

        const result = await agent.generate("go", { thinking: true });

        expect(result.text).toBe("Done.");                      // never the reasoning
        expect(result.reasoning).toBe("Step one: think. \n\nStep two: answer.");
        expect(result.steps[0]!.reasoning).toBe("Step one: think. ");
        expect(result.steps[1]!.reasoning).toBe("Step two: answer.");
    });

    it("streams the reasoning on its own channel, signatures included", async () => {
        const provider = track(fakeProvider(() => sse([
            JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } }),
            JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
            JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Thinking… " } }),
            JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-stream" } }),
            JSON.stringify({ type: "content_block_stop", index: 0 }),
            JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
            JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer" } }),
            JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }),
        ])));
        const agent = toolAgent({ compatible: "anthropic", baseUrl: provider.url });

        const stream = agent.stream("hi", { thinking: true });
        const kinds: string[] = [];
        for await (const chunk of stream.fullStream) kinds.push(chunk.type);

        expect(kinds).toContain("reasoning");
        expect(await stream.text).toBe("Answer");              // the reasoning is not text
        expect(await stream.reasoning).toBe("Thinking… ");     // …and it is on the result too
        const steps = await stream.steps;
        expect(steps[0]!.reasoning).toBe("Thinking… ");
    });
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

    it("hands a URL image to both protocols (the endpoint fetches it)", () => {
        const parts = [{ type: "image" as const, url: "https://example.com/a.png" }];

        const openai = openaiMessages(undefined, [{ role: "user", content: parts }]);
        expect(openai[0].content[0]).toEqual({ type: "image_url", image_url: { url: "https://example.com/a.png" } });

        const anthropic = anthropicMessages([{ role: "user", content: parts }]);
        expect(anthropic.messages[0].content[0]).toEqual({
            type: "image", source: { type: "url", url: "https://example.com/a.png" },
        });
    });

    it("maps `developer` per protocol — its own role on OpenAI, the system prompt on Anthropic", () => {
        const messages: any[] = [
            { role: "developer", content: "answer in one line" },
            { role: "user", content: "hi" },
        ];

        expect(openaiMessages("sys", messages)[1]).toEqual({ role: "developer", content: "answer in one line" });
        // Anthropic has no such role: it joins the system prompt, after the instructions
        expect(anthropicMessages(messages).system).toBe("answer in one line");
    });

    it("forwards a message `name` to OpenAI, and drops it on Anthropic", () => {
        const messages: any[] = [{ role: "user", content: "hi", name: "ada" }];

        expect(openaiMessages(undefined, messages)[0]).toEqual({ role: "user", content: "hi", name: "ada" });
        expect(anthropicMessages(messages).messages[0].name).toBeUndefined();
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
        expect(() => new Agent({ id: "x", instructions: "x" } as any)).toThrow(/description/);
        expect(() => new Agent({ description: "x", instructions: "x" } as any)).toThrow(/requires an `id`/);
        expect(() => new Agent({ id: "x", description: "x", instructions: "x" } as any)).toThrow(/provider\.model/);
    });

    it("marks definitions through define.Agent / define.Tool", () => {
        const definition = define.Agent({ id: "x", description: "x", instructions: "x", provider: { model: "m" } });
        expect(definition._isAgent_).toBe(true);
        expect(definition.enabled).toBe(true);

        const tool = define.Tool({ id: "t", execute: () => 1 });
        expect(tool._isTool_).toBe(true);
        expect(tool.enabled).toBe(true);
    });

    it("registers tools by id, and refuses a definition without one", () => {
        const agent = makeAgent({ tools: { forecast: forecastTool() } });
        expect(agent.hasTool("forecast")).toBe(true);
        expect(Object.keys(agent.getTools())).toEqual(["forecast"]);

        // `define.Tool` requires an id at the type level — a raw object is caught here
        expect(() => makeAgent({ tools: { broken: { description: "no id", execute: () => 1 } } }))
            .toThrow(/requires an `id`/);

        // The record key is a label: it must agree with the id the model calls
        expect(() => makeAgent({ tools: { weather: forecastTool() } }))
            .toThrow(/key must match the id/);

        expect(() => agent.addTool({ id: "broken" } as any)).toThrow(/execute/);
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
        const declared = {
            model: "test-model",
            compatible: "openai" as const,
            options: { retries: 0, temperature: 0.2, maxTokens: 1000 },
        };

        expect(agent.getProvider()).toEqual(declared);
        expect(agent.toJSON().provider.options).toEqual(declared.options);
        expect(agent.setOptions({ topP: 0.5 }).getOptions().topP).toBe(0.5);
        expect(agent.setProvider({ model: "other" }).getOptions()).toEqual({ retries: 0, temperature: 0.2, maxTokens: 1000, topP: 0.5 });
    });

    it("resolves dynamic instructions per call", async () => {
        const agent = makeAgent({ instructions: ({ resource }: any) => `Hello ${resource}` });
        expect(await agent.resolveInstructions({ resource: "acme" })).toBe("Hello acme");
        // The deprecated alias resolves to the same value
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
        expect(agents.memory.InMemory).toBe(InMemoryAgentMemory);
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
                boom: define.Tool({ id: "boom", execute: () => { throw new Error("kaboom"); } }),
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

        await agent.generate("first", { thread: "t1" });
        await agent.generate("second", { thread: "t1" });

        const second = request(provider, 1).body.messages;
        expect(second.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "user"]);
        expect(second[1].content).toBe("first");
        expect(second[2].content).toBe("answer 1");
        expect(second[3].content).toBe("second");

        expect(await agent.getMessages("t1")).toHaveLength(4);
        // A different thread starts over
        await agent.generate("other", { thread: "t2" });
        expect(request(provider, 2).body.messages).toHaveLength(2);
    });

    it("reads without writing when the memory is read-only", async () => {
        const memory = new InMemoryAgentMemory();
        await memory.save("t1", [{ role: "user", content: "old" }]);
        const provider = track(fakeProvider(() => openaiText("ok")));
        const agent = makeAgent({ memory }, { baseUrl: provider.url });

        await agent.generate("new", { thread: "t1", memory: { threadId: "t1", readOnly: true } });

        expect(request(provider, 0).body.messages.map((m: any) => m.content)).toEqual([
            "You are a test agent.", "old", "new",
        ]);
        expect(await agent.getMessages("t1")).toHaveLength(1);
    });

    it("injects `messages` after the thread history, before the question", async () => {
        const memory = new InMemoryAgentMemory();
        await memory.save("t1", [{ role: "user", content: "an old turn" }]);
        const provider = track(fakeProvider(() => openaiText("ok")));
        const agent = makeAgent({ memory }, { baseUrl: provider.url });

        await agent.generate("And in Lyon?", {
            thread: "t1",
            messages: [
                { role: "user", content: "Weather in Paris?" },
                { role: "assistant", content: "18°C and sunny." },
            ],
        });

        // history → injected → the question: the thread is not rewritten by the injection
        expect(request(provider, 0).body.messages.map((m: any) => m.content)).toEqual([
            "You are a test agent.", "an old turn", "Weather in Paris?", "18°C and sunny.", "And in Lyon?",
        ]);

        // …and the injected turns are part of the thread from now on
        expect((await agent.getMessages("t1")).map((m) => m.content)).toEqual([
            "an old turn", "Weather in Paris?", "18°C and sunny.", "And in Lyon?", "ok",
        ]);
    });

    it("sends `messages` without a thread, and stores nothing", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const agent = makeAgent({}, { baseUrl: provider.url });

        await agent.generate("and?", {
            messages: [{ role: "user", content: "first" }, { role: "assistant", content: "answer" }],
        });

        expect(request(provider, 0).body.messages.map((m: any) => m.content))
            .toEqual(["You are a test agent.", "first", "answer", "and?"]);
    });

    it("refuses injected turns the model could not have seen", async () => {
        const agent = makeAgent({ memory: new InMemoryAgentMemory() }, { baseUrl: "http://127.0.0.1:1" });

        const error: any = await agent.generate("hi", {
            thread: "t1",
            messages: [{ role: "assistant", content: [{ type: "image", url: "https://example.com/a.png" }] }],
        } as any).catch((err) => err);

        expect(error.code).toBe("INVALID_INPUT");
    });

    it("remembers turns without calling the model", async () => {
        const memory = new InMemoryAgentMemory();
        const provider = track(fakeProvider(() => openaiText("ok")));
        const agent = makeAgent({ memory }, { baseUrl: provider.url });

        const thread = await agent.remember("t1", [
            { role: "user", content: "Bonjour" },
            { role: "assistant", content: "Bonjour ! Comment puis-je aider ?" },
        ]);

        expect(thread.map((message) => message.content)).toEqual([
            "Bonjour", "Bonjour ! Comment puis-je aider ?",
        ]);
        expect(provider.hits()).toBe(0); // nobody was called

        // What was remembered is replayed by the next run, after the system prompt
        await agent.generate("Une question", { thread: "t1" });
        expect(request(provider, 0).body.messages.map((m: any) => m.content)).toEqual([
            "You are a test agent.", "Bonjour", "Bonjour ! Comment puis-je aider ?", "Une question",
        ]);

        // Appending is additive — and a store namespace still applies
        await agent.remember("t1", { role: "user", content: "encore" });
        // 2 remembered + the question + the answer + `encore`
        expect(await agent.getMessages("t1")).toHaveLength(5);
        await agent.remember("t1", { role: "user", content: "ailleurs" }, { resource: "someone-else" });
        expect(await agent.getMessages("t1")).toHaveLength(5);
        expect(await agent.getMessages("t1", { resource: "someone-else" })).toHaveLength(1);
    });

    it("refuses to remember on an agent without a memory", async () => {
        const agent = makeAgent({}, { baseUrl: "http://127.0.0.1:1" });
        const error: any = await agent.remember("t1", { role: "user", content: "hi" }).catch((err) => err);
        expect(error.code).toBe("AGENT_NO_MEMORY");
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

// ─── Loader ─────────────────────────────────────────────────────────────

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

    it("loads the definitions with their ids", () => {
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

    it("binds the calling rest to a copy, never to the shared instance", () => {
        const fakeRest = { tenant_id: TENANT } as any;
        const bound = createAgents(TENANT, fakeRest).get("weather")!;
        const shared = createAgents(TENANT).get("weather")!;

        expect(bound.getRest()).toBe(fakeRest);
        // The registry instance is untouched: two concurrent requests must not
        // share a client (nor its Mongo session)
        expect(shared.getRest()).toBeUndefined();
        expect(bound).not.toBe(shared);
        expect(bound.getConfig()).toBe(shared.getConfig());
        expect(bound.getMemory()).toBe(shared.getMemory());
    });

    it("is what every context receives, bound to its own `rest`", async () => {
        const { useRest } = await import("../database/rest");
        const rest = new useRest({ tenant_id: TENANT });
        const agents = createAgents(TENANT, rest);

        expect(agents.ids().sort()).toEqual(["support", "weather"]);
        expect(agents.has("weather")).toBe(true);
        expect(agents.get("weather")!.getRest()).toBe(rest);
        expect(agents.get("support")!.getModel()).toBe("claude-test");
    });

    it("counts what it loaded for the boot banner", () => {
        expect(agentsStats()).toEqual({ total: 2, tenants: [TENANT] });
    });

    it("is importable without a `rest` (scripts, middlewares, cron…)", () => {
        // The package export — the tenant is passed explicitly
        expect(agents.stats()).toEqual({ total: 2, tenants: [TENANT] });
        expect(agents.has(TENANT, "weather")).toBe(true);
        expect(agents.ids(TENANT).sort()).toEqual(["support", "weather"]);
        expect(agents.list(TENANT)).toHaveLength(2);

        const weather = agents.get(TENANT, "weather")!;
        expect(weather).toBeInstanceOf(Agent);
        expect(weather.getTenant()).toBe(TENANT);
        // No `rest` given → the tools run without a database client
        expect(weather.getRest()).toBeUndefined();

        // …and a `rest` can be passed explicitly
        const fakeRest = { tenant_id: TENANT } as any;
        expect(agents.get(TENANT, "weather", fakeRest)!.getRest()).toBe(fakeRest);
        expect(agents.list(TENANT, fakeRest)[0]!.getRest()).toBe(fakeRest);

        // Same registry as the `agents` member of a context / `createAgents`
        expect(agents.use(TENANT).get("weather")).toBe(weather);
        expect(agents.get(TENANT, "missing")).toBeUndefined();
        expect(agents.get("unknown-tenant", "weather")).toBeUndefined();
        expect(agents.reload).toBe(syncAgents);
    });
});
