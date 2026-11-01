import { describe, it, expect, afterAll } from "bun:test";
import { Agent, define, v } from "../index";
import { cfg } from "../server/config";
import { createAgents, syncAgents } from "../lib/agents";
import { AppError } from "../lib/error";
import { joiToJsonSchema } from "../lib/jsonSchema";
import {
    anthropicText,
    anthropicTool,
    anthropicToolCalls,
    at,
    fakeProvider,
    openaiText,
    openaiTool,
    openaiToolCalls,
    request,
    type Fake,
} from "./fixtures/fake-provider";

/**
 * The tool runtime — what a tool receives, what the model reads back, and the
 * guards around it (codes, media, bounded concurrency, counters, descriptions).
 */

const servers: Fake[] = [];
function track(fake: Fake): Fake {
    servers.push(fake);
    return fake;
}

afterAll(() => {
    for (const server of servers) server.stop();
});

function makeAgent(
    tools: Record<string, any>,
    provider: { baseUrl: string; protocol?: "openai" | "anthropic" },
    overrides: Record<string, any> = {},
) {
    return new Agent({
        id: "tools",
        description: "Tool runtime test agent.",
        instructions: "Use the tools.",
        provider: {
            model: "test-model",
            apiKey: "test-key",
            protocol: provider.protocol ?? "openai",
            baseUrl: provider.baseUrl,
            options: { retries: 0 },
        },
        tools,
        ...overrides,
    } as any);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("tool errors carry a code", () => {
    it("serializes the AppError code for the model, and counts it", async () => {
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? openaiTool("order", { id: "A-1" }) : openaiText("sorry")));

        const agent = makeAgent({
            order: define.Tool({
                id: "order",
                description: "Reads an order",
                inputSchema: v.object({ id: v.string().required() }),
                execute: () => {
                    throw new AppError("No order 'A-1'", { status: 404, code: "ORDER_NOT_FOUND" });
                },
            }),
        }, { baseUrl: provider.url });

        const result = await agent.generate("go");

        expect(at(result.toolResults, 0).errorCode).toBe("ORDER_NOT_FOUND");
        expect(request(provider, 1).body.messages[3].content).toBe("Error [ORDER_NOT_FOUND]: No order 'A-1'");
        expect(result.toolStats).toMatchObject({ calls: 1, errors: 1, byCode: { ORDER_NOT_FOUND: 1 }, timeouts: 0 });
    });

    it("codes a timeout, and keeps the run going", async () => {
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? openaiTool("slow", {}) : openaiText("gave up")));

        const agent = makeAgent({
            slow: define.Tool({
                id: "slow",
                description: "Never answers in time",
                inputSchema: v.object({}),
                timeoutMs: 5,
                execute: () => sleep(50),
            }),
        }, { baseUrl: provider.url });

        const result = await agent.generate("go");

        expect(at(result.toolResults, 0).errorCode).toBe("AGENT_TOOL_TIMEOUT");
        expect(result.toolStats.timeouts).toBe(1);
        expect(result.finishReason).toBe("stop");
    });
});

describe("tool media results", () => {
    const chart = () => define.Tool({
        id: "chart",
        description: "Builds a chart",
        inputSchema: v.object({}),
        execute: () => ({
            content: [
                { type: "text", text: "Here is the chart" },
                { type: "image", data: "QUJD", mimeType: "image/png" },
            ],
        }),
    });

    it("hands an image to Anthropic as a tool_result block", async () => {
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? anthropicTool("chart", {}) : anthropicText("done")));

        const agent = makeAgent({ chart: chart() }, { baseUrl: provider.url, protocol: "anthropic" });
        await agent.generate("go");

        const messages = request(provider, 1).body.messages;
        const toolResult = messages
            .flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
            .find((block: any) => block.type === "tool_result");

        expect(toolResult.content).toEqual([
            { type: "text", text: "Here is the chart" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
        ]);
    });

    it("degrades to a text marker on OpenAI, whose tool message is text-only", async () => {
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? openaiTool("chart", {}) : openaiText("done")));

        const agent = makeAgent({ chart: chart() }, { baseUrl: provider.url });
        await agent.generate("go");

        expect(request(provider, 1).body.messages[3].content).toBe("Here is the chart\n[image: image/png]");
    });
});

describe("bounded tool parallelism", () => {
    it("runs read-only tools together, at most `maxParallelToolCalls` at a time", async () => {
        const state = { running: 0, peak: 0 };
        const provider = track(fakeProvider((_body, _req, hits) => hits === 1
            ? openaiToolCalls(Array.from({ length: 6 }, (_, index) => ({ name: "read", args: {}, id: `c${index}` })))
            : openaiText("done")));

        const agent = makeAgent({
            read: define.Tool({
                id: "read",
                description: "Reads something",
                readOnly: true,
                inputSchema: v.object({}),
                execute: async () => {
                    state.running += 1;
                    state.peak = Math.max(state.peak, state.running);
                    await sleep(10);
                    state.running -= 1;
                    return { ok: true };
                },
            }),
        }, { baseUrl: provider.url }, { maxParallelToolCalls: 2 });

        const result = await agent.generate("go");

        expect(result.toolResults).toHaveLength(6);
        expect(state.peak).toBe(2);
    });

    it("keeps writes sequential, even in a batch", async () => {
        const state = { running: 0, peak: 0 };
        const provider = track(fakeProvider((_body, _req, hits) => hits === 1
            ? openaiToolCalls([{ name: "write", args: {} }, { name: "write", args: {} }, { name: "write", args: {} }])
            : openaiText("done")));

        const agent = makeAgent({
            write: define.Tool({
                id: "write",
                description: "Writes something",
                inputSchema: v.object({}),
                execute: async () => {
                    state.running += 1;
                    state.peak = Math.max(state.peak, state.running);
                    await sleep(5);
                    state.running -= 1;
                    return { ok: true };
                },
            }),
        }, { baseUrl: provider.url });

        await agent.generate("go");

        expect(state.peak).toBe(1);
    });

    it("bounds the calls of a step that forced parallelism", async () => {
        const state = { running: 0, peak: 0 };
        const provider = track(fakeProvider((_body, _req, hits) => hits === 1
            ? openaiToolCalls(Array.from({ length: 5 }, (_, index) => ({ name: "job", args: {}, id: `j${index}` })))
            : openaiText("done")));

        const agent = makeAgent({
            job: define.Tool({
                id: "job",
                description: "Runs a job",
                inputSchema: v.object({}),
                execute: async () => {
                    state.running += 1;
                    state.peak = Math.max(state.peak, state.running);
                    await sleep(10);
                    state.running -= 1;
                    return { ok: true };
                },
            }),
        }, { baseUrl: provider.url }, { parallelTools: true, maxParallelToolCalls: 2 });

        await agent.generate("go");

        expect(state.peak).toBe(2);
    });
});

describe("tool stats", () => {
    it("aggregates calls, errors and duration", async () => {
        const provider = track(fakeProvider((_body, _req, hits) => hits === 1
            ? openaiToolCalls([{ name: "ok", args: {} }, { name: "boom", args: {} }])
            : openaiText("done")));

        const agent = makeAgent({
            ok: define.Tool({
                id: "ok",
                description: "Works",
                inputSchema: v.object({}),
                execute: () => ({ ok: true }),
            }),
            boom: define.Tool({
                id: "boom",
                description: "Fails",
                inputSchema: v.object({}),
                execute: () => {
                    throw new AppError("kaput", { status: 500, code: "KAPUT" });
                },
            }),
        }, { baseUrl: provider.url });

        const result = await agent.generate("go");

        expect(result.toolStats.calls).toBe(2);
        expect(result.toolStats.errors).toBe(1);
        expect(result.toolStats.byCode).toEqual({ KAPUT: 1 });
        expect(result.toolStats.durationMs).toBeGreaterThanOrEqual(0);
    });
});

describe("tool schema fidelity", () => {
    it("closes the object and publishes defaults", () => {
        const schema = joiToJsonSchema(v.object({
            city: v.string().required(),
            days: v.number().default(1),
        }));
        expect(schema.additionalProperties).toBe(false);
        expect(schema.properties.days.default).toBe(1);
        expect(schema.required).toEqual(["city"]);
    });

    it("keeps the object open when Joi allows unknown keys", () => {
        const schema = joiToJsonSchema(v.object({ a: v.string() }).unknown());
        expect(schema.additionalProperties).toBe(true);
    });
});

describe("tool descriptions at load time", () => {
    it("skips a file tool without a description, and keeps the described one", async () => {
        const previous = cfg.tenants;
        try {
            cfg.tenants = [{ id: "tool-tenant", dir: "packages/core/tests/fixtures/tool-tenant", database: { uri: "mongodb://localhost:27017/none" } }] as any;
            await syncAgents();

            const report = createAgents("tool-tenant").get("report")!;
            expect(report.hasTool("chart")).toBe(true);
            expect(report.hasTool("hidden")).toBe(false);
        } finally {
            cfg.tenants = previous;
            await syncAgents().catch(() => { });
        }
    });
});
