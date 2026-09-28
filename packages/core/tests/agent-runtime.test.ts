/**
 * The runtime's own guarantees — the ones a caller relies on when the outside world
 * misbehaves or when the prompt decides on something expensive:
 *
 *  - a tool that hangs is abandoned, and the run goes on;
 *  - a step is all-or-nothing, and a tool asking for **approval** pauses it;
 *  - a failing run can keep what it produced;
 *  - a step's tools can run together;
 *  - another agent is just a tool.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { define, v, Agent, agents } from "../index";
import { InMemoryAgentMemory } from "../lib/agent";
import {
    at,
    fakeProvider,
    openaiText,
    openaiTool,
    request,
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

/** Two tool calls in **one** answer — what a parallel step needs. */
function openaiTwoCalls(name: string, ids = ["c1", "c2"]): Response {
    return Response.json({
        choices: [{
            message: {
                role: "assistant",
                content: null,
                tool_calls: ids.map((id, index) => ({
                    id,
                    type: "function",
                    function: { name, arguments: JSON.stringify({ n: index + 1 }) },
                })),
            },
            finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
}

describe("tool timeout", () => {
    const slow = (calls: string[] = []) => define.Tool({
        id: "slow",
        description: "Never answers",
        inputSchema: v.object({ n: v.number().optional() }),
        execute: async ({ n }: any) => {
            calls.push(String(n));
            await Bun.sleep(500);
            return "late";
        },
    });

    it("abandons a tool that hangs, tells the model, and keeps going", async () => {
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? openaiTool("slow", {}) : openaiText("done")));
        const agent = makeAgent({ tools: { slow: slow() } }, { baseUrl: provider.url });

        const result = await agent.generate("hi", { toolTimeoutMs: 40 });

        expect(at(result.toolResults, 0).error).toContain("timed out after 40ms");
        // The run is not the tool's hostage
        expect(result.text).toBe("done");
        expect(result.finishReason).toBe("stop");
    });

    it("takes the deadline from the tool, then from the agent", async () => {
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? openaiTool("slow", {}) : openaiText("done")));
        const agent = makeAgent({
            toolTimeoutMs: 40,
            tools: { slow: { ...slow(), timeoutMs: 10 } },
        }, { baseUrl: provider.url });

        const result = await agent.generate("hi");

        expect(at(result.toolResults, 0).error).toContain("timed out after 10ms");
    });

    it("lets a cooperative tool notice the deadline through its signal", async () => {
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? openaiTool("watch", {}) : openaiText("done")));
        let aborted = false;
        const agent = makeAgent({
            tools: {
                watch: define.Tool({
                    id: "watch",
                    description: "Waits for its own deadline",
                    inputSchema: v.object({}),
                    execute: async (_args: any, { signal }: any) => {
                        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
                        aborted = true;
                        return "stopped";
                    },
                }),
            },
        }, { baseUrl: provider.url });

        await agent.generate("hi", { toolTimeoutMs: 30 });

        expect(aborted).toBe(true);
    });
});

describe("a failing run", () => {
    const boom = () => define.Tool({
        id: "boom",
        description: "Works once",
        inputSchema: v.object({}),
        execute: async () => "ok",
    });

    /** The provider answers the tool call, then dies. */
    const dying = () => track(fakeProvider((_body, _req, hits) =>
        hits === 1
            ? openaiTool("boom", {})
            : new Response(JSON.stringify({ error: { message: "provider exploded" } }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
            })));

    it("stores nothing by default", async () => {
        const memory = new InMemoryAgentMemory();
        const agent = makeAgent({ memory, tools: { boom: boom() } }, { baseUrl: dying().url });

        await expect(agent.generate("hi", { thread: "t1" })).rejects.toThrow(/provider exploded/);

        expect(await memory.get("t1")).toEqual([]);
    });

    it("keeps the exchange when the caller asks for it", async () => {
        const memory = new InMemoryAgentMemory();
        const agent = makeAgent({ memory, tools: { boom: boom() } }, { baseUrl: dying().url });

        await expect(agent.generate("hi", { thread: "t1", savePartial: true })).rejects.toThrow(/provider exploded/);

        // The tokens are paid: what the run produced is in the thread, and the next
        // call resumes from there instead of starting over
        const stored = await memory.get("t1");
        expect(stored.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
        expect(stored[2]!.content).toBe("ok");
    });
});

describe("parallel tools", () => {
    /** Counts how many calls are in flight at the same time. */
    const overlap = (state: { running: number; peak: number }) => define.Tool({
        id: "probe",
        description: "Measures concurrency",
        inputSchema: v.object({ n: v.number().optional() }),
        execute: async () => {
            state.running += 1;
            state.peak = Math.max(state.peak, state.running);
            await Bun.sleep(30);
            state.running -= 1;
            return `n${state.running}`;
        },
    });

    it("runs them one after the other by default", async () => {
        const state = { running: 0, peak: 0 };
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? openaiTwoCalls("probe") : openaiText("done")));
        const agent = makeAgent({ tools: { probe: overlap(state) } }, { baseUrl: provider.url });

        const result = await agent.generate("hi");

        expect(state.peak).toBe(1);
        // The conversation stays in the model's order, whatever the execution order
        expect(result.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId))
            .toEqual(["c1", "c2"]);
    });

    it("runs them together when the caller asks for it", async () => {
        const state = { running: 0, peak: 0 };
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? openaiTwoCalls("probe") : openaiText("done")));
        const agent = makeAgent({ tools: { probe: overlap(state) } }, { baseUrl: provider.url });

        const result = await agent.generate("hi", { parallelTools: true });

        expect(state.peak).toBe(2);
        expect(result.toolResults).toHaveLength(2);
        expect(result.messages.filter((message) => message.role === "tool").map((message) => message.toolCallId))
            .toEqual(["c1", "c2"]);
    });
});

describe("another agent as a tool", () => {
    it("offers it, runs it with the caller's client, and feeds the answer back", async () => {
        const provider = track(fakeProvider((body, _req, hits) => {
            if (body.messages[0].content === "You are the researcher.") return openaiText("42");
            return hits === 1 ? openaiTool("researcher", { input: "the answer?" }) : openaiText("It is 42.");
        }));

        const researcher = {
            id: "researcher",
            description: "Looks things up in the corpus.",
            instructions: "You are the researcher.",
            provider: { model: "test-model", apiKey: "test-key", baseUrl: provider.url, options: { retries: 0 } },
        };
        const agent = makeAgent({ agents: [researcher] }, { baseUrl: provider.url });

        const result = await agent.generate("What is the answer?");

        // The sub-agent is an ordinary tool, described by its own declaration
        const offered = request(provider, 0).body.tools.find((tool: any) => tool.function.name === "researcher");
        expect(offered.function.description).toBe("Looks things up in the corpus.");
        expect(offered.function.parameters.required).toEqual(["input"]);

        expect(at(result.toolResults, 0).result).toBe("42");
        expect(result.text).toBe("It is 42.");
    });

    it("is dropped by `tools: false` and by an allow-list, like any other tool", async () => {
        const provider = track(fakeProvider(() => openaiText("direct")));
        const researcher = { id: "researcher", description: "x", instructions: "y", provider: { model: "test-model" } };
        const agent = makeAgent({ agents: [researcher] }, { baseUrl: provider.url });

        await agent.generate("hi", { tools: false });
        expect(request(provider, 0).body.tools).toBeUndefined();

        await agent.generate("hi", { tools: ["something-else"] });
        expect(request(provider, 1).body.tools).toBeUndefined();
    });
});

describe("tool approval", () => {
    const refund = (calls: string[]) => define.Tool({
        id: "refund",
        description: "Refunds an order",
        approval: true,
        inputSchema: v.object({ order: v.string().required() }),
        execute: async ({ order }: any) => {
            calls.push(order);
            return { refunded: order };
        },
    });

    it("pauses before running it, then resumes on a decision — one model call each", async () => {
        const calls: string[] = [];
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? openaiTool("refund", { order: "A-1" }) : openaiText("Refunded.")));
        const agent = makeAgent({ tools: { refund: refund(calls) } }, { baseUrl: provider.url });

        const paused = await agent.generate("Refund A-1", { thread: "t1" });

        expect(paused.finishReason).toBe("approval_required");
        expect(paused.pendingApprovals).toEqual([
            { toolCallId: "call_1", name: "refund", args: { order: "A-1" } },
        ]);
        expect(calls).toEqual([]); // nothing ran before the decision
        expect(provider.hits()).toBe(1);

        const resumed = await agent.generate("", {
            thread: "t1",
            resume: { messages: paused.messages, decisions: { call_1: true } },
        });

        expect(calls).toEqual(["A-1"]);
        expect(resumed.finishReason).toBe("stop");
        expect(resumed.text).toBe("Refunded.");
        // The paused step is not replayed through the model: approving costs one call
        expect(provider.hits()).toBe(2);
    });

    it("tells the model when the caller refuses", async () => {
        const calls: string[] = [];
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? openaiTool("refund", { order: "A-1" }) : openaiText("Understood.")));
        const agent = makeAgent({ tools: { refund: refund(calls) } }, { baseUrl: provider.url });

        const paused = await agent.generate("Refund A-1", { thread: "t1" });
        const resumed = await agent.generate("", {
            thread: "t1",
            resume: { messages: paused.messages, decisions: { call_1: false } },
        });

        expect(calls).toEqual([]); // the tool never ran
        expect(resumed.text).toBe("Understood.");

        // The refusal is in the conversation the model saw, as a failed tool
        const toolTurn = request(provider, 1).body.messages.find((message: any) => message.role === "tool");
        expect(toolTurn.content).toContain("Refused by the caller");
    });

    it("stays paused while a call has no decision", async () => {
        const calls: string[] = [];
        const provider = track(fakeProvider(() => openaiTool("refund", { order: "A-1" })));
        const agent = makeAgent({ tools: { refund: refund(calls) } }, { baseUrl: provider.url });

        const paused = await agent.generate("Refund A-1", { thread: "t1" });
        const again = await agent.generate("", {
            thread: "t1",
            resume: { messages: paused.messages, decisions: {} },
        });

        expect(again.finishReason).toBe("approval_required");
        expect(again.pendingApprovals).toHaveLength(1);
        expect(calls).toEqual([]);
        expect(provider.hits()).toBe(1); // nobody was asked again
    });

    it("runs a tool that does not ask for approval without a decision", async () => {
        const calls: string[] = [];
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1
                ? openaiTwoCalls("both")
                : openaiText("done")));
        const agent = makeAgent({
            tools: {
                both: define.Tool({
                    id: "both",
                    description: "Needs no decision",
                    inputSchema: v.object({ n: v.number().optional() }),
                    execute: async ({ n }: any) => {
                        calls.push(String(n));
                        return `n${n}`;
                    },
                }),
            },
        }, { baseUrl: provider.url });

        // No `approval: true` anywhere: the step runs, and nothing pauses
        const result = await agent.generate("hi");

        expect(calls).toEqual(["1", "2"]);
        expect(result.finishReason).toBe("stop");
    });
});

describe("agent version", () => {
    it("is served by `info`", () => {
        const agent = makeAgent({ version: "2026-09-24" });

        expect(agent.toJSON().version).toBe("2026-09-24");
        expect(agents.get("nobody", "test")).toBeUndefined();
    });
});
