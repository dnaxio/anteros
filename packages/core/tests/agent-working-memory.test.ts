import { describe, it, expect, afterAll } from "bun:test";
import { Agent, define, v } from "../index";
import { InMemoryAgentMemory } from "../lib/agent";
import { agents } from "../lib/agents";
import type { AgentMemoryProcessor } from "../types/agent";
import {
    anthropicText,
    at,
    fakeProvider,
    openaiText,
    openaiTool,
    request,
    type Fake,
} from "./fixtures/fake-provider";

/**
 * Working memory, history window and memory processors — the three additions
 * that come from the Mastra memory model (see the Memory page).
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
        id: "memo",
        description: "An agent with a memory.",
        instructions: "You are a test agent.",
        provider: {
            model: "test-model",
            apiKey: "test-key",
            compatible: "openai",
            options: { retries: 0 },
            ...provider,
        },
        ...overrides,
    } as any);
}

/** The prompt the provider received, as one string. */
function sentSystem(provider: Fake, index = 0): string {
    const messages = request(provider, index).body.messages;
    return messages.filter((message: any) => message.role === "system")
        .map((message: any) => message.content).join("\n");
}

describe("working memory — template", () => {
    const template = "# Profile\n- Name:\n- Timezone:";

    it("injects the block into the system prompt, with the update tool", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const agent = makeAgent(
            { memory: new InMemoryAgentMemory(), workingMemory: { template } },
            { baseUrl: provider.url },
        );

        await agent.generate("Bonjour", { thread: "t1", resource: "u1" });

        const system = sentSystem(provider);
        expect(system).toContain("## Working memory");
        expect(system).toContain("# Profile\n- Name:\n- Timezone:"); // the empty template
        expect(system).toContain("updateWorkingMemory");

        const tools = request(provider, 0).body.tools.map((tool: any) => tool.function.name);
        expect(tools).toEqual(["updateWorkingMemory"]);
        expect(request(provider, 0).body.tools[0].function.parameters.required).toEqual(["content"]);
    });

    it("stores what the model wrote, and replays it on the next run", async () => {
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1
                ? openaiTool("updateWorkingMemory", { content: "# Profile\n- Name: Sam\n- Timezone: CET" })
                : openaiText("Noted.")));
        const memory = new InMemoryAgentMemory();
        const agent = makeAgent({ memory, workingMemory: { template } }, { baseUrl: provider.url });

        const result = await agent.generate("Je m'appelle Sam, je suis en CET", { thread: "t1", resource: "u1" });

        expect(result.toolResults[0]!.name).toBe("updateWorkingMemory");
        expect(result.toolResults[0]!.error).toBeUndefined();
        expect(await agent.getWorkingMemory({ resource: "u1" })).toBe("# Profile\n- Name: Sam\n- Timezone: CET");

        // The block is built **once per run**: the model call that follows the tool
        // still holds the prompt it started with…
        expect(sentSystem(provider, 1)).toContain("- Name:\n");

        // …and the next run reads the stored profile back
        await agent.generate("Et moi ?", { thread: "t1", resource: "u1" });
        expect(sentSystem(provider, 2)).toContain("- Name: Sam");
    });

    it("is shared by every thread of a caller, and isolated between callers", async () => {
        const memory = new InMemoryAgentMemory();
        const agent = makeAgent({ memory, workingMemory: { template } }, { baseUrl: "http://127.0.0.1:1" });

        await agent.setWorkingMemory("# Profile\n- Name: Sam", { resource: "u1", thread: "t1" });
        // Another thread, same caller
        expect(await agent.getWorkingMemory({ resource: "u1", thread: "t2" })).toContain("Sam");
        // Another caller
        expect(await agent.getWorkingMemory({ resource: "u2", thread: "t1" })).toBeUndefined();
    });

    it("scopes per thread when asked, and stays inert without the ids it needs", async () => {
        const memory = new InMemoryAgentMemory();
        const agent = makeAgent(
            { memory, workingMemory: { template, scope: "thread" } },
            { baseUrl: "http://127.0.0.1:1" },
        );

        await agent.setWorkingMemory("thread one", { resource: "u1", thread: "t1" });
        expect(await agent.getWorkingMemory({ resource: "u1", thread: "t1" })).toBe("thread one");
        expect(await agent.getWorkingMemory({ resource: "u1", thread: "t2" })).toBeUndefined();

        // No `resource` and no `thread` → nothing to key it with, so nothing happens
        const provider = track(fakeProvider(() => openaiText("ok")));
        const loose = makeAgent(
            { memory: new InMemoryAgentMemory(), workingMemory: { template } },
            { baseUrl: provider.url },
        );
        await loose.generate("hi");
        expect(sentSystem(provider)).not.toContain("## Working memory");
    });

    it("is read-only when the run is readOnly, and drops the tool when tools are narrowed", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const agent = makeAgent(
            { memory: new InMemoryAgentMemory(), workingMemory: { template } },
            { baseUrl: provider.url },
        );

        await agent.generate("hi", { thread: "t1", resource: "u1", memory: { readOnly: true } });
        expect(sentSystem(provider)).toContain("## Working memory");
        expect(request(provider, 0).body.tools).toBeUndefined(); // no tool to write with

        await agent.generate("hi", { thread: "t1", resource: "u1", tools: false });
        expect(request(provider, 1).body.tools).toBeUndefined();

        await agent.generate("hi", { thread: "t1", resource: "u1", tools: ["forecast"] });
        expect(request(provider, 2).body.tools).toBeUndefined(); // an allow-list is respected
    });

    it("lets a tenant declare its own `updateWorkingMemory` tool", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const agent = makeAgent({
            memory: new InMemoryAgentMemory(),
            workingMemory: { template },
            tools: {
                updateWorkingMemory: define.Tool({
                    id: "updateWorkingMemory",
                    description: "Ours.",
                    execute: () => "mine",
                }),
            },
        }, { baseUrl: provider.url });

        await agent.generate("hi", { thread: "t1", resource: "u1" });
        expect(request(provider, 0).body.tools[0].function.description).toBe("Ours.");
    });

    it("refuses a declaration with both a template and a schema, or neither", () => {
        const memory = new InMemoryAgentMemory();
        expect(() => makeAgent({ memory, workingMemory: {} })).toThrow(/AGENT_WORKING_MEMORY_INVALID|template/);
        expect(() => makeAgent({ memory, workingMemory: { template: "x", schema: v.object({}) } })).toThrow(/template/);
    });

    it("refuses to write without a memory, without a declaration, or without the scope id", async () => {
        const noMemory = makeAgent({}, { baseUrl: "http://127.0.0.1:1" });
        expect((await noMemory.setWorkingMemory("x", { resource: "u1" }).catch((err) => err)).code)
            .toBe("AGENT_NO_MEMORY");

        const declared = makeAgent({ memory: new InMemoryAgentMemory() }, { baseUrl: "http://127.0.0.1:1" });
        expect((await declared.setWorkingMemory("x", { resource: "u1" }).catch((err) => err)).code)
            .toBe("AGENT_WORKING_MEMORY_DISABLED");

        const agent = makeAgent(
            { memory: new InMemoryAgentMemory(), workingMemory: { template } },
            { baseUrl: "http://127.0.0.1:1" },
        );
        expect((await agent.setWorkingMemory("x").catch((err) => err)).code)
            .toBe("AGENT_WORKING_MEMORY_SCOPE_REQUIRED");

        // A store that cannot keep a scratchpad says so
        const poor = makeAgent({
            memory: { get: () => [], save: () => {}, clear: () => {} } as any,
            workingMemory: { template },
        }, { baseUrl: "http://127.0.0.1:1" });
        expect((await poor.setWorkingMemory("x", { resource: "u1" }).catch((err) => err)).code)
            .toBe("AGENT_WORKING_MEMORY_UNSUPPORTED");
    });
});

describe("working memory — schema", () => {
    const schema = v.object({
        name: v.string(),
        timezone: v.string(),
        goals: v.array().items(v.string()),
    });

    const profileAgent = (provider: string) => makeAgent({
        memory: new InMemoryAgentMemory(),
        workingMemory: { schema },
    }, { baseUrl: provider });

    it("hands the model a JSON block and a patch-shaped tool", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        await profileAgent(provider.url).generate("hi", { thread: "t1", resource: "u1" });

        expect(sentSystem(provider)).toContain("```json");
        expect(sentSystem(provider)).toContain("{}");
        // Patch semantics: nothing is required, so the model sends only what it learned
        expect(request(provider, 0).body.tools[0].function.parameters.required).toBeUndefined();
        expect(Object.keys(request(provider, 0).body.tools[0].function.parameters.properties))
            .toEqual(["name", "timezone", "goals"]);
    });

    it("deep merges an update, replaces arrays, and removes a field sent as null", async () => {
        const agent = profileAgent("http://127.0.0.1:1");

        expect(await agent.setWorkingMemory({ name: "Sam", timezone: "CET" }, { resource: "u1" }))
            .toEqual({ name: "Sam", timezone: "CET" });
        expect(await agent.setWorkingMemory({ goals: ["ship v1"] }, { resource: "u1" }))
            .toEqual({ name: "Sam", timezone: "CET", goals: ["ship v1"] });
        // An array replaces, it does not append
        expect(await agent.setWorkingMemory({ goals: ["ship v2", "rest"] }, { resource: "u1" }))
            .toEqual({ name: "Sam", timezone: "CET", goals: ["ship v2", "rest"] });
        // `null` removes a key
        expect(await agent.setWorkingMemory({ timezone: null }, { resource: "u1" }))
            .toEqual({ name: "Sam", goals: ["ship v2", "rest"] });
    });

    it("refuses an update that breaks the schema", async () => {
        const agent = profileAgent("http://127.0.0.1:1");
        const error: any = await agent.setWorkingMemory({ name: 42 }, { resource: "u1" }).catch((err) => err);
        expect(error).toBeInstanceOf(Error);
        expect(await agent.getWorkingMemory({ resource: "u1" })).toBeUndefined();
    });

    it("reports a bad tool argument to the model instead of failing the run", async () => {
        const provider = track(fakeProvider((_body, _req, hits) =>
            hits === 1
                ? openaiTool("updateWorkingMemory", { name: 42 })
                : openaiText("sorry")));
        const agent = profileAgent(provider.url);

        const result = await agent.generate("call me 42", { thread: "t1", resource: "u1" });

        expect(result.text).toBe("sorry");
        expect(at(result.toolResults, 0).name).toBe("updateWorkingMemory");
        expect(at(result.toolResults, 0).error).toContain("must be a string");
        expect(await agent.getWorkingMemory({ resource: "u1" })).toBeUndefined();
    });

    it("clears the scratchpad", async () => {
        const agent = profileAgent("http://127.0.0.1:1");
        await agent.setWorkingMemory({ name: "Sam" }, { resource: "u1" });
        await agent.clearWorkingMemory({ resource: "u1" });
        expect(await agent.getWorkingMemory({ resource: "u1" })).toBeUndefined();
    });
});

describe("history window — `lastMessages`", () => {
    const seeded = async () => {
        const memory = new InMemoryAgentMemory();
        await memory.save("t1", [
            { role: "user", content: "one" },
            { role: "assistant", content: "1" },
            { role: "user", content: "two" },
            { role: "assistant", content: "2" },
            { role: "user", content: "three" },
            { role: "assistant", content: "3" },
        ]);
        return memory;
    };

    it("replays the last N messages, keeping the store untouched", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const memory = await seeded();
        const agent = makeAgent({ memory }, { baseUrl: provider.url });

        await agent.generate("four", { thread: "t1", lastMessages: 2 });

        expect(request(provider, 0).body.messages.map((m: any) => m.content)).toEqual([
            "You are a test agent.", "three", "3", "four",
        ]);
        // The window is a prompt decision, not a write: the whole thread is still there
        expect(await agent.getMessages("t1")).toHaveLength(8); // 6 + question + answer
    });

    it("takes the declaration default, and a call overrides it", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const memory = await seeded();
        const agent = makeAgent({ memory, lastMessages: 1 }, { baseUrl: provider.url });

        await agent.generate("four", { thread: "t1" });
        expect(request(provider, 0).body.messages.map((m: any) => m.content))
            .toEqual(["You are a test agent.", "3", "four"]);

        await agent.generate("five", { thread: "t1", lastMessages: 3 });
        // The store kept everything (6 seeded + `four` + `ok`); the window replays its last 3
        expect(request(provider, 1).body.messages.map((m: any) => m.content))
            .toEqual(["You are a test agent.", "3", "four", "ok", "five"]);
    });
});

describe("memory processors", () => {
    it("`load` rewrites what the model sees", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const memory = new InMemoryAgentMemory();
        await memory.save("t1", [{ role: "user", content: "mon mot de passe est hunter2" }]);

        const processors: AgentMemoryProcessor[] = [
            // A redactor, a translator, your own recall… anything
            {
                id: "hide-history",
                load: (messages) => messages.filter((message) => !String(message.content).includes("hunter2")),
            },
        ];

        const agent = makeAgent({ memory, processors }, { baseUrl: provider.url });

        await agent.generate("C'était quoi ?", { thread: "t1" });

        const contents = request(provider, 0).body.messages.map((m: any) => m.content);
        expect(contents.join("\n")).not.toContain("hunter2");
        expect(contents.at(-1)).toBe("C'était quoi ?");
    });

    it("`save` rewrites what is stored", async () => {
        const provider = track(fakeProvider(() => openaiText("SECRET")));
        const memory = new InMemoryAgentMemory();
        const processors: AgentMemoryProcessor[] = [
            { save: (messages) => messages.map((message) => ({ ...message, content: "[redacted]" })) },
        ];
        const agent = makeAgent({ memory, processors }, { baseUrl: provider.url });

        await agent.generate("hi", { thread: "t1" });

        expect((await agent.getMessages("t1")).map((message) => message.content))
            .toEqual(["[redacted]", "[redacted]"]);
        // …without touching the answer the caller received
        expect(request(provider, 0).body.messages.at(-1).content).toBe("hi");
    });

    it("a throwing `save` keeps the conversation out of the store — the answer still returns", async () => {
        const provider = track(fakeProvider(() => openaiText("blocked")));
        const processors: AgentMemoryProcessor[] = [{
            save: (messages) => {
                if (String(messages.at(-1)?.content).includes("blocked")) throw new Error("guardrail");
                return messages;
            },
        }];
        const agent = makeAgent({ memory: new InMemoryAgentMemory(), processors }, { baseUrl: provider.url });

        const result = await agent.generate("this is blocked", { thread: "t1" });

        expect(result.text).toBe("blocked");
        expect(await agent.getMessages("t1")).toEqual([]);
    });

    it("runs in order, and a processor that returns nothing leaves the messages alone", async () => {
        const provider = track(fakeProvider(() => openaiText("ok")));
        const seen: string[] = [];
        const processors: AgentMemoryProcessor[] = [
            { id: "first", load: () => { seen.push("first"); } },
            { id: "second", load: (messages) => { seen.push("second"); return [...messages, { role: "system", content: "added" }]; } },
        ];
        const agent = makeAgent({ memory: new InMemoryAgentMemory(), processors }, { baseUrl: provider.url });

        await agent.generate("hi", { thread: "t1" });

        expect(seen).toEqual(["first", "second"]);
        expect(sentSystem(provider)).toContain("added");
    });
});

describe("working memory — Anthropic", () => {
    it("travels in the system prompt, out of band", async () => {
        const provider = track(fakeProvider(() => anthropicText("ok")));
        const agent = makeAgent(
            { memory: new InMemoryAgentMemory(), workingMemory: { template: "# Memo\n- x:" } },
            { compatible: "anthropic", baseUrl: provider.url },
        );

        await agent.generate("hi", { thread: "t1", resource: "u1" });

        expect(request(provider, 0).body.system).toContain("## Working memory");
        expect(request(provider, 0).body.tools[0].name).toBe("updateWorkingMemory");
    });
});

describe("working memory — the registry exposes nothing new by accident", () => {
    it("keeps `agents.memory` as the only store factory", () => {
        expect(Object.keys(agents.memory).sort()).toEqual(["InMemory", "Mongo", "Redis"]);
    });
});
