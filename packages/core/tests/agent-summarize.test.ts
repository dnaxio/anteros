/**
 * History compaction — `agents.memory.summarize()`.
 *
 * A thread that grew past a threshold is compacted **for the prompt**: the oldest
 * turns become one summary written by a model you name. The summary is cached in the
 * store's state for the thread it belongs to, so a long conversation costs one
 * summary per `keep` turns instead of one per turn — and the prompt prefix stays put
 * between refreshes.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { Agent, agents } from "../index";
import { InMemoryAgentMemory } from "../lib/agent";
import { fakeProvider, openaiText, request, type Fake } from "./fixtures/fake-provider";

const servers: Fake[] = [];
function track(fake: Fake): Fake {
    servers.push(fake);
    return fake;
}

afterAll(() => {
    for (const server of servers) server.stop();
});

/** The summariser answers `SUMMARY`, the agent under test answers `answer`. */
function route(body: any): Response {
    return body.messages[0].content === "You condense." ? openaiText("SUMMARY") : openaiText("answer");
}

function seed(count: number): any[] {
    return Array.from({ length: count }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `m${index}`,
    }));
}

describe("agents.memory.summarize", () => {
    const build = (provider: Fake, options: Record<string, any> = {}) => {
        const summarizer = new Agent({
            id: "compact",
            description: "Condenses a conversation.",
            instructions: "You condense.",
            provider: { model: "test-model", apiKey: "test-key", baseUrl: provider.url, options: { retries: 0 } },
        } as any);

        const memory = new InMemoryAgentMemory();
        const agent = new Agent({
            id: "test",
            description: "A test agent.",
            instructions: "You are a test agent.",
            provider: { model: "test-model", apiKey: "test-key", baseUrl: provider.url, options: { retries: 0 } },
            memory,
            processors: [agents.memory.summarize({ agent: summarizer, keep: 10, threshold: 12, ...options })],
        } as any);

        return { agent, memory };
    };

    it("compacts the oldest turns for the prompt, and leaves the thread alone", async () => {
        const provider = track(fakeProvider(route));
        const { agent, memory } = build(provider);
        const seeded = seed(20);
        await memory.save("t1", seeded as any);

        await agent.generate("next?", { thread: "t1" });

        // The summariser is called first, then the run
        const prompt = request(provider, 1).body.messages;
        expect(prompt[0].role).toBe("system");
        expect(prompt[1].content).toContain("[Summary of the conversation so far]");
        expect(prompt[1].content).toContain("SUMMARY");
        // …then the last 10 turns verbatim (m11…m19 and the question), then the system
        expect(prompt).toHaveLength(12);
        expect(prompt[2].content).toBe("m11");
        expect(prompt[10].content).toBe("m19");
        expect(prompt[11].content).toBe("next?");

        // The store keeps everything: the compaction shapes the prompt, never the thread
        expect(await memory.get("t1")).toHaveLength(22);
    });

    it("caches the summary in the store's state, one per window", async () => {
        const provider = track(fakeProvider(route));
        const { agent, memory } = build(provider);
        await memory.save("t1", seed(20) as any);

        const summarised = () => provider.requests.filter((entry) => entry.body.messages[0].content === "You condense.").length;

        await agent.generate("first?", { thread: "t1" });
        expect(summarised()).toBe(1);

        // The next turn moves the window by two messages — far from `keep`: reused
        await agent.generate("second?", { thread: "t1" });
        expect(summarised()).toBe(1);

        // The cache lives in the store, per thread
        const state = await (agent.getMemory() as any).getState("summary:t1", {});
        expect((state.value as any).summary).toBe("SUMMARY");
    });

    it("does nothing below the threshold", async () => {
        const provider = track(fakeProvider(route));
        const { agent, memory } = build(provider);
        await memory.save("t1", seed(4) as any);

        await agent.generate("next?", { thread: "t1" });

        const prompt = request(provider, 0).body.messages;
        expect(prompt).toHaveLength(6); // system + the 4 stored turns + the question
        expect(JSON.stringify(prompt)).not.toContain("[Summary");
    });

    it("refuses a summary the model did not write", async () => {
        const provider = track(fakeProvider((body) =>
            body.messages[0].content === "You condense." ? openaiText("   ") : openaiText("answer")));
        const { agent, memory } = build(provider);
        await memory.save("t1", seed(20) as any);

        await agent.generate("next?", { thread: "t1" });

        // An empty summary compacts nothing rather than dropping the conversation
        expect(JSON.stringify(request(provider, 1).body.messages)).not.toContain("[Summary");
    });
});
