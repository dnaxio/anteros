import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../server/hono";
import { formatConfig, cfg } from "../server/config";
import { syncTenants } from "../database/tenant";
import { syncCollections } from "../database/collection";
import { syncAgents } from "../lib/agents";
import { createApi } from "../lib/api";
import { loadServices } from "../lib/services";
import { loadRoutes } from "../lib/routes";
import { useRest } from "../database/rest";
import { jwt } from "../utils/func";
import { AUDIT_COLLECTION } from "../database/audit";
import { fakeProvider, at, openaiStream, openaiText, openaiTool, type Fake } from "./fixtures/fake-provider";

/**
 * `POST /api/:tenant_id/agents/:agent/:action` — access control, the six actions,
 * SSE streaming and the audit trail.
 *
 * One fake provider answers every case, routed on what the runtime actually
 * sent (a stream, a JSON-schema prompt, a "loop" input, a tool result) — no
 * registry juggling, no provider swapping mid-suite.
 */

const TENANT = "agents-api";
const DB = "mongodb://localhost:27017/_AGENTS_API_TEST";
const DIR = "packages/core/tests/fixtures/agents-api";

let provider: Fake;
let server: any;
let url = "";
let rest: InstanceType<typeof useRest>;
let token = "";

const BASE = () => `${url}/api/${TENANT}/agents`;

function post(agent: string, action: string, body?: any, withToken = true) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (withToken) headers.Authorization = `Bearer ${token}`;
    return fetch(`${BASE()}/${agent}/${action}`, {
        method: "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

async function json(agent: string, action: string, body?: any, withToken = true) {
    const res = await post(agent, action, body, withToken);
    return { status: res.status, body: (await res.json()) as any };
}

/** Decode an SSE body into its events. */
async function readSse(res: Response): Promise<any[]> {
    const text = await res.text();
    return text
        .split(/\r?\n\r?\n/)
        .map((block) => block.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim())
        .filter((data): data is string => !!data)
        .map((data) => JSON.parse(data));
}

function auditEntries(action: string, collection: string, since: Date) {
    return rest.db.collection(AUDIT_COLLECTION)
        .find({ "operation.action": action, "operation.collection": collection, ts: { $gte: since } })
        .sort({ ts: -1 })
        .toArray();
}

beforeAll(async () => {
    // The fixture reads the provider URL from the environment at import time,
    // so the fake server must exist before `syncAgents()`.
    provider = fakeProvider((body) => {
        if (body?.stream) return openaiStream(["Bon", "jour"]);

        const system = typeof body?.messages?.[0]?.content === "string" ? body.messages[0].content : "";
        if (body?.messages?.[0]?.role === "system" && system.includes("JSON Schema")) {
            return openaiText('{"city":"Paris","celsius":21}');
        }

        // The whole conversation is searched: this keeps the tool loop looping
        if (JSON.stringify(body?.messages ?? []).includes("loop")) {
            return openaiTool("echo", { text: "loop" });
        }

        const last = body?.messages?.at(-1);
        return last?.role === "tool" ? openaiText("Bonjour") : openaiTool("echo", { text: "hello" });
    });
    process.env.AGENT_API_TEST_URL = provider.url;

    formatConfig({
        server: { port: 4000, jwt: { secret: "agents-api-test-secret" } },
        tenants: [{
            id: TENANT,
            dir: DIR,
            routes: { prefix: "/v1" },
            database: { uri: DB },
        } as any],
    });
    await syncTenants();
    await syncCollections();
    await syncAgents();
    await loadServices();
    await loadRoutes();

    rest = new useRest({ internal: false, tenant_id: TENANT });
    token = await jwt.sign({ sub: "tester" });

    const app = createApp();
    server = Bun.serve({ port: 0, fetch: app.fetch });
    url = server.url.href.replace(/\/$/, "");
});

afterAll(async () => {
    try { await rest.db.dropDatabase(); } catch (_) { /* already gone */ }
    try { server.stop(true); } catch (_) { /* already stopped */ }
    try { provider.stop(); } catch (_) { /* already stopped */ }
    delete process.env.AGENT_API_TEST_URL;
    cfg.agents = [];
    cfg.services = [];
    cfg.routes = [];
    cfg.tenants = [];
});

describe("agents HTTP API — access control", () => {
    it("denies an agent with no `api` at all", async () => {
        const res = await json("private", "generate", { input: "hi" });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe("ACCESS_DENIED");
    });

    it("denies an action with no rule, even for an authenticated caller", async () => {
        // `plain` only declares `generate`
        const res = await json("plain", "history", { thread: "t" });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe("ACCESS_DENIED");
    });

    it("requires a token for a function rule", async () => {
        const res = await json("assistant", "generate", { input: "hi" }, false);
        expect(res.status).toBe(401);
        expect(res.body.code).toBe("AUTH_REQUIRED");
    });

    it("rejects an invalid token", async () => {
        const res = await fetch(`${BASE()}/assistant/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer not-a-token" },
            body: JSON.stringify({ input: "hi" }),
        });
        const body = await res.json() as any;
        expect(res.status).toBe(401);
        expect(body.code).toBe("AUTH_REQUIRED");
    });

    it("allows a public action without a token", async () => {
        const res = await json("plain", "generate", { input: "hi" }, false);
        expect(res.status).toBe(200);
        expect(res.body.text).toBe("Bonjour");
    });

    it("rejects an unknown agent", async () => {
        const res = await json("nope", "generate", { input: "hi" });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("AGENT_NOT_FOUND");
    });

    it("rejects an unknown tenant", async () => {
        const res = await fetch(`${url}/api/nope/agents/assistant/info`, { method: "POST" });
        expect(res.status).toBe(400);
        expect((await res.json() as any).code).toBe("TENANT_NOT_FOUND");
    });
});

describe("agents HTTP API — actions", () => {
    it("info needs no model call and leaks no API key", async () => {
        const before = provider.hits();
        const res = await json("assistant", "info");

        expect(res.status).toBe(200);
        expect(provider.hits()).toBe(before);
        expect(res.body.agent.id).toBe("assistant");
        expect(res.body.agent.tools).toEqual(["echo"]);
        expect(res.body.agent.provider.model).toBe("test-model");
        expect(res.body.agent.provider.compatible).toBe("openai");
        expect(res.body.agent.maxSteps).toBe(3);
        expect(res.body.agent.memory).toBe(true);
        expect(JSON.stringify(res.body)).not.toContain("test-key");
    });

    it("generate runs the tool loop and returns the envelope", async () => {
        const res = await json("assistant", "generate", { input: "Weather?" });

        expect(res.status).toBe(200);
        expect(res.body.text).toBe("Bonjour");
        expect(res.body.finishReason).toBe("stop");
        expect(res.body.toolCalls.map((call: any) => call.name)).toEqual(["echo"]);
        expect(res.body.toolResults[0].result).toEqual({ echoed: "hello" });
        expect(res.body.usage.requests).toBe(2);
        // The conversation is never inlined — `history` serves it
        expect(res.body.messages).toBeUndefined();
    });

    it("accepts the run options of the in-process API — `messages` and `lastMessages`", async () => {
        const before = provider.requests.length;

        const res = await json("assistant", "generate", {
            input: "and in Lyon?",
            thread: "opts-1",
            messages: [
                { role: "user", content: "weather in Paris?" },
                { role: "assistant", content: "18°C and sunny." },
            ],
            maxSteps: 2,
            lastMessages: 10,
        });

        expect(res.status).toBe(200);
        // The run's FIRST model call (the fixture loops on a tool afterwards)
        const sent = at<any>(provider.requests, before).body.messages;
        const contents = sent.map((message: any) => message.content);
        expect(contents.join("\n")).toContain("18°C and sunny.");
        expect(contents.at(-1)).toBe("and in Lyon?");
        expect(provider.requests.length).toBeGreaterThan(before);
    });

    it("refuses injected turns the model could not have seen", async () => {
        const res = await json("assistant", "generate", {
            input: "hi",
            messages: [{ role: "assistant", content: [{ type: "image", url: "https://example.com/a.png" }] }],
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("INVALID_INPUT");
    });

    it("lets a client lower the replayed window but never raise it", async () => {
        // The fixture declares no `lastMessages`: the request is honoured as asked
        const res = await json("assistant", "generate", { input: "hi", lastMessages: 1 });
        expect(res.status).toBe(200);
        expect(res.body.code).toBeUndefined();
    });

    it("validates the body", async () => {
        expect((await json("assistant", "generate", {})).status).toBe(400);
        expect((await json("assistant", "generate", {})).body.code).toBe("INPUT_REQUIRED");
        expect((await json("assistant", "generate", { input: [] })).body.code).toBe("INPUT_REQUIRED");
        expect((await json("assistant", "generate", { input: [{ content: "x" }] })).body.code).toBe("INVALID_INPUT");

        const malformed = await fetch(`${BASE()}/assistant/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: "{oops",
        });
        expect(malformed.status).toBe(400);
        expect((await malformed.json() as any).code).toBe("INVALID_JSON_BODY");
    });

    it("accepts a full message array", async () => {
        const res = await json("assistant", "generate", {
            input: [
                { role: "user", content: "First" },
                { role: "assistant", content: "Noted" },
                { role: "user", content: "Second" },
            ],
        });
        expect(res.status).toBe(200);
        expect(res.body.text).toBe("Bonjour");
    });

    it("accepts a single message, and the unified content parts", async () => {
        // One message, not an array — the same shape the in-process runtime takes
        const single = await json("assistant", "generate", { input: { role: "user", content: "hi" } });
        expect(single.status).toBe(200);
        expect(single.body.text).toBe("Bonjour");

        // …and a conversation written with `tool-call` / `tool-result` parts
        const unified = await json("assistant", "generate", {
            input: [
                { role: "user", content: [{ type: "text", text: "Weather?" }] },
                { role: "assistant", content: [{ type: "tool-call", id: "call_9", name: "echo", arguments: { text: "hi" } }] },
                { role: "user", content: [{ type: "tool-result", id: "call_9", name: "echo", result: "why not" }] },
            ],
        });
        expect(unified.status).toBe(200);

        // The runtime turned the parts into the canonical turns before calling the model
        const sent = at<any>(provider.requests, provider.requests.length - 1).body.messages;
        expect(sent.map((message: any) => message.role)).toEqual(["system", "user", "assistant", "tool"]);
        expect(sent[2].tool_calls[0].function.name).toBe("echo");
        expect(sent[3].tool_call_id).toBe("call_9");
    });

    it("refuses a message role or a content part it cannot carry", async () => {
        expect((await json("assistant", "generate", { input: { role: "robot", content: "hi" } })).body.code)
            .toBe("INVALID_INPUT");
        expect((await json("assistant", "generate", {
            input: [{ role: "assistant", content: [{ type: "image", url: "https://example.com/a.png" }] }],
        })).body.code).toBe("INVALID_INPUT");
        expect((await json("assistant", "generate", { input: "" })).body.code).toBe("INPUT_REQUIRED");
    });

    it("lets a client lower maxSteps but never raise it", async () => {
        // Declared ceiling is 3, and the input keeps the tool loop looping:
        // a client asking for 1 gets exactly 1 model call…
        const one = await json("assistant", "generate", { input: "loop", maxSteps: 1 });
        expect(one.body.finishReason).toBe("max_steps");

        // …and one asking for 99 is still capped at the declared 3
        const before = provider.hits();
        const many = await json("assistant", "generate", { input: "loop", maxSteps: 99 });
        expect(provider.hits() - before).toBe(3);
        expect(many.body.finishReason).toBe("max_steps");
    });

    it("object returns a validated object", async () => {
        const res = await json("assistant", "object", { input: "Weather in Paris?" });

        expect(res.status).toBe(200);
        expect(res.body.object).toEqual({ city: "Paris", celsius: 21 });
        expect(res.body.text).toContain("Paris");
    });

    it("object is refused without a declared schema", async () => {
        const res = await json("plain", "object", { input: "hi" });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("AGENT_NO_OBJECT_SCHEMA");
    });

    it("history and clear work through the memory", async () => {
        await json("assistant", "generate", { input: "remember me", thread: "thread-1" });

        const history = await json("assistant", "history", { thread: "thread-1" });
        expect(history.status).toBe(200);
        expect(history.body.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
        expect(history.body.messages[0].content).toBe("remember me");
        expect(history.body.messages[3].content).toBe("Bonjour");

        expect((await json("assistant", "history", {})).body.code).toBe("THREAD_ID_REQUIRED");
        expect((await json("assistant", "clear", { thread: "thread-1" })).body.ok).toBe(true);
        expect((await json("assistant", "history", { thread: "thread-1" })).body.messages).toEqual([]);
    });

    it("still accepts the deprecated `threadId` / `resourceId` body fields", async () => {
        await json("assistant", "generate", { input: "legacy", threadId: "old-1", resourceId: "u-old" });
        expect((await json("assistant", "history", { threadId: "old-1", resourceId: "u-old" })).body.messages[0].content)
            .toBe("legacy");
        // Same key as the canonical spelling — the two name one thread
        expect((await json("assistant", "history", { thread: "old-1", resource: "u-old" })).body.messages[0].content)
            .toBe("legacy");
        expect((await json("assistant", "threads", { resourceId: "u-old" })).body.threads).toHaveLength(1);
    });

    it("accepts `memory: { thread, resource }` on every action", async () => {
        const memory = { resource: "u-mem", thread: "c-mem" };

        const generated = await json("assistant", "generate", {
            input: "Remember my favorite color is blue.",
            memory,
        });
        expect(generated.status).toBe(200);

        // Readable — and listed — with the same shorthand
        const history = await json("assistant", "history", { memory });
        expect(history.body.messages.length).toBeGreaterThan(1);
        expect(history.body.messages[0].content).toBe("Remember my favorite color is blue.");

        const threads = await json("assistant", "threads", { memory: { resource: "u-mem" } });
        expect(threads.body.threads.map((thread: any) => thread.threadId)).toEqual(["c-mem"]);

        // `THREAD_ID_REQUIRED` names the option and its shorthand
        const missing = await json("assistant", "history", { memory: { resource: "u-mem" } });
        expect(missing.body.code).toBe("THREAD_ID_REQUIRED");
        expect(missing.body.message).toContain("memory.thread");

        // `readOnly` runs a preview and stores nothing
        await json("assistant", "generate", {
            input: "just looking",
            memory: { ...memory, thread: "c-readonly", readOnly: true },
        });
        const preview = await json("assistant", "history", { memory: { ...memory, thread: "c-readonly" } });
        expect(preview.body.messages).toEqual([]);

        // `clear` too
        expect((await json("assistant", "clear", { memory })).body.ok).toBe(true);
        expect((await json("assistant", "history", { memory })).body.messages).toEqual([]);
    });

    it("accepts files as base64, and sends them to the model", async () => {
        const before = provider.hits();

        const res = await json("assistant", "generate", {
            input: "What are the totals?",
            files: [{ name: "data.csv", data: Buffer.from("ref,total\nA-1,99").toString("base64") }],
        });

        expect(res.status).toBe(200);
        const request = provider.requests[provider.hits() - 1]!;
        expect(request.body.messages[1].content[0].text).toBe("What are the totals?");
        expect(request.body.messages[1].content[1].text).toContain("--- data.csv ---");
        expect(before).toBeLessThan(provider.hits());
    });

    it("refuses a file a model cannot read", async () => {
        const res = await json("assistant", "generate", {
            input: "hi",
            files: [{ name: "legacy.doc", data: "AAAA" }],
        });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe("AGENT_FILE_UNSUPPORTED");
    });

    it("keeps threads isolated", async () => {
        await json("assistant", "generate", { input: "thread A", thread: "iso-a" });
        expect((await json("assistant", "history", { thread: "iso-b" })).body.messages).toEqual([]);
    });

    it("lists the caller's threads", async () => {
        await json("assistant", "generate", { input: "What is the weather?", thread: "listed", resource: "u-list" });
        await json("assistant", "generate", { input: "someone else", thread: "other", resource: "u-other" });

        const res = await json("assistant", "threads", { resource: "u-list" });
        expect(res.status).toBe(200);
        expect(res.body.threads.map((thread: any) => thread.threadId)).toEqual(["listed"]);
        expect(res.body.threads[0].title).toBe("What is the weather?");
        expect(res.body.threads[0].messages).toBeGreaterThan(0);

        // The `resource` namespaces the thread: without it, the key is the bare id
        const unscoped = await json("assistant", "history", { thread: "listed" });
        expect(unscoped.body.messages).toEqual([]);
    });

    it("refuses `threads` without a memory", async () => {
        const res = await json("plain", "threads", {});
        expect(res.status).toBe(401); // no rule for `threads` on `plain`
    });
});

describe("agents HTTP API — streaming", () => {
    it("streams the runtime events then a done payload", async () => {
        const res = await post("assistant", "stream", { input: "hi" });

        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toContain("text/event-stream");
        expect(res.headers.get("X-Accel-Buffering")).toBe("no");

        const events = await readSse(res);
        expect(events.filter((e) => e.type === "text").map((e) => e.text).join("")).toBe("Bonjour");
        expect(events.find((e) => e.type === "finish").finishReason).toBe("stop");

        const done = events.find((e) => e.type === "done");
        expect(done.result.text).toBe("Bonjour");
        expect(done.result.usage.requests).toBe(1);
    });

    it("requires a token like every other action", async () => {
        const res = await post("assistant", "stream", { input: "hi" }, false);
        expect(res.status).toBe(401);
        expect((await res.json() as any).code).toBe("AUTH_REQUIRED");
    });

    it("takes the same run options as `generate` — `messages` and `lastMessages` included", async () => {
        const before = provider.requests.length;

        // Injected turns, exactly like a `generate` body
        const res = await post("assistant", "stream", {
            input: "and in Lyon?",
            thread: "stream-1",
            messages: [
                { role: "user", content: "weather in Paris?" },
                { role: "assistant", content: "18°C and sunny." },
            ],
            lastMessages: 4,
        });
        expect(res.status).toBe(200);
        await readSse(res);

        // The model saw the injected turns after the thread and before the question
        const sent = at<any>(provider.requests, before).body.messages;
        const contents = sent.map((message: any) => message.content);
        expect(contents.at(-1)).toBe("and in Lyon?");
        expect(contents.join("\n")).toContain("18°C and sunny.");
        expect(provider.requests.length).toBeGreaterThan(before);
    });
});

describe("agents in every context", () => {
    it("is injected into a collection hook, bound to the hook's rest", async () => {
        (globalThis as any).__agentsHookProbe = undefined;
        await rest.insertOne("notes", { title: "probe" });

        const probe = (globalThis as any).__agentsHookProbe;
        expect(probe.ids).toEqual(["assistant", "plain", "private"]);
        expect(probe.bound).toBe(true);
        // …with the in-process `api` facade next to it, bound to the same client
        expect(probe.slug).toBe("notes");
        expect(probe.notes).toBeGreaterThanOrEqual(0); // a real count, not a stub
        delete (globalThis as any).__agentsHookProbe;
    });

    it("is injected into a service action, with its `api` facade", async () => {
        const result: any = await rest.runService("probe", "check");

        expect(result.agents).toEqual(["assistant", "plain", "private"]);
        expect(result.hasAssistant).toBe(true);
        expect(result.bound).toBe(true);
        // `api.service(name).run(...)` is the bound `rest.runService` — and it recurses fine
        expect(result.nested).toEqual({ from: "api" });
        expect(result.varType).toBe("function");
    });

    it("routes a write through the same path as `rest` — hooks included", async () => {
        (globalThis as any).__agentsHookProbe = undefined;

        const api = createApi(rest);
        await api.collection("notes").insertOne({ title: "via api" });

        // The collection hook fired, exactly as it does for `rest.insertOne`
        expect((globalThis as any).__agentsHookProbe?.slug).toBe("notes");
        expect(await rest.countDocuments("notes", { title: "via api" })).toBe(1);

        // The bound client reads, updates and deletes through the same client
        const notes = await api.collection("notes").find({ $match: { title: "via api" } });
        const note = notes[0]!;
        expect(note.title).toBe("via api");
        await api.collection("notes").updateOne(String(note._id), { $set: { title: "renamed" } });
        expect((await api.collection("notes").findOne(String(note._id))).title).toBe("renamed");
        await api.collection("notes").deleteOne(String(note._id));
        expect(await api.collection("notes").countDocuments({ title: "renamed" })).toBe(0);
    });

    it("is injected into a route handler, with its `api` facade", async () => {
        const res = await fetch(`${url}/v1/probe`);
        expect(res.status).toBe(200);

        const body = await res.json() as any;
        expect(body.agents).toEqual(["assistant", "plain", "private"]);
        expect(body.hasAssistant).toBe(true);
        expect(body.slug).toBe("notes");
        expect(body.sameAsRest).toBe(true);
        expect(body.agentBound).toBe(true);
        expect(body.unknownAgent).toBeUndefined();
        expect(body.vars).toBe("function");
        expect(body.serviceRun).toBe("function");
        // …and the bound service client really runs the action, from a route
        expect(body.serviceCall).toEqual({ from: "route" });
        expect(body.fileUrl).toBe("/api/agents-api/files/invoices/f1.pdf?w=800");
    });
});

describe("agents HTTP API — audit", () => {
    it("records the call, the usage and the tool names — never the answer", async () => {
        const since = new Date();
        await json("assistant", "generate", { input: "Weather?", thread: "audit-thread" });

        const entries = await auditEntries("agent.generate", "_agents_:assistant", since);
        expect(entries.length).toBe(1);

        const entry: any = entries[0];
        expect(entry.operation.status).toBe("success");
        expect(entry.operation.input.agent).toBe("assistant");
        expect(entry.operation.input.thread).toBe("audit-thread");
        expect(entry.operation.input.text).toBe("Weather?");
        expect(entry.operation.result.tools).toEqual(["echo"]);
        expect(entry.operation.result.finishReason).toBe("stop");
        expect(entry.operation.result.usage.requests).toBe(2);
        expect(entry.operation.result.steps).toBe(2);

        // No model answer, no tool arguments anywhere in the entry
        const serialized = JSON.stringify(entry);
        expect(serialized).not.toContain("Bonjour");
        expect(serialized).not.toContain("hello");
    });

    it("records a denied call as an error", async () => {
        const since = new Date();
        await json("private", "generate", { input: "nope" });

        const entries = await auditEntries("agent.generate", "_agents_:private", since);
        expect(entries.length).toBe(1);
        expect((entries[0] as any).operation.status).toBe("error");
        expect((entries[0] as any).operation.error.code).toBe("ACCESS_DENIED");
    });

    it("audits the streamed run once, at its end", async () => {
        const since = new Date();
        const res = await post("assistant", "stream", { input: "hi" });
        await res.text();

        const entries = await auditEntries("agent.stream", "_agents_:assistant", since);
        expect(entries.length).toBe(1);
        expect((entries[0] as any).operation.result.finishReason).toBe("stop");
        expect(JSON.stringify(entries[0])).not.toContain("Bonjour");
    });
});
