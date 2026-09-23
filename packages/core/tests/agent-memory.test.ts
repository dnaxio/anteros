import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Agent } from "../lib/agent";
import { InMemoryAgentMemory, MongoAgentMemory, RedisAgentMemory } from "../lib/agentMemory";
import { replicatesCollection, replicatesMetaCollection } from "../database/deleteLog";
import { formatConfig, cfg } from "../server/config";
import { syncTenants } from "../database/tenant";
import { useRest } from "../database/rest";
import { fakeProvider, openaiText, at, type Fake } from "./fixtures/fake-provider";
import type { AgentMessage } from "../types/agent";

/**
 * Conversation stores — `agents.memory.InMemory` (a Map) and
 * `agents.memory.Mongo` (durable, one document per thread in a collection **the tenant names**).
 */

const TENANT = "agent-memory";
const DB = "mongodb://localhost:27017/_AGENT_MEMORY_TEST";
/** The collection the tenant chose for its agent threads. */
const MEMORY = "_memories_test_";

let rest: InstanceType<typeof useRest>;
let provider: Fake;

const message = (role: string, content: string): AgentMessage => ({ role, content } as AgentMessage);

beforeAll(async () => {
    formatConfig({
        server: { port: 4000 },
        tenants: [{ id: TENANT, dir: "packages/core/tests/fixtures/agent-tenant", database: { uri: DB } }],
    });
    await syncTenants();
    rest = new useRest({ internal: true, tenant_id: TENANT });
    // The agent loader publishes the memory collections it found — here, none:
    // the tests declare the one they use, like `syncAgents()` would.
    cfg.agentMemories = [{ _tenant_: TENANT, collection: MEMORY }];
    provider = fakeProvider(() => openaiText("ok"));
});

afterAll(async () => {
    try { await rest.db.dropDatabase(); } catch (_) { /* already gone */ }
    try { provider.stop(); } catch (_) { /* already stopped */ }
    cfg.tenants = [];
});

// ─── In-memory ───────────────────────────────────────────────────────────

describe("agents.memory.InMemory", () => {
    it("round-trips a thread and returns copies", () => {
        const memory = new InMemoryAgentMemory();
        memory.save("t1", [message("user", "hi"), message("assistant", "hello")]);

        const read = memory.get("t1");
        expect(read.map((m) => m.content)).toEqual(["hi", "hello"]);

        read[0]!.content = "mutated";
        expect(memory.get("t1")[0]!.content).toBe("hi");
        expect(memory.get("missing")).toEqual([]);
    });

    it("bounds a thread, keeping the opening system message", () => {
        const memory = new InMemoryAgentMemory({ maxMessages: 3 });
        memory.save("t1", [
            message("system", "persona"),
            message("user", "1"),
            message("assistant", "2"),
            message("user", "3"),
            message("assistant", "4"),
        ]);

        expect(memory.get("t1").map((m) => m.content)).toEqual(["persona", "3", "4"]);
    });

    it("namespaces threads per caller by default", () => {
        const memory = new InMemoryAgentMemory();
        memory.save("same", [message("user", "from A")], { resourceId: "A" });
        memory.save("same", [message("user", "from B")], { resourceId: "B" });

        expect(memory.get("same", { resourceId: "A" })[0]!.content).toBe("from A");
        expect(memory.get("same", { resourceId: "B" })[0]!.content).toBe("from B");
        expect(memory.threads()).toEqual(["A:same", "B:same"]);

        // …unless the store is unscoped
        const shared = new InMemoryAgentMemory({ scoped: false });
        shared.save("same", [message("user", "A")], { resourceId: "A" });
        shared.save("same", [message("user", "B")], { resourceId: "B" });
        expect(shared.get("same", { resourceId: "A" })[0]!.content).toBe("B");
    });

    it("lists a caller's threads, most recent first", async () => {
        const memory = new InMemoryAgentMemory();
        memory.save("older", [message("user", "What is the weather in Paris?")], { resourceId: "A" });
        await Bun.sleep(2);
        memory.save("newer", [message("user", "hi")], { resourceId: "A" });
        memory.save("other", [message("user", "elsewhere")], { resourceId: "B" });

        const threads = await memory.list({ resourceId: "A" });
        expect(threads.map((t) => t.threadId)).toEqual(["newer", "older"]);
        expect(threads[1]!.title).toBe("What is the weather in Paris?");
        expect(threads[1]!.messages).toBe(1);
        expect(threads.every((t) => t.updatedAt instanceof Date)).toBe(true);

        expect((await memory.list({ limit: 1 })).length).toBe(1);
    });

    it("clears a thread", () => {
        const memory = new InMemoryAgentMemory();
        memory.save("t1", [message("user", "hi")]);
        memory.clear("t1");
        expect(memory.get("t1")).toEqual([]);
    });
});

// ─── MongoDB ─────────────────────────────────────────────────────────────

describe("agents.memory.Mongo", () => {
    it("round-trips a thread in the tenant database", async () => {
        const memory = new MongoAgentMemory({ collection: MEMORY });
        await memory.save("t1", [message("user", "hi"), message("assistant", "hello")], { rest, resourceId: "u1" });

        expect((await memory.get("t1", { rest, resourceId: "u1" })).map((m) => m.content)).toEqual(["hi", "hello"]);
        expect(await memory.get("t1", { rest, resourceId: "u2" })).toEqual([]);
        expect(await memory.get("missing", { rest, resourceId: "u1" })).toEqual([]);

        const doc: any = await rest.db.collection(MEMORY).findOne({ _id: "u1:t1" as any });
        expect(doc.threadId).toBe("t1");
        expect(doc.resourceId).toBe("u1");
        expect(doc.title).toBe("hi");
        expect(doc.createdAt).toBeInstanceOf(Date);
        expect(doc.updatedAt).toBeInstanceOf(Date);

        await memory.clear("t1", { rest, resourceId: "u1" });
        expect(await memory.get("t1", { rest, resourceId: "u1" })).toEqual([]);
    });

    it("upserts one document per thread and keeps the original title", async () => {
        const memory = new MongoAgentMemory({ collection: MEMORY });
        await memory.save("t2", [message("user", "first question")], { rest, resourceId: "u1" });
        await memory.save("t2", [message("user", "first question"), message("assistant", "answer")], { rest, resourceId: "u1" });

        const docs = await rest.db.collection(MEMORY).find({ threadId: "t2" }).toArray();
        expect(docs.length).toBe(1);
        expect((docs[0] as any).messages.length).toBe(2);
        expect((docs[0] as any).title).toBe("first question");
    });

    it("bounds the stored conversation", async () => {
        const memory = new MongoAgentMemory({ collection: MEMORY, maxMessages: 3 });
        await memory.save("t3", [
            message("system", "persona"),
            message("user", "1"),
            message("assistant", "2"),
            message("user", "3"),
            message("assistant", "4"),
        ], { rest, resourceId: "u1" });

        expect((await memory.get("t3", { rest, resourceId: "u1" })).map((m) => m.content))
            .toEqual(["persona", "3", "4"]);
    });

    it("lists a caller's threads, most recent first", async () => {
        const memory = new MongoAgentMemory({ collection: MEMORY });
        await memory.save("older", [message("user", "hello")], { rest, resourceId: "lister" });
        await Bun.sleep(5);
        await memory.save("newer", [message("user", "hi")], { rest, resourceId: "lister" });
        await memory.save("other", [message("user", "hi")], { rest, resourceId: "someone-else" });

        const threads = await memory.list({ rest, resourceId: "lister" });
        expect(threads.map((t) => t.threadId)).toEqual(["newer", "older"]);
        expect(threads[0]!.messages).toBe(1);
        expect(threads.every((t) => t.resourceId === "lister")).toBe(true);

        expect((await memory.list({ rest, resourceId: "lister", limit: 1 })).length).toBe(1);
    });

    it("creates its indexes on first use — and never at boot", async () => {
        const memory = new MongoAgentMemory({ collection: MEMORY });
        const collection = `_memories_idx_${crypto.randomUUID().slice(0, 8)}_`;
        const scoped = new MongoAgentMemory({ collection });

        const before = await rest.db.listCollections({ name: collection }).toArray();
        expect(before.length).toBe(0);

        await scoped.save("t", [message("user", "hi")], { rest, resourceId: "e2e" });

        const indexes: any[] = await rest.db.collection(collection).listIndexes().toArray();
        const listIndex = indexes.find((index) => index.key?.resourceId === 1);
        expect(listIndex).toBeDefined();
        expect(listIndex.key.updatedAt).toBe(-1);
        expect(listIndex.background).toBe(true);

        // No TTL unless asked for
        expect(indexes.some((index) => index.expireAfterSeconds !== undefined)).toBe(false);
        await rest.db.dropCollection(collection);
    });

    it("applies the retention only when a TTL is configured", async () => {
        const collection = `_memories_ttl_${crypto.randomUUID().slice(0, 8)}_`;
        const memory = new MongoAgentMemory({ collection, ttl: "30d" });

        await memory.save("t", [message("user", "hi")], { rest, resourceId: "e2e" });

        const ttl: any = (await rest.db.collection(collection).listIndexes().toArray())
            .find((index: any) => index.expireAfterSeconds !== undefined);
        expect(ttl.key).toEqual({ updatedAt: 1 });
        expect(ttl.expireAfterSeconds).toBe(30 * 86400);

        await rest.db.dropCollection(collection);
    });

    it("keeps the working memory in a derived collection, and publishes both", async () => {
        const memory = new MongoAgentMemory({ collection: MEMORY });

        // The replication engine copies what `collections()` lists — state included
        expect(memory.stateCollection).toBe(`${MEMORY}__state`);
        expect(memory.collections()).toEqual([MEMORY, `${MEMORY}__state`]);

        await memory.setState("resource:u1", { value: { name: "Sam" } }, { rest });
        expect(await memory.getState("resource:u1", { rest })).toMatchObject({ value: { name: "Sam" } });
        expect(await memory.getState("resource:u2", { rest })).toBeUndefined();

        // One document per scope key, updated in place
        await memory.setState("resource:u1", { value: { name: "Sam", plan: "pro" } }, { rest });
        expect((await rest.db.collection(`${MEMORY}__state`).countDocuments()).valueOf()).toBe(1);
        expect((await memory.getState("resource:u1", { rest }))?.value.plan).toBe("pro");

        await memory.clearState("resource:u1", { rest });
        expect(await memory.getState("resource:u1", { rest })).toBeUndefined();
    });

    it("refuses to work without a `rest`", async () => {
        const memory = new MongoAgentMemory({ collection: MEMORY });
        await expect(memory.get("t", {})).rejects.toMatchObject({ code: "AGENT_MEMORY_NO_REST" });
        await expect(memory.save("t", [], {})).rejects.toMatchObject({ code: "AGENT_MEMORY_NO_REST" });
    });
});

// ─── Delete propagation ─────────────────────────────────�───────────────────

const tenantConfig = () => (cfg.tenants ?? []).find((t) => t.id === TENANT) as any;
const markersFor = (docId: string) => rest.db.collection("_replication_").countDocuments({
    type: "delete", collection: MEMORY, docId,
});

describe("replicatesCollection / replicatesMetaCollection", () => {
    it("follows enabled, destinations and exclude", () => {
        // Nothing configured
        expect(replicatesCollection(TENANT, MEMORY)).toBe(false);
        expect(replicatesMetaCollection(TENANT, "memory")).toBe(false);
        expect(replicatesMetaCollection("unknown", "memory")).toBe(false);

        tenantConfig().replication = { enabled: false, destinations: [{ id: "b", uri: "mongodb://localhost:27017/x" }] };
        expect(replicatesCollection(TENANT, MEMORY)).toBe(false);

        tenantConfig().replication = { destinations: [] };
        expect(replicatesCollection(TENANT, MEMORY)).toBe(false);

        tenantConfig().replication = { destinations: [{ id: "b", uri: "mongodb://localhost:27017/x" }] };
        // The published memory collection is replicated — by its own slug, under the `memory` name
        expect(replicatesCollection(TENANT, MEMORY)).toBe(true);
        expect(replicatesMetaCollection(TENANT, "memory")).toBe(true);
        expect(replicatesMetaCollection(TENANT, "audit")).toBe(true);
        expect(replicatesCollection(TENANT, "_audit_")).toBe(true);
        expect(replicatesCollection(TENANT, "_vars_")).toBe(true);
        // A collection nobody knows (not declared, not opted in) is not replicated
        expect(replicatesCollection(TENANT, "whatever")).toBe(false);

        tenantConfig().replication.exclude = ["memory"];
        expect(replicatesCollection(TENANT, MEMORY)).toBe(false);
        expect(replicatesMetaCollection(TENANT, "memory")).toBe(false);
        expect(replicatesMetaCollection(TENANT, "audit")).toBe(true);
        expect(replicatesCollection(TENANT, "_audit_")).toBe(true);

        delete tenantConfig().replication;
    });
});

describe("agents.memory.Mongo — delete propagation", () => {
    const replicated = { destinations: [{ id: "backup", uri: "mongodb://localhost:27017/_AGENT_MEMORY_DEST" }] };

    it("writes a tombstone for a cleared thread so the deletion reaches the destinations", async () => {
        tenantConfig().replication = { ...replicated };
        try {
            const memory = new MongoAgentMemory({ collection: MEMORY });
            await memory.save("gone", [message("user", "hi")], { rest, tenant: TENANT, resourceId: "u1" });
            await memory.clear("gone", { rest, tenant: TENANT, resourceId: "u1" });

            const marker: any = await rest.db.collection("_replication_").findOne({
                type: "delete", collection: MEMORY, docId: "u1:gone",
            });
            expect(marker).toBeDefined();
            expect(marker.tenant).toBe(TENANT);
            expect(marker.synced).toEqual([]);
        } finally {
            delete tenantConfig().replication;
        }
    });

    it("writes none when nobody replicates, when `memory` is excluded, or for a custom collection", async () => {
        const memory = new MongoAgentMemory({ collection: MEMORY });

        // Nothing configured
        await memory.save("a", [message("user", "hi")], { rest, tenant: TENANT, resourceId: "u1" });
        await memory.clear("a", { rest, tenant: TENANT, resourceId: "u1" });
        expect(await markersFor("u1:a")).toBe(0);

        // Replicated, but `_memories_` is excluded — a tombstone could never be flushed
        tenantConfig().replication = { ...replicated, exclude: ["memory"] };
        try {
            await memory.save("b", [message("user", "hi")], { rest, tenant: TENANT, resourceId: "u1" });
            await memory.clear("b", { rest, tenant: TENANT, resourceId: "u1" });
            expect(await markersFor("u1:b")).toBe(0);
        } finally {
            delete tenantConfig().replication;
        }

        // A custom collection is the tenant's business, not the framework's
        tenantConfig().replication = { ...replicated };
        try {
            const custom = new MongoAgentMemory({ collection: `_memories_custom_${crypto.randomUUID().slice(0, 6)}_` });
            await custom.save("c", [message("user", "hi")], { rest, tenant: TENANT, resourceId: "u1" });
            await custom.clear("c", { rest, tenant: TENANT, resourceId: "u1" });
            expect(await markersFor("u1:c")).toBe(0);
            await rest.db.dropCollection(custom.collection);
        } finally {
            delete tenantConfig().replication;
        }
    });
});

// ─── Wired into an agent ────────────────────────────────�───────────────────

describe("agent memory — end to end", () => {
    it("replays the thread stored in Mongo, and exposes it to the caller", async () => {
        const memory = new MongoAgentMemory({ collection: MEMORY, maxMessages: 50 });
        const agent = new Agent({
            id: "memo",
            description: "A test agent.",
            instructions: "You are a test agent.",
            provider: { model: "test-model", apiKey: "test-key", compatible: "openai", baseUrl: provider.url, options: { retries: 0 } },
            memory,
        } as any);
        agent.setRest(rest);

        await agent.generate("first", { thread: "chat-1", resource: "e2e" });
        await agent.generate("second", { thread: "chat-1", resource: "e2e" });

        // The second run replayed the first exchange
        const second = provider.requests[1]!.body.messages;
        expect(second.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "user"]);
        expect(second[1].content).toBe("first");
        expect(second[2].content).toBe("ok");
        expect(second[3].content).toBe("second");

        // The caller can read it back — and list its threads
        expect((await agent.getMessages("chat-1", { resource: "e2e" })).map((m) => m.role))
            .toEqual(["user", "assistant", "user", "assistant"]);

        const threads = await agent.listThreads({ resource: "e2e" });
        expect(threads.map((t) => t.threadId)).toEqual(["chat-1"]);
        expect(threads[0]!.title).toBe("first");

        // Another caller sees nothing
        expect(await agent.getMessages("chat-1", { resource: "u2" })).toEqual([]);

        await agent.clearMessages("chat-1", { resource: "e2e" });
        expect(await agent.listThreads({ resource: "e2e" })).toEqual([]);
    });

    it("accepts the `memory: { resource, thread }` shorthand", async () => {
        const agent = new Agent({
            id: "shorthand",
            description: "A test agent.",
            instructions: "You are a test agent.",
            provider: { model: "test-model", apiKey: "test-key", compatible: "openai", baseUrl: provider.url, options: { retries: 0 } },
            memory: new MongoAgentMemory({ collection: MEMORY }),
        } as any);
        agent.setRest(rest);

        const memory = { resource: "u-short", thread: "c-short" };
        await agent.generate("Remember my favorite color is blue.", { memory });
        await agent.generate("What is my favorite color?", { memory });

        // The second run replayed the first exchange
        const second = at(provider.requests, provider.requests.length - 1).body.messages;
        expect(second.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "user"]);
        expect(second[1].content).toBe("Remember my favorite color is blue.");

        // Stored under `resource:thread`, readable with either spelling
        expect((await agent.getMessages("c-short", { resource: "u-short" })).length).toBe(4);
        expect((await agent.getMessages("c-short", { resourceId: "u-short" })).length).toBe(4);
        expect(await agent.getMessages("c-short")).toEqual([]); // no caller → another namespace
        expect((await agent.listThreads({ resource: "u-short" })).map((t) => t.threadId)).toEqual(["c-short"]);
    });

    it("writes nothing back when the run is readOnly", async () => {
        const agent = new Agent({
            id: "preview",
            description: "A test agent.",
            instructions: "You are a test agent.",
            provider: { model: "test-model", apiKey: "test-key", compatible: "openai", baseUrl: provider.url, options: { retries: 0 } },
            memory: new MongoAgentMemory({ collection: MEMORY }),
        } as any);
        agent.setRest(rest);

        const { text } = await agent.generate("just looking", {
            memory: { resource: "u-ro", thread: "c-ro", readOnly: true },
        });

        expect(text).toBe("ok");
        expect(await agent.getMessages("c-ro", { resource: "u-ro" })).toEqual([]);
        expect(await agent.listThreads({ resource: "u-ro" })).toEqual([]);
    });

    it("reports no thread list for a store that does not support it", async () => {
        const agent = new Agent({
            id: "plain",
            description: "x",
            instructions: "x",
            provider: { model: "m", compatible: "openai", apiKey: "k" },
        } as any);
        expect(await agent.listThreads()).toEqual([]);

        const minimal = new Agent({
            id: "minimal",
            description: "x",
            instructions: "x",
            provider: { model: "m", compatible: "openai", apiKey: "k" },
            // A custom store only has to implement get / save / clear
            memory: { get: () => [], save: () => { }, clear: () => { } },
        } as any);
        expect(await minimal.listThreads()).toEqual([]);
    });
});

// ─── Redis ─────────────────────────────────────────────────────────────

/** A structural stand-in for ioredis — the store only uses these commands. */
function mockRedis() {
    const values = new Map<string, string>();
    const expiries = new Map<string, number>();
    const sets = new Map<string, Map<string, number>>();
    return {
        values, expiries, sets,
        get: async (key: string) => values.get(key) ?? null,
        set: async (key: string, value: string, ...args: any[]) => {
            values.set(key, value);
            if (args[0] === "EX") expiries.set(key, Number(args[1]));
            return "OK";
        },
        del: async (...keys: string[]) => keys.reduce((count, key) => count + (values.delete(key) ? 1 : 0), 0),
        mget: async (...keys: string[]) => keys.map((key) => values.get(key) ?? null),
        expire: async (key: string, seconds: number) => { expiries.set(key, seconds); return 1; },
        zadd: async (key: string, score: number, member: string) => {
            const set = sets.get(key) ?? new Map<string, number>();
            const added = set.has(member) ? 0 : 1;
            set.set(member, score);
            sets.set(key, set);
            return added;
        },
        zrevrange: async (key: string, start: number, stop: number) =>
            [...(sets.get(key) ?? new Map<string, number>())]
                .sort((a, b) => b[1] - a[1])
                .slice(start, stop + 1)
                .map(([member]) => member),
        zrem: async (key: string, ...members: string[]) => {
            const set = sets.get(key);
            return members.reduce((count, member) => count + (set?.delete(member) ? 1 : 0), 0);
        },
    };
}

const REDIS_CTX = { tenant: "v1", resourceId: "u1", agentId: "support" };
const threadKeyOf = (threadId: string) => `anteros:agent-memory:v1:thread:u1:${threadId}`;
const indexKey = "anteros:agent-memory:v1:resource:u1";

describe("agents.memory.Redis", () => {
    it("round-trips a thread, namespaced by tenant and caller", async () => {
        const client = mockRedis();
        const memory = new RedisAgentMemory({ client });

        await memory.save("chat-1", [message("user", "hi"), message("assistant", "hello")], REDIS_CTX);

        expect((await memory.get("chat-1", REDIS_CTX)).map((m) => m.content)).toEqual(["hi", "hello"]);
        // Another caller — and another tenant — see nothing
        expect(await memory.get("chat-1", { ...REDIS_CTX, resourceId: "u2" })).toEqual([]);
        expect(await memory.get("chat-1", { ...REDIS_CTX, tenant: "v2" })).toEqual([]);

        const payload = JSON.parse(client.values.get(threadKeyOf("chat-1"))!);
        expect(payload.title).toBe("hi");
        expect(payload.resourceId).toBe("u1");
        expect(payload.agentId).toBe("support");
        expect(payload.messages).toHaveLength(2);
    });

    it("refuses to run without a tenant", async () => {
        const memory = new RedisAgentMemory({ client: mockRedis() });
        await expect(memory.get("t", {})).rejects.toMatchObject({ code: "AGENT_MEMORY_NO_TENANT" });
        await expect(memory.save("t", [], {})).rejects.toMatchObject({ code: "AGENT_MEMORY_NO_TENANT" });
    });

    it("keeps the title and createdAt of the first exchange", async () => {
        const client = mockRedis();
        const memory = new RedisAgentMemory({ client });

        await memory.save("t", [message("user", "first question")], REDIS_CTX);
        const created = JSON.parse(client.values.get(threadKeyOf("t"))!).createdAt;

        await Bun.sleep(3);
        await memory.save("t", [message("user", "first question"), message("assistant", "answer")], REDIS_CTX);

        const payload = JSON.parse(client.values.get(threadKeyOf("t"))!);
        expect(payload.title).toBe("first question");
        expect(payload.createdAt).toBe(created);
        expect(payload.messages).toHaveLength(2);
    });

    it("bounds the conversation", async () => {
        const memory = new RedisAgentMemory({ client: mockRedis(), maxMessages: 3 });
        await memory.save("t", [
            message("system", "persona"),
            message("user", "1"),
            message("assistant", "2"),
            message("user", "3"),
            message("assistant", "4"),
        ], REDIS_CTX);

        expect((await memory.get("t", REDIS_CTX)).map((m) => m.content)).toEqual(["persona", "3", "4"]);
    });

    it("applies the ttl to the thread and to the caller index", async () => {
        const client = mockRedis();
        const memory = new RedisAgentMemory({ client, ttl: "1h" });
        await memory.save("t", [message("user", "hi")], REDIS_CTX);

        expect(client.expiries.get(threadKeyOf("t"))).toBe(3600);
        expect(client.expiries.get(indexKey)).toBe(3600);
    });

    it("rejects an invalid ttl", async () => {
        const memory = new RedisAgentMemory({ client: mockRedis(), ttl: "soon" });
        await expect(memory.save("t", [], REDIS_CTX)).rejects.toMatchObject({ code: "AGENT_MEMORY_INVALID_TTL" });
    });

    it("lists a caller's threads, most recent first, and prunes the expired ones", async () => {
        const client = mockRedis();
        const memory = new RedisAgentMemory({ client });

        await memory.save("older", [message("user", "What is the weather?")], REDIS_CTX);
        await Bun.sleep(3);
        await memory.save("newer", [message("user", "hi")], REDIS_CTX);
        await memory.save("elsewhere", [message("user", "hi")], { ...REDIS_CTX, resourceId: "u2" });

        const threads = await memory.list({ tenant: "v1", resourceId: "u1" });
        expect(threads.map((t) => t.threadId)).toEqual(["newer", "older"]);
        expect(threads[1]!.title).toBe("What is the weather?");
        expect(threads[1]!.messages).toBe(1);
        expect(threads[0]!.updatedAt).toBeInstanceOf(Date);

        // A thread that expired behind the index is dropped on read
        client.values.delete(threadKeyOf("older"));
        expect((await memory.list({ tenant: "v1", resourceId: "u1" })).map((t) => t.threadId)).toEqual(["newer"]);
        expect(client.sets.get(indexKey)!.has("u1:older")).toBe(false);
    });

    it("clears the thread and its index entry", async () => {
        const client = mockRedis();
        const memory = new RedisAgentMemory({ client });

        await memory.save("t", [message("user", "hi")], REDIS_CTX);
        await memory.clear("t", REDIS_CTX);

        expect(await memory.get("t", REDIS_CTX)).toEqual([]);
        expect(client.sets.get(indexKey)!.has("u1:t")).toBe(false);
        expect(await memory.list({ tenant: "v1", resourceId: "u1" })).toEqual([]);
    });

    it("shares one thread across callers when `scoped` is off", async () => {
        const client = mockRedis();
        const memory = new RedisAgentMemory({ client, scoped: false });

        await memory.save("shared", [message("user", "from A")], { tenant: "v1", resourceId: "A" });
        await memory.save("shared", [message("user", "from B")], { tenant: "v1", resourceId: "B" });

        expect((await memory.get("shared", { tenant: "v1", resourceId: "A" }))[0]!.content).toBe("from B");
        expect(client.values.has("anteros:agent-memory:v1:thread:shared")).toBe(true);
    });

    it("reads a corrupted entry as an empty thread", async () => {
        const client = mockRedis();
        const memory = new RedisAgentMemory({ client });
        client.values.set(threadKeyOf("broken"), "not json");

        expect(await memory.get("broken", REDIS_CTX)).toEqual([]);
    });

    it("replays a Redis thread through a real agent, and lists it", async () => {
        const client = mockRedis();
        const agent = new Agent({
            id: "redis-agent",
            description: "A test agent.",
            instructions: "You are a test agent.",
            provider: { model: "test-model", apiKey: "test-key", compatible: "openai", baseUrl: provider.url, options: { retries: 0 } },
            memory: new RedisAgentMemory({ client }),
        } as any);
        agent._tenant_ = "v1";
        agent.setRest(rest);

        await agent.generate("first", { thread: "c1", resource: "u1" });
        await agent.generate("second", { thread: "c1", resource: "u1" });

        const last = at(provider.requests, provider.requests.length - 1).body.messages;
        expect(last.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "user"]);
        expect(last[1].content).toBe("first");

        expect((await agent.listThreads({ resource: "u1" })).map((t) => t.threadId)).toEqual(["c1"]);
    });
});
