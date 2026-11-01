import { describe, it, expect, afterAll } from "bun:test";
import { Agent, define, evaluateAgent, v } from "../index";
import type { AgentTraceEvent } from "../index";
import {
    at,
    fakeProvider,
    openaiText,
    openaiTool,
    request,
    type Fake,
} from "./fixtures/fake-provider";

/**
 * The tracing hook (`onTrace`) and the evaluation helper (`evaluateAgent`).
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
        id: "traced",
        description: "A traced test agent.",
        instructions: "Answer.",
        provider: {
            model: "test-model",
            apiKey: "test-key",
            protocol: "openai",
            options: { retries: 0 },
            ...provider,
        },
        ...overrides,
    } as any);
}

function echoTool() {
    return define.Tool({
        id: "echo",
        description: "Echoes the text back.",
        inputSchema: v.object({ text: v.string().required() }),
        execute: ({ text }: any) => `echo:${text}`,
    });
}

describe("agent tracing", () => {
    it("emits the six event types, in order, with their fields", async () => {
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1 ? openaiTool("echo", { text: "hello" }) : openaiText("done")));
        const agent = makeAgent({ tools: { echo: echoTool() } }, { baseUrl: provider.url });

        const events: AgentTraceEvent[] = [];
        const result = await agent.generate("echo hello", { onTrace: (event) => events.push(event) });

        expect(result.text).toBe("done");
        expect(events.map((event) => event.type)).toEqual([
            "run.start",
            "step.start",
            "model.end",
            "tool.start",
            "tool.end",
            "step.start",
            "model.end",
            "run.end",
        ]);

        expect(at(events, 0)).toMatchObject({ type: "run.start", agentId: "traced" });
        expect(at(events, 1)).toMatchObject({ type: "step.start", step: 0 });
        expect(at(events, 2)).toMatchObject({ type: "model.end", step: 0, model: "test-model", finishReason: "tool_use" });
        expect(at(events, 3)).toMatchObject({ type: "tool.start", step: 0, tool: "echo", toolCallId: "call_1" });

        const toolEnd = at(events, 4) as Extract<AgentTraceEvent, { type: "tool.end" }>;
        expect(toolEnd).toMatchObject({ type: "tool.end", step: 0, tool: "echo", toolCallId: "call_1" });
        expect(toolEnd.durationMs).toBeGreaterThanOrEqual(0);
        expect(toolEnd.errorCode).toBeUndefined();

        const lastModel = at(events, 6) as Extract<AgentTraceEvent, { type: "model.end" }>;
        expect(lastModel).toMatchObject({ step: 1, model: "test-model", finishReason: "stop" });
        expect(lastModel.durationMs).toBeGreaterThanOrEqual(0);
        expect(lastModel.usage.requests).toBe(1);

        const end = at(events, 7) as Extract<AgentTraceEvent, { type: "run.end" }>;
        expect(end).toMatchObject({ type: "run.end", finishReason: "stop" });
        expect(end.durationMs).toBeGreaterThanOrEqual(0);
        expect(end.toolStats.calls).toBe(1);
        expect(end.usage.requests).toBe(2);
        expect(end.error).toBeUndefined();
    });

    it("never breaks a run when the tracer throws", async () => {
        const provider = track(fakeProvider(() => openaiText("still fine")));
        const agent = makeAgent({}, { baseUrl: provider.url });

        const result = await agent.generate("hi", {
            onTrace: () => {
                throw new Error("tracer boom");
            },
        });

        expect(result.text).toBe("still fine");
        expect(provider.hits()).toBe(1);
    });

    it("hands the call's runId to run.start", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const agent = makeAgent({}, { baseUrl: provider.url });

        const events: AgentTraceEvent[] = [];
        await agent.generate("hi", { runId: "run-42", onTrace: (event) => events.push(event) });

        expect(at(events, 0)).toMatchObject({ type: "run.start", runId: "run-42" });
    });

    it("traces nothing when an input guardrail blocks the prompt", async () => {
        const provider = track(fakeProvider(() => openaiText("never")));
        const agent = makeAgent({
            guardrails: {
                input: [{ name: "no-secrets", check: () => { throw new Error("blocked"); } }],
            },
        }, { baseUrl: provider.url });

        const events: AgentTraceEvent[] = [];
        await expect(agent.generate("a secret", { onTrace: (event) => events.push(event) }))
            .rejects.toMatchObject({ code: "AGENT_GUARDRAIL_BLOCKED" });

        expect(events).toEqual([]);
        expect(provider.hits()).toBe(0);
    });

    it("traces the end of a run that throws", async () => {
        const provider = track(fakeProvider(() => Response.json({ error: "boom" }, { status: 400 })));
        const agent = makeAgent({}, { baseUrl: provider.url });

        const events: AgentTraceEvent[] = [];
        await expect(agent.generate("hi", { onTrace: (event) => events.push(event) })).rejects.toBeDefined();

        const end = at(events, events.length - 1) as Extract<AgentTraceEvent, { type: "run.end" }>;
        expect(end.type).toBe("run.end");
        expect(end.finishReason).toBe("error");
        expect(end.error).toBeTruthy();
        expect(end.error).not.toContain("\n");
    });
});

describe("evaluateAgent", () => {
    it("scores cases sequentially with their graders, merging the case options last", async () => {
        const provider = track(fakeProvider((body) => {
            const messages = body.messages as Array<{ role: string; content: string }>;
            const lastUser = [...messages].reverse().find((message) => message.role === "user");
            return openaiText(`answer:${lastUser?.content ?? ""}`);
        }));
        const agent = makeAgent({}, { baseUrl: provider.url });

        const seen: string[] = [];
        const report = await evaluateAgent({
            agent,
            cases: [
                { name: "alpha", input: "alpha" },
                { name: "beta", input: "beta", options: { instructions: "case-two" } },
            ],
            graders: [
                (result, testCase) => {
                    seen.push(`${testCase.name}:${result.text}`);
                    return { score: 1, reason: `answered ${testCase.name}` };
                },
                () => {
                    throw new Error("grader exploded");
                },
            ],
            options: { instructions: "shared" },
        });

        expect(report.score).toBe(0.5);
        expect(report.passed).toBe(2);
        expect(report.cases.map((testCase) => testCase.name)).toEqual(["alpha", "beta"]);
        expect(report.cases.map((testCase) => testCase.score)).toEqual([0.5, 0.5]);
        expect(report.cases.map((testCase) => testCase.reasons)).toEqual([
            ["answered alpha", "grader exploded"],
            ["answered beta", "grader exploded"],
        ]);
        expect(at(report.cases, 0).finishReason).toBe("stop");
        expect(at(report.cases, 0).usage.requests).toBe(1);

        // Sequential: the cases ran one after the other, in order
        expect(seen).toEqual(["alpha:answer:alpha", "beta:answer:beta"]);
        expect(provider.hits()).toBe(2);

        // The case's options win over the shared ones
        expect(at(request(provider, 0).body.messages, 0)).toMatchObject({ role: "system", content: "shared" });
        expect(at(request(provider, 1).body.messages, 0)).toMatchObject({ role: "system", content: "case-two" });
    });

    it("reports nothing to score for an empty list of cases", async () => {
        const provider = track(fakeProvider(() => openaiText("unused")));
        const agent = makeAgent({}, { baseUrl: provider.url });

        const report = await evaluateAgent({ agent, cases: [], graders: [() => 1] });

        expect(report).toEqual({ score: 0, passed: 0, cases: [] });
        expect(provider.hits()).toBe(0);
    });

    it("gives a case score 0 when it has no grader", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const agent = makeAgent({}, { baseUrl: provider.url });

        const report = await evaluateAgent({ agent, cases: [{ name: "ungraded", input: "hi" }], graders: [] });

        expect(report.score).toBe(0);
        expect(report.passed).toBe(0);
        expect(at(report.cases, 0)).toMatchObject({ name: "ungraded", score: 0, reasons: [] });
    });
});
