import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Rest } from "../index";

/**
 * `api.agent(id)` against a fake server that speaks the documented wire format
 * (`POST /api/:tenant/agents/:agent/:action`, JSON + SSE). The SDK is tested in
 * isolation: what matters here is the contract, not the server implementation.
 */

type Hit = { path: string; body: any; headers: Record<string, string> };

let hits: Hit[] = [];
let server: any;
let base = "";

function result(text: string, extra: any = {}) {
    return {
        text,
        toolCalls: [],
        toolResults: [],
        steps: [],
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, requests: 1 },
        finishReason: "stop",
        ...extra,
    };
}

beforeAll(() => {
    server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: async (req) => {
            const url = new URL(req.url);
            const body = req.method === "POST" ? await req.json().catch(() => null) : null;
            hits.push({ path: url.pathname, body, headers: Object.fromEntries(req.headers.entries()) });

            if (!req.headers.get("authorization")) {
                return Response.json({ message: "Authentication required", code: "AUTH_REQUIRED" }, { status: 401 });
            }

            // `/api/:tenant/agents/:agent/:action`
            const parts = url.pathname.split("/");
            const agentId = parts[4];
            const action = parts[5];
            if (agentId === "missing") {
                return Response.json({ message: "Agent 'missing' not found", code: "AGENT_NOT_FOUND" }, { status: 400 });
            }

            switch (action) {
                case "info":
                    return Response.json({
                        agent: {
                            id: agentId,
                            name: "Support",
                            provider: { model: "gpt-4o-mini", compatible: "openai" },
                            instructions: "…",
                            tools: ["echo"],
                            maxSteps: 5,
                            memory: true,
                        },
                    });

                case "generate":
                    return Response.json(result("Bonjour", {
                        toolCalls: [{ id: "c1", name: "echo", args: { text: "hi" } }],
                        toolResults: [{ id: "c1", name: "echo", args: { text: "hi" }, result: { echoed: "hi" }, durationMs: 1 }],
                        steps: [{ step: 0, text: "", toolCalls: [], toolResults: [], finishReason: "tool_use" }],
                        usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11, requests: 2 },
                    }));

                case "object":
                    return Response.json({
                        ...result('{"city":"Paris","celsius":21}'),
                        object: { city: "Paris", celsius: 21 },
                    });

                case "history":
                    return Response.json({
                        messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "Bonjour" }],
                    });

                case "clear":
                    return Response.json({ ok: true });

                case "threads":
                    return Response.json({
                        threads: [{ threadId: "c-9", messages: 2, updatedAt: new Date().toISOString() }],
                    });

                case "stream": {
                    const events = [
                        { type: "text", text: "Bon" },
                        { type: "text", text: "jour" },
                        { type: "reasoning", text: "let me think" },
                        { type: "tool_call", toolCall: { id: "c1", name: "echo", args: { text: "hi" } } },
                        { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, requests: 1 } },
                        { type: "done", result: result("Bonjour", { reasoning: "let me think" }) },
                    ];
                    return sse(events);
                }

                default:
                    return Response.json({ message: `Action '${action}' not found`, code: "ACTION_NOT_FOUND" }, { status: 400 });
            }
        },
    });
    base = `http://127.0.0.1:${server.port}`;
});

/** A slow stream (one event per 25ms) so `abort()` has something to cut short. */
function sse(events: any[], delayMs = 0): Response {
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const encoder = new TextEncoder();
            for (const event of events) {
                if (delayMs) await Bun.sleep(delayMs);
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            }
            controller.close();
        },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

afterAll(() => {
    try { server.stop(true); } catch (_) { /* already stopped */ }
});

beforeEach(() => { hits = []; });

const api = () => new Rest({
    server: base,
    tenant: "v1",
    headers: { Authorization: "Bearer test-token" },
});

describe("sdk agent()", () => {
    it("exposes the agent id and builds the documented URL", async () => {
        const agent = api().agent("support");
        expect(agent.getId()).toBe("support");

        await agent.info();
        expect(hits[0]!.path).toBe("/api/v1/agents/support/info");
        expect(hits[0]!.headers.authorization).toBe("Bearer test-token");
    });

    it("info returns the metadata", async () => {
        const info = await api().agent("support").info();
        expect(info.name).toBe("Support");
        expect(info.provider.model).toBe("gpt-4o-mini");
        expect(info.tools).toEqual(["echo"]);
        expect(info.memory).toBe(true);
    });

    it("generate sends only the allowed fields", async () => {
        // Keys a caller must not be able to set — they stay server-side
        const forbidden = { provider: { model: "cheaper" }, options: { temperature: 0 } } as any;

        const res = await api().agent("support").generate("hi", {
            thread: "u-42",
            resource: "acme",
            maxSteps: 2,
            ...forbidden,
        });

        expect(res.text).toBe("Bonjour");
        expect(res.finishReason).toBe("stop");
        expect(res.toolCalls[0]!.name).toBe("echo");
        expect(res.toolResults[0]!.result).toEqual({ echoed: "hi" });
        expect(res.usage.requests).toBe(2);

        expect(hits[0]!.path).toBe("/api/v1/agents/support/generate");
        expect(hits[0]!.body).toEqual({ input: "hi", thread: "u-42", resource: "acme", maxSteps: 2 });
        expect(JSON.stringify(hits[0]!.body)).not.toContain("cheaper");
        expect(JSON.stringify(hits[0]!.body)).not.toContain("temperature");
    });

    it("generate accepts a message array", async () => {
        await api().agent("support").generate([
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
            { role: "user", content: "and?" },
        ]);
        expect(hits[0]!.body.input).toHaveLength(3);
    });

    it("generate accepts a single message, and the content parts", async () => {
        const agent = api().agent("support");

        await agent.generate({ role: "user", content: "hi" });
        expect(hits[0]!.body.input).toEqual({ role: "user", content: "hi" });

        // The unified vocabulary travels as-is — the server normalizes it
        await agent.generate({
            role: "user",
            content: [
                { type: "text", text: "what is this?" },
                { type: "image", url: "https://example.com/a.png" },
            ],
        });
        expect(hits[1]!.body.input.content).toEqual([
            { type: "text", text: "what is this?" },
            { type: "image", url: "https://example.com/a.png" },
        ]);
    });

    it("object returns the typed object", async () => {
        const object = await api().agent<{ city: string; celsius: number }>("support")
            .object("Weather?");
        expect(object).toEqual({ city: "Paris", celsius: 21 });
    });

    it("history and clear", async () => {
        const agent = api().agent("support");

        const messages = await agent.history("u-42");
        expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
        expect(hits[0]!.body).toEqual({ thread: "u-42" });

        expect(await agent.clear("u-42")).toBe(true);
        expect(hits[1]!.path).toBe("/api/v1/agents/support/clear");
    });

    it("maps the memory shorthand (and its aliases) to the wire body", async () => {
        const agent = api().agent("support");

        await agent.generate("hi", { memory: { resource: "u-9", thread: "c-9" } });
        expect(hits[0]!.body).toEqual({ input: "hi", thread: "c-9", resource: "u-9" });

        // The flat options mean the same thing
        await agent.generate("hi", { thread: "c-9", resource: "u-9" });
        expect(hits[1]!.body).toEqual({ input: "hi", thread: "c-9", resource: "u-9" });

        // …and so do the deprecated `…Id` aliases
        await agent.generate("hi", { threadId: "c-9", resourceId: "u-9" });
        expect(hits[2]!.body).toEqual({ input: "hi", thread: "c-9", resource: "u-9" });

        // `readOnly` travels on its own
        await agent.generate("hi", { memory: { thread: "c-9", readOnly: true } });
        expect(hits[3]!.body).toEqual({ input: "hi", thread: "c-9", readOnly: true });
    });

    it("thread history and clear accept the same options", async () => {
        const agent = api().agent("support");

        await agent.history("c-9", { memory: { resource: "u-9" } });
        expect(hits[0]!.body).toEqual({ thread: "c-9", resource: "u-9" });

        await agent.threads({ resource: "u-9", limit: 5 });
        expect(hits[1]!.body).toEqual({ resource: "u-9", limit: 5 });

        await agent.clear("c-9", { memory: { resource: "u-9" } });
        expect(hits[2]!.body).toEqual({ thread: "c-9", resource: "u-9" });
    });

    it("encodes attachments for the wire", async () => {
        const agent = api().agent("support");

        await agent.generate("What is wrong here?", {
            files: [
                new Blob(["PNG!"], { type: "image/png" }) as any,
                { name: "notes.md", data: "# Hi", encoding: "utf8" },
            ],
        });

        const body = hits[0]!.body;
        expect(body.input).toBe("What is wrong here?");
        expect(body.files).toEqual([
            { name: "attachment", mimeType: "image/png", data: Buffer.from("PNG!").toString("base64") },
            { name: "notes.md", data: "# Hi", encoding: "utf8" },
        ]);
    });

    it("surfaces the server error with code and status", async () => {
        const error: any = await api().agent("missing").generate("hi").catch((err) => err);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe("Agent 'missing' not found");
        expect(error.code).toBe("AGENT_NOT_FOUND");
        expect(error.status).toBe(400);
    });

    it("surfaces an access error on stream() before any token is read", async () => {
        const anonymous = new Rest({ server: base, tenant: "v1" });
        const error: any = await anonymous.agent("support").stream("hi").catch((err) => err);
        expect(error.code).toBe("AUTH_REQUIRED");
        expect(error.status).toBe(401);
    });
});

describe("sdk agent().stream()", () => {
    it("consumes the SSE events and resolves the promises", async () => {
        const stream = await api().agent("support").stream("hi");

        const tokens: string[] = [];
        for await (const token of stream.textStream) tokens.push(token);
        expect(tokens).toEqual(["Bon", "jour"]);

        expect(await stream.text).toBe("Bonjour");
        expect(await stream.finishReason).toBe("stop");
        expect((await stream.usage).requests).toBe(1);
        expect((await stream.toolCalls)).toEqual([]);
        // `generate()` returns the reasoning on the result — the streamed run too
        expect(await stream.reasoning).toBe("let me think");
    });

    it("sends the same run options as generate — `messages` and `lastMessages` included", async () => {
        const agent = api().agent("support");

        const generated = await agent.generate("hi", {
            thread: "c-1",
            maxSteps: 2,
            lastMessages: 4,
            messages: [{ role: "user", content: "earlier" }],
        });
        const streamed = await agent.stream("hi", {
            thread: "c-1",
            maxSteps: 2,
            lastMessages: 4,
            messages: [{ role: "user", content: "earlier" }],
        });
        await streamed.text;

        expect(generated.text).toBe("Bonjour");
        // Byte for byte the same options — one body builder for the three actions
        expect(hits[1]!.body).toEqual(hits[0]!.body);
        expect(hits[0]!.body).toEqual({
            input: "hi",
            thread: "c-1",
            maxSteps: 2,
            lastMessages: 4,
            messages: [{ role: "user", content: "earlier" }],
        });
    });

    it("exposes the tool events on fullStream", async () => {
        const stream = await api().agent("support").stream("hi");

        const kinds: string[] = [];
        for await (const chunk of stream.fullStream) kinds.push(chunk.type);

        expect(kinds).toEqual(["text", "text", "reasoning", "tool_call", "finish"]);
    });

    it("sends the run options like generate does", async () => {
        const stream = await api().agent("support").stream("hi", { thread: "u-42" });
        await stream.text;
        expect(hits[0]!.body).toEqual({ input: "hi", thread: "u-42" });
        expect(hits[0]!.path).toBe("/api/v1/agents/support/stream");
    });

    it("abort() ends the stream and rejects the promises", async () => {
        // A dedicated slow endpoint: 25ms per event
        server.stop(true);
        server = Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            fetch: async (req) => {
                if (!req.headers.get("authorization")) {
                    return Response.json({ message: "Authentication required", code: "AUTH_REQUIRED" }, { status: 401 });
                }
                const events = [
                    { type: "text", text: "one" },
                    { type: "text", text: "two" },
                    { type: "text", text: "three" },
                    { type: "done", result: result("onetwothree") },
                ];
                return sse(events, 25);
            },
        });
        base = `http://127.0.0.1:${server.port}`;

        const stream = await api().agent("slow").stream("hi");
        const tokens: string[] = [];
        for await (const token of stream.textStream) {
            tokens.push(token);
            stream.abort();
        }

        expect(tokens).toEqual(["one"]);
        await expect(stream.text).rejects.toThrow();
    });
});
