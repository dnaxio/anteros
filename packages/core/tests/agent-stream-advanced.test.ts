import { describe, it, expect, afterAll } from "bun:test";
import { Agent, define, v } from "../index";
import { parsePartialJson } from "../lib/partialJson";
import {
    at,
    fakeProvider,
    openaiStream,
    openaiText,
    openaiToolCalls,
    request,
    sse,
    type Fake,
} from "./fixtures/fake-provider";

/**
 * The advanced streaming surface: a delegated run streams through its parent,
 * tool results pass through guardrails, and `streamObject()` yields partial
 * objects as the answer is written.
 */

const servers: Fake[] = [];
function track(fake: Fake): Fake {
    servers.push(fake);
    return fake;
}

afterAll(() => {
    for (const server of servers) server.stop();
});

function makeAgent(overrides: Record<string, any> = {}, provider: Record<string, any> = {}) {
    return new Agent({
        id: "advanced",
        description: "An advanced test agent.",
        instructions: "Answer.",
        provider: {
            model: "parent-model",
            apiKey: "test-key",
            protocol: "openai",
            options: { retries: 0 },
            ...provider,
        },
        ...overrides,
    } as any);
}

/** A streamed `tool_calls` turn — a streamed call only reads `data:` events. */
function openaiToolStream(name: string, args: any, id = "call_1"): Response {
    return sse([
        JSON.stringify({
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 0,
                        id,
                        type: "function",
                        function: { name, arguments: JSON.stringify(args) },
                    }],
                },
            }],
        }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        "[DONE]",
    ]);
}

/** Drain a stream to the end and return what it produced. */
async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const chunk of stream) out.push(chunk);
    return out;
}

describe("sub-agent streaming", () => {
    it("re-emits the child's chunks and folds its tool stats into the parent's", async () => {
        const child = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? openaiToolStream("lookup", {}) : openaiStream(["child ", "answer"])));
        const parent = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? openaiToolStream("helper", { input: "do it" }) : openaiStream(["parent ", "answer"])));

        const helper = define.Agent({
            id: "helper",
            description: "A delegated agent",
            instructions: "Help.",
            provider: {
                model: "child-model",
                apiKey: "k",
                protocol: "openai",
                baseUrl: child.url,
                options: { retries: 0 },
            },
            tools: {
                lookup: define.Tool({
                    id: "lookup",
                    description: "Looks something up",
                    inputSchema: v.object({}),
                    execute: () => ({ hit: "child tool" }),
                }),
            },
        });

        const agent = makeAgent({ agents: [helper] }, { baseUrl: parent.url });
        const run = agent.stream("go", { maxSteps: 3 });
        const chunks = await drain(run.fullStream);

        // The child's text travels **wrapped**, never on the parent's own channel
        const wrapped = chunks.filter((chunk): chunk is Extract<typeof chunk, { type: "subagent" }> =>
            chunk.type === "subagent");
        expect(wrapped.every((chunk) => chunk.name === "helper")).toBe(true);
        const childText = wrapped
            .filter((chunk) => chunk.chunk.type === "text")
            .map((chunk) => (chunk.chunk as { type: "text"; text: string }).text)
            .join("");
        expect(childText).toBe("child answer");

        const ownText = chunks
            .filter((chunk) => chunk.type === "text")
            .map((chunk) => (chunk as { type: "text"; text: string }).text)
            .join("");
        expect(ownText).toBe("parent answer");
        expect(await run.text).toBe("parent answer");

        const results = await run.toolResults;
        expect(at(results, 0).result).toBe("child answer");

        // One parent call (the delegation) + one child call (its tool)
        const stats = await run.toolStats;
        expect(stats.calls).toBe(2);
        expect(stats.errors).toBe(0);
    });
});

describe("tool-result guardrails", () => {
    it("blocks a result the model must not read, and finishes the run", async () => {
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1
                ? openaiToolCalls([{ name: "safe", args: {} }, { name: "leaky", args: {} }])
                : openaiText("done")));

        const agent = makeAgent({
            tools: {
                safe: define.Tool({
                    id: "safe",
                    description: "Returns something harmless",
                    inputSchema: v.object({}),
                    execute: () => ({ ok: true }),
                }),
                leaky: define.Tool({
                    id: "leaky",
                    description: "Returns a secret",
                    inputSchema: v.object({}),
                    execute: () => ({ token: "sk-live-123" }),
                }),
            },
            guardrails: {
                tool: [{
                    name: "no-secret",
                    check: (value: string) => {
                        if (value.includes("sk-live")) throw new Error("secret in tool result");
                    },
                }],
            },
        }, { baseUrl: provider.url });

        const result = await agent.generate("go", { maxSteps: 3 });

        // The run finished — the result was blocked, not the run
        expect(result.text).toBe("done");
        expect(result.finishReason).toBe("stop");

        const safe = at(result.toolResults, 0);
        const blocked = at(result.toolResults, 1);
        expect(safe.name).toBe("safe");
        expect(safe.error).toBeUndefined();
        expect(safe.result).toEqual({ ok: true });

        expect(blocked.error).toBe("Guardrail 'no-secret' blocked the tool result: secret in tool result");
        expect(blocked.errorCode).toBe("AGENT_GUARDRAIL_BLOCKED");
        expect("result" in blocked).toBe(false);
        expect(result.toolStats.errors).toBe(1);
        expect(result.toolStats.byCode.AGENT_GUARDRAIL_BLOCKED).toBe(1);

        // The model reads the refusal as a tool error, with a code it can branch on
        const toolTurns = request(provider, 1).body.messages.filter((message: any) => message.role === "tool");
        const leakyTurn = toolTurns.find((message: any) => String(message.content).includes("AGENT_GUARDRAIL_BLOCKED"));
        expect(leakyTurn).toBeDefined();
        expect(String(leakyTurn.content)).toContain("Error [AGENT_GUARDRAIL_BLOCKED]");
        expect(String(leakyTurn.content)).not.toContain("sk-live");
    });
});

describe("parsePartialJson", () => {
    it("closes an open string, an open object and an open array", () => {
        expect(parsePartialJson('{"city": "Par')).toEqual({ city: "Par" });
        expect(parsePartialJson('{"cities": ["Paris", "Lyo')).toEqual({ cities: ["Paris", "Lyo"] });
        expect(parsePartialJson('{"a": {"b": [1, 2')).toEqual({ a: { b: [1, 2] } });
        expect(parsePartialJson('{"a": 1,')).toEqual({ a: 1 });
    });

    it("survives a dangling escape and gives up when the JSON cannot be repaired", () => {
        expect(parsePartialJson('{"a": "x\\')).toEqual({ a: "x" });
        expect(parsePartialJson('{"a": ')).toBeUndefined();
        expect(parsePartialJson("")).toBeUndefined();
        expect(parsePartialJson("not json")).toBeUndefined();
    });

    it("strips a markdown fence, leading and trailing", () => {
        expect(parsePartialJson('```json\n{"a": 1}')).toEqual({ a: 1 });
        expect(parsePartialJson('```json\n{"a": [1, 2]\n```')).toEqual({ a: [1, 2] });
        expect(parsePartialJson('{"a": {"b": "c')).toEqual({ a: { b: "c" } });
    });
});

describe("streamObject", () => {
    it("yields parsed partials and the final validated object", async () => {
        const provider = track(fakeProvider(() =>
            openaiStream(["{", '"cities":', ' ["Paris"', ', "Lyon"]', "}"])));

        const schema = v.object({ cities: v.array().items(v.string()).required() });
        const agent = makeAgent({}, { baseUrl: provider.url });

        const run = agent.streamObject<{ cities: string[] }>("List cities", { schema });
        const partials: Array<{ cities: string[] } | undefined> = [];
        for await (const partial of run.partialObjectStream) partials.push(partial);

        const parsed = partials.filter((partial): partial is { cities: string[] } => partial !== undefined);
        expect(parsed.length).toBeGreaterThan(0);
        expect(parsed.some((partial) => Array.isArray(partial.cities))).toBe(true);

        expect(await run.object).toEqual({ cities: ["Paris", "Lyon"] });
        expect(await run.text).toContain("Lyon");
    });

    it("rejects without a schema", () => {
        const agent = makeAgent();

        let error: any;
        try {
            agent.streamObject("hi");
        } catch (err) {
            error = err;
        }

        expect(error?.code).toBe("AGENT_SCHEMA_REQUIRED");
    });
});
