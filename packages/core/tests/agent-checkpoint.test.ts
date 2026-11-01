/**
 * The durable checkpoint — a run that dies mid-loop (provider crash, process
 * restart) continues from its last completed step instead of paying for the whole
 * conversation again:
 *
 *  - the state is saved at a step boundary, never half a step;
 *  - `resumeRun()` asks the model for the **next** step only;
 *  - a run that comes back clears its state, a failed one keeps it;
 *  - a store that misbehaves never fails the run.
 */
import { describe, it, expect, afterAll, spyOn } from "bun:test";
import { Agent, define, v } from "../index";
import type { AgentRunState, AgentRunStore } from "../index";
import { at, fakeProvider, openaiText, openaiTool, request, type Fake } from "./fixtures/fake-provider";

const servers: Fake[] = [];
function track(fake: Fake): Fake {
    servers.push(fake);
    return fake;
}

afterAll(() => {
    for (const server of servers) server.stop();
});

/** A store backed by a `Map`, counting what it is asked to do. */
function memoryStore() {
    const states = new Map<string, AgentRunState>();
    const calls = { loads: 0, saves: 0, clears: 0 };

    const store = {
        states,
        calls,
        load(runId: string) {
            calls.loads += 1;
            return states.get(runId);
        },
        save(runId: string, state: AgentRunState) {
            calls.saves += 1;
            states.set(runId, state);
        },
        clear(runId: string) {
            calls.clears += 1;
            states.delete(runId);
        },
    };

    return store satisfies AgentRunStore;
}

function makeAgent(provider: Fake, overrides: Record<string, any> = {}) {
    return new Agent({
        id: "resumable",
        description: "An agent whose runs can be resumed.",
        instructions: "You are a test agent.",
        provider: {
            model: "test-model",
            apiKey: "test-key",
            protocol: "openai",
            baseUrl: provider.url,
            options: { retries: 0 },
        },
        tools: {
            echo: define.Tool({
                id: "echo",
                description: "Echoes the text back.",
                inputSchema: v.object({ text: v.string().required() }),
                execute: async ({ text }: any) => ({ echoed: text }),
            }),
        },
        ...overrides,
    } as any);
}

/** A run that calls a tool on its first model call, then dies on the second. */
function dyingProvider(): Fake {
    return track(fakeProvider((_body, _req, hits) => hits === 1
        ? openaiTool("echo", { text: "hello" }, "call_echo")
        : hits === 2
            ? Response.json({ error: { message: "provider blew up" } }, { status: 400 })
            : openaiText("done")));
}

describe("durable checkpoint", () => {
    it("saves the last completed step, and a resume continues from it", async () => {
        const provider = dyingProvider();
        const store = memoryStore();
        const agent = makeAgent(provider, { checkpoint: store });

        await expect(agent.generate("say hello", { runId: "run-1" })).rejects.toThrow(/provider blew up/);

        const saved = store.states.get("run-1");
        expect(saved).toBeDefined();
        expect(saved!.runId).toBe("run-1");
        expect(saved!.agentId).toBe("resumable");
        expect(saved!.step).toBe(1);
        // The step finished with its tool result — the conversation is valid to replay
        expect(at(saved!.messages, saved!.messages.length - 1).role).toBe("tool");
        expect(saved!.usage.requests).toBe(1);
        expect(saved!.toolStats.calls).toBe(1);
        expect(typeof saved!.at).toBe("string");
        // A failed run keeps its state
        expect(store.calls.clears).toBe(0);

        // A fresh agent — the store is the only thing carrying the run over
        const fresh = makeAgent(provider, { checkpoint: store });
        const before = provider.hits();
        const resumed = await fresh.resumeRun("run-1");

        // The completed step is not replayed through the model: one call, the next step
        expect(provider.hits() - before).toBe(1);
        expect(resumed.text).toBe("done");
        expect(resumed.steps).toHaveLength(1);
        expect(at(resumed.steps, 0).step).toBe(1);
        // The whole conversation, not just the resumed segment; the counters are carried
        expect(resumed.messages.slice(0, saved!.messages.length)).toEqual(saved!.messages);
        expect(at(resumed.messages, resumed.messages.length - 1).role).toBe("assistant");
        expect(resumed.usage.requests).toBe(2);
        expect(resumed.toolStats.calls).toBe(1);
        expect(request(provider, 2).body.messages.map((message: any) => message.role))
            .toEqual(["system", "user", "assistant", "tool"]);
        // A run that came back has nothing left to resume
        expect(store.states.get("run-1")).toBeUndefined();
        expect(store.calls.clears).toBe(1);
    });

    it("refuses an unknown run — and a resume without a store", async () => {
        const provider = track(fakeProvider(() => openaiText("done")));
        const store = memoryStore();

        await expect(makeAgent(provider, { checkpoint: store }).resumeRun("never-started"))
            .rejects.toMatchObject({ code: "AGENT_CHECKPOINT_NOT_FOUND" });

        await expect(makeAgent(provider).resumeRun("run-1"))
            .rejects.toMatchObject({ code: "AGENT_CHECKPOINT_REQUIRED" });
        expect(provider.hits()).toBe(0);
    });

    it("clears the state of a successful run", async () => {
        const provider = track(fakeProvider(() => openaiText("done")));
        const store = memoryStore();

        const result = await makeAgent(provider, { checkpoint: store }).generate("hi", { runId: "run-clear" });

        expect(result.text).toBe("done");
        expect(store.calls.saves).toBeGreaterThan(0);
        expect(store.calls.clears).toBe(1);
        expect(store.states.has("run-clear")).toBe(false);
    });

    it("takes the store from the call over the declaration", async () => {
        const provider = track(fakeProvider(() => openaiText("done")));
        const declared = memoryStore();
        const callLevel = memoryStore();

        await makeAgent(provider, { checkpoint: declared })
            .generate("hi", { runId: "run-override", checkpoint: callLevel });

        expect(callLevel.calls.saves).toBeGreaterThan(0);
        expect(declared.calls.saves).toBe(0);
    });

    it("saves nothing without a run id", async () => {
        const provider = track(fakeProvider(() => openaiText("done")));
        const store = memoryStore();

        await makeAgent(provider, { checkpoint: store }).generate("hi");

        expect(store.calls.saves).toBe(0);
        expect(store.calls.clears).toBe(0);
    });

    it("does not fail the run when the store cannot save", async () => {
        const provider = track(fakeProvider(() => openaiText("done")));
        const spy = spyOn(console, "error").mockImplementation(() => {});
        const store: AgentRunStore = {
            load: () => undefined,
            save: () => {
                throw new Error("disk full");
            },
            clear: () => {},
        };

        try {
            const result = await makeAgent(provider, { checkpoint: store }).generate("hi", { runId: "run-broken-store" });

            expect(result.text).toBe("done");
            expect(result.finishReason).toBe("stop");
            const logged = spy.mock.calls.map((call) => String(call[0])).join("\n");
            expect(logged).toContain("run-broken-store");
        } finally {
            spy.mockRestore();
        }
    });
});
