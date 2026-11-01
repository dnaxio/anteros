import { describe, it, expect, afterAll } from "bun:test";
import { Agent, define, v } from "../index";
import { InMemoryAgentMemory } from "../lib/agent";
import {
    USAGE,
    at,
    fakeProvider,
    openaiText,
    openaiTool,
    request,
    type Fake,
} from "./fixtures/fake-provider";

/**
 * The P1 hardening of `define.Agent`: delegation, fallbacks, budgets, cost,
 * guardrails and the token-aware prompt window.
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
        id: "hardened",
        description: "A hardened test agent.",
        instructions: "Answer.",
        provider: {
            model: "primary-model",
            apiKey: "test-key",
            protocol: "openai",
            options: { retries: 0 },
            ...provider,
        },
        ...overrides,
    } as any);
}

/** A 500 the fallback chain must treat as retryable. */
const serverError = () => Response.json({ error: { message: "boom" } }, { status: 500 });

describe("model fallbacks", () => {
    it("hands over to the next endpoint on a 5xx, and reports the model that answered", async () => {
        const primary = track(fakeProvider(() => serverError()));
        const secondary = track(fakeProvider(() => openaiText("from the fallback")));

        const agent = makeAgent({}, {
            baseUrl: primary.url,
            fallbacks: [{ model: "fallback-model", baseUrl: secondary.url, apiKey: "fallback-key" }],
        });

        const result = await agent.generate("hi");

        expect(result.text).toBe("from the fallback");
        expect(result.model).toBe("fallback-model");
        expect(primary.hits()).toBe(1);
        expect(secondary.hits()).toBe(1);
    });

    it("does not fall back on a client error", async () => {
        const primary = track(fakeProvider(() => Response.json({ error: { message: "bad schema" } }, { status: 400 })));
        const secondary = track(fakeProvider(() => openaiText("should not happen")));

        const agent = makeAgent({}, {
            baseUrl: primary.url,
            fallbacks: [{ model: "fallback-model", baseUrl: secondary.url }],
        });

        await expect(agent.generate("hi")).rejects.toBeDefined();
        expect(secondary.hits()).toBe(0);
    });
});

describe("run budget", () => {
    it("stops on the token budget and answers the unanswered calls", async () => {
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? openaiTool("act", {}) : openaiText("never asked")));

        const agent = makeAgent({
            tools: {
                act: define.Tool({ id: "act", description: "Does something", inputSchema: v.object({}), execute: () => ({ ok: true }) }),
            },
        }, { baseUrl: provider.url });

        // One call already exceeds it (USAGE totals 15 tokens)
        const result = await agent.generate("go", { maxTokens: 5 });

        expect(result.finishReason).toBe("budget");
        expect(result.budget).toEqual({ limit: "tokens", value: 5 });
        expect(at(result.toolResults, 0).errorCode).toBe("AGENT_BUDGET_EXHAUSTED");
        // The assistant turn asked for a call: the conversation still answers it
        expect(result.messages.at(-1)!.role).toBe("tool");
    });

    it("stops on the wall-clock budget between steps", async () => {
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? openaiTool("slow", {}) : openaiText("never asked")));

        const agent = makeAgent({
            tools: {
                slow: define.Tool({
                    id: "slow",
                    description: "Takes its time",
                    inputSchema: v.object({}),
                    execute: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 40)),
                }),
            },
        }, { baseUrl: provider.url });

        const result = await agent.generate("go", { maxDurationMs: 5 });

        expect(result.finishReason).toBe("budget");
        expect(result.budget).toEqual({ limit: "duration", value: 5 });
    });

    it("turns pricing into a cost, and stops on the cost budget", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const pricing = { input: 1_000, output: 0 }; // per million tokens

        const cheap = makeAgent({}, { baseUrl: provider.url, pricing });
        const first = await cheap.generate("hi");
        // USAGE: 11 input tokens → 11 / 1e6 * 1000
        expect(first.usage.cost).toBeCloseTo(0.011, 6);

        const capped = makeAgent({}, { baseUrl: provider.url, pricing });
        const second = await capped.generate("hi", { maxCost: 0.001 });
        expect(second.finishReason).toBe("budget");
        expect(second.budget).toEqual({ limit: "cost", value: 0.001 });
    });
});

describe("guardrails", () => {
    it("blocks the prompt before any model call", async () => {
        const provider = track(fakeProvider(() => openaiText("should not happen")));
        const agent = makeAgent({
            guardrails: {
                input: [{ name: "no-secrets", check: (value: string) => { if (value.includes("secret")) throw new Error("secret detected"); } }],
            },
        }, { baseUrl: provider.url });

        await expect(agent.generate("my secret is 42")).rejects.toMatchObject({ code: "AGENT_GUARDRAIL_BLOCKED" });
        expect(provider.hits()).toBe(0);
    });

    it("blocks the answer after the model produced it", async () => {
        const provider = track(fakeProvider(() => openaiText("forbidden answer")));
        const agent = makeAgent({
            guardrails: {
                output: [{ name: "no-forbidden", check: (value: string) => { if (value.includes("forbidden")) throw new Error("not allowed"); } }],
            },
        }, { baseUrl: provider.url });

        await expect(agent.generate("hi")).rejects.toMatchObject({ code: "AGENT_GUARDRAIL_BLOCKED" });
        expect(provider.hits()).toBe(1);
    });
});

describe("prompt window in tokens", () => {
    it("drops the oldest turns to respect `contextTokens`", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const memory = new InMemoryAgentMemory();
        const long = "a".repeat(2_400); // ~600 tokens each
        await memory.save("t", [
            { role: "user", content: long },
            { role: "assistant", content: long },
            { role: "user", content: long },
            { role: "assistant", content: long },
        ]);

        const agent = makeAgent({ memory }, { baseUrl: provider.url });
        await agent.generate("now", { thread: "t", contextTokens: 100 });

        // The system prompt is part of `messages` on the OpenAI wire: only the
        // current question survives the window, the four long turns are dropped.
        const sent = request(provider, 0).body.messages;
        expect(sent).toHaveLength(2);
        expect(sent[0].role).toBe("system");
        expect(sent[1].content).toBe("now");
    });
});

describe("delegated runs", () => {
    it("folds the sub-agent's usage into the parent's", async () => {
        const child = track(fakeProvider(() => openaiText("child answer")));
        const parent = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? openaiTool("helper", { input: "do it" }) : openaiText("parent answer")));

        const helper = define.Agent({
            id: "helper",
            description: "A delegated agent",
            instructions: "Help.",
            provider: { model: "child-model", apiKey: "k", protocol: "openai", baseUrl: child.url, options: { retries: 0 } },
        });

        const agent = makeAgent({ agents: [helper] }, { baseUrl: parent.url });
        const result = await agent.generate("go", { maxSteps: 3 });

        expect(result.text).toBe("parent answer");
        // Parent: 2 calls (tool round + answer). Child: 1 call.
        expect(result.usage.requests).toBe(3);
        expect(result.usage.totalTokens).toBe(USAGE.total_tokens * 3);
    });

    it("refuses a delegated approval instead of losing it", async () => {
        const child = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? openaiTool("refund", {}) : openaiText("refunded")));
        const parent = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? openaiTool("helper", { input: "refund it" }) : openaiText("done")));

        const helper = define.Agent({
            id: "helper",
            description: "A delegated agent",
            instructions: "Help.",
            provider: { model: "child-model", apiKey: "k", protocol: "openai", baseUrl: child.url, options: { retries: 0 } },
            tools: {
                refund: define.Tool({
                    id: "refund",
                    description: "Refunds an order",
                    approval: true,
                    inputSchema: v.object({}),
                    execute: () => ({ ok: true }),
                }),
            },
        });

        const agent = makeAgent({ agents: [helper] }, { baseUrl: parent.url });
        const result = await agent.generate("go", { maxSteps: 3 });

        expect(at(result.toolResults, 0).errorCode).toBe("AGENT_APPROVAL_IN_DELEGATION");
        expect(result.toolStats.byCode.AGENT_APPROVAL_IN_DELEGATION).toBe(1);
    });
});
