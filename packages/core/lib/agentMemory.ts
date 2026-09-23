import { AppError } from "./error";
import { parseDuration } from "../utils/func";
import { syncTtlRetention } from "../database/ttl";
import { writeDeleteMarkers, replicatesCollection } from "../database/deleteLog";
import { Redis } from "ioredis";
import type { Db } from "mongodb";
import type {
    AgentMemory,
    AgentMemoryContext,
    AgentMemoryOptions,
    AgentMemoryState,
    AgentMessage,
    AgentThread,
    MongoAgentMemoryOptions,
    RedisAgentMemoryOptions,
    RedisClientLike,
} from "../types/agent";

/**
 * Conversation stores — `agents.memory`.
 *
 * An agent with a `memory` reads its thread before a run and writes the updated
 * conversation after it. Three implementations ship with the framework:
 *
 * - **`agents.memory.InMemory`** — a `Map` in the process. Fine for a demo, a
 *   script or a single-process server; useless across processes.
 * - **`agents.memory.Mongo`** — one document per thread in a collection **you
 *   name** (`_memories_`, `support_threads`…). Durable, shared by every process,
 *   with a message cap, an optional TTL, a thread list, and replicated by the
 *   replication engine like a declared collection.
 * - **`agents.memory.Redis`** — one key per thread, shared by every process
 *   without MongoDB. Same options, plus a per-thread expiry.
 *
 * All three share the same policy: **a thread is bounded** (`maxMessages`, default
 * 100 — the oldest messages are dropped on save) and **namespaced per caller**
 * (`resourceId:threadId`, unless `scoped: false`).
 */

/** Default `maxMessages` — the cap is applied on every save. */
const DEFAULT_MAX_MESSAGES = 100;
const DEFAULT_LIST_LIMIT = 20;

/** Thread title derived from the first user message (the document's, set once). */
const TITLE_MAX = 80;

/**
 * The document key of a thread.
 *
 * With `scoped` (default) the caller identity prefixes the id, so two callers
 * using the same `threadId` never share a conversation. A missing `resourceId`
 * falls back to the bare id.
 */
function threadKey(threadId: string, ctx?: AgentMemoryContext, scoped = true): string {
    const resourceId = ctx?.resourceId;
    if (!scoped || !resourceId) return threadId;
    return `${resourceId}:${threadId}`;
}

/**
 * Keep the last `maxMessages` — the cap is a hard limit, and the opening
 * `system` (or `developer`) message, when there is one, takes one of the slots
 * instead of being the first casualty of a long conversation.
 */
function trimMessages(messages: AgentMessage[], maxMessages: number): AgentMessage[] {
    if (messages.length <= maxMessages) return messages;

    const opening = messages[0]?.role === "system" || messages[0]?.role === "developer" ? messages[0] : undefined;
    const budget = Math.max(0, maxMessages - (opening ? 1 : 0));
    const kept = budget === 0 ? [] : messages.slice(messages.length - budget);
    return opening ? [opening, ...kept] : kept;
}

function threadTitle(messages: AgentMessage[]): string | undefined {
    const first = messages.find((message) => message.role === "user");
    const text = typeof first?.content === "string"
        ? first.content
        : Array.isArray(first?.content)
            ? first.content.filter((part) => part.type === "text").map((part) => (part as any).text).join(" ")
            : "";
    const title = text.trim().replace(/\s+/g, " ");
    if (!title) return undefined;
    return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
}

function cloneMessages(messages: AgentMessage[]): AgentMessage[] {
    return messages.map((message) => ({ ...message }));
}

// ─── In-memory ──────────────────────────────────────────────────────────

/**
 * In-process conversation store — the default when an agent declares no
 * `memory`.
 *
 * ```ts
 * import { agents } from '@anteros/core'
 * const memory = new agents.memory.InMemory({ maxMessages: 40 })
 * ```
 *
 * One `Map` per process: in a multi-process deployment (`reusePort`, several
 * containers) each process has its own threads — use `agents.memory.Mongo()`
 * when a conversation must be shared.
 */
export class InMemoryAgentMemory implements AgentMemory {
    #threads = new Map<string, { messages: AgentMessage[]; title?: string; createdAt: Date; updatedAt: Date }>();
    #states = new Map<string, AgentMemoryState>();
    #maxMessages: number;
    #scoped: boolean;

    constructor(options: AgentMemoryOptions = {}) {
        this.#maxMessages = Math.max(1, options.maxMessages ?? DEFAULT_MAX_MESSAGES);
        this.#scoped = options.scoped ?? true;
    }

    get(threadId: string, ctx?: AgentMemoryContext): AgentMessage[] {
        const thread = this.#threads.get(threadKey(threadId, ctx, this.#scoped));
        return thread ? cloneMessages(thread.messages) : [];
    }

    save(threadId: string, messages: AgentMessage[], ctx?: AgentMemoryContext): void {
        const key = threadKey(threadId, ctx, this.#scoped);
        const existing = this.#threads.get(key);
        const trimmed = trimMessages(messages, this.#maxMessages);

        this.#threads.set(key, {
            messages: cloneMessages(trimmed),
            title: existing?.title ?? threadTitle(trimmed),
            createdAt: existing?.createdAt ?? new Date(),
            updatedAt: new Date(),
        });
    }

    clear(threadId: string, ctx?: AgentMemoryContext): void {
        this.#threads.delete(threadKey(threadId, ctx, this.#scoped));
    }

    list(ctx?: AgentMemoryContext & { limit?: number }): AgentThread[] {
        const prefix = this.#scoped && ctx?.resourceId ? `${ctx.resourceId}:` : "";
        return [...this.#threads.entries()]
            .filter(([key]) => (prefix ? key.startsWith(prefix) : true))
            .map(([key, thread]) => ({
                threadId: prefix ? key.slice(prefix.length) : key,
                resourceId: ctx?.resourceId,
                title: thread.title,
                messages: thread.messages.length,
                createdAt: thread.createdAt,
                updatedAt: thread.updatedAt,
            }))
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
            .slice(0, ctx?.limit ?? DEFAULT_LIST_LIMIT);
    }

    /** Thread keys currently held — debugging helper. */
    threads(): string[] {
        return [...this.#threads.keys()];
    }

    getState(key: string): AgentMemoryState | undefined {
        const state = this.#states.get(key);
        return state ? { ...state } : undefined;
    }

    setState(key: string, value: AgentMemoryState): void {
        this.#states.set(key, { ...value });
    }

    clearState(key: string): void {
        this.#states.delete(key);
    }
}

// ─── MongoDB ────────────────────────────────────────────────

/**
 * Durable conversation store — one document per thread in the tenant database.
 *
 * ```ts
 * export default define.Agent({
 *   // …
 *   memory: new agents.memory.Mongo({ collection: '_memories_', maxMessages: 60, ttl: '180d' }),
 * })
 * ```
 *
 * The **collection name is required**: the threads are your data, they live where
 * you decide, and the replication engine copies that collection like a declared
 * one (the loader publishes it — opt out of it with `replication.exclude: ['memory']`).
 *
 * Writes go through the **context's** `rest` (the tenant database), exactly like
 * a tool: register it in the definition and every tenant keeps its own threads.
 * The collection and its indexes are created on first use — never at boot.
 */
export class MongoAgentMemory implements AgentMemory {
    #options: MongoAgentMemoryOptions;
    #ready = new WeakMap<Db, Promise<void>>();

    constructor(options: MongoAgentMemoryOptions) {
        if (!options?.collection) {
            throw new AppError(
                "A Mongo memory store needs its `collection` — `new agents.memory.Mongo({ collection: '_memories_' })`",
                { status: 500, code: "AGENT_MEMORY_COLLECTION_REQUIRED" },
            );
        }
        this.#options = options;
    }

    /** Collection holding the threads, in the tenant database. */
    get collection(): string {
        return this.#options.collection;
    }

    /** The replication engine copies this collection — see `syncAgents()`. */
    collections(): string[] {
        return [this.#options.collection, this.stateCollection];
    }

    /**
     * Where the working memory lives: `${collection}__state`, derived so a tenant
     * names one collection and gets both (the threads, and the scratchpads).
     */
    get stateCollection(): string {
        return `${this.#options.collection}__state`;
    }

    async getState(key: string, ctx?: AgentMemoryContext): Promise<AgentMemoryState | undefined> {
        const db = this.#db(ctx);
        const doc: any = await db.collection(this.stateCollection).findOne({ _id: key as any });
        return doc ? { value: doc.value, updatedAt: doc.updatedAt } : undefined;
    }

    async setState(key: string, value: AgentMemoryState, ctx?: AgentMemoryContext): Promise<void> {
        const db = this.#db(ctx);
        await db.collection(this.stateCollection).updateOne(
            { _id: key as any },
            {
                $set: { value: value.value, updatedAt: value.updatedAt ?? new Date() },
                $setOnInsert: { createdAt: new Date() },
            },
            { upsert: true },
        );
    }

    async clearState(key: string, ctx?: AgentMemoryContext): Promise<void> {
        const db = this.#db(ctx);
        await db.collection(this.stateCollection).deleteOne({ _id: key as any });
    }

    #db(ctx?: AgentMemoryContext): Db {
        const db: any = (ctx?.rest as any)?.db;
        if (!db?.collection) {
            throw new AppError(
                'A Mongo memory store needs a `rest` — resolve the agent from a context (`agents.get(id)`) or pass one (`agents.get(tenantId, id, rest)`)',
                { status: 500, code: "AGENT_MEMORY_NO_REST" },
            );
        }
        return db as Db;
    }

    /** Indexes and retention, once per database connection. */
    #ensure(db: Db): Promise<void> {
        let pending = this.#ready.get(db);
        if (pending) return pending;

        pending = (async () => {
            try {
                const collection = db.collection(this.collection);
                // `list()` — the caller's most recent threads
                await collection.createIndex({ resourceId: 1, updatedAt: -1 }, { background: true });
                if (this.#options.ttl !== undefined) {
                    await syncTtlRetention(db, {
                        collection: this.collection,
                        index: `${this.collection}_updatedAt_ttl`,
                        field: "updatedAt",
                        retention: this.#options.ttl,
                        label: "Agent memory",
                    });
                }
            } catch (err: any) {
                // Never fatal: a missing index costs performance, not correctness
                console.error(`Agent memory index setup failed: ${err?.message}`);
            }
        })();

        this.#ready.set(db, pending);
        return pending;
    }

    async get(threadId: string, ctx?: AgentMemoryContext): Promise<AgentMessage[]> {
        const db = this.#db(ctx);
        await this.#ensure(db);

        const doc: any = await db.collection(this.collection).findOne({
            _id: threadKey(threadId, ctx, this.#options.scoped ?? true) as any,
        });
        return (doc?.messages ?? []) as AgentMessage[];
    }

    async save(threadId: string, messages: AgentMessage[], ctx?: AgentMemoryContext): Promise<void> {
        const db = this.#db(ctx);
        await this.#ensure(db);

        const scoped = this.#options.scoped ?? true;
        const trimmed = trimMessages(messages, Math.max(1, this.#options.maxMessages ?? DEFAULT_MAX_MESSAGES));
        const now = new Date();

        await db.collection(this.collection).updateOne(
            { _id: threadKey(threadId, ctx, scoped) as any },
            {
                $set: {
                    threadId,
                    resourceId: ctx?.resourceId,
                    agentId: ctx?.agentId,
                    messages: trimmed,
                    updatedAt: now,
                },
                // The title and the creation date tell the story of the thread —
                // a later save must not overwrite them.
                $setOnInsert: {
                    createdAt: now,
                    ...(threadTitle(trimmed) ? { title: threadTitle(trimmed) } : {}),
                },
            },
            { upsert: true },
        );
    }

    async clear(threadId: string, ctx?: AgentMemoryContext): Promise<void> {
        const db = this.#db(ctx);
        await this.#ensure(db);

        const key = threadKey(threadId, ctx, this.#options.scoped ?? true);
        await db.collection(this.collection).deleteOne({ _id: key as any });

        // A deleted thread no longer exists, so a date cursor can never see it —
        // leave a tombstone so the deletion reaches the destinations too. Only when
        // that collection is actually replicated for the tenant.
        if (ctx?.tenant && replicatesCollection(ctx.tenant, this.collection)) {
            await writeDeleteMarkers(db, ctx.tenant, this.collection, [key]);
        }
    }

    async list(ctx?: AgentMemoryContext & { limit?: number }): Promise<AgentThread[]> {
        const db = this.#db(ctx);
        await this.#ensure(db);

        const scoped = this.#options.scoped ?? true;
        const filter = scoped && ctx?.resourceId ? { resourceId: ctx.resourceId } : {};

        const docs: any[] = await db.collection(this.collection)
            .find(filter)
            .sort({ updatedAt: -1 })
            .limit(ctx?.limit ?? DEFAULT_LIST_LIMIT)
            .toArray();

        return docs.map((doc) => ({
            threadId: doc.threadId ?? doc._id,
            resourceId: doc.resourceId,
            title: doc.title,
            messages: Array.isArray(doc.messages) ? doc.messages.length : 0,
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt,
        }));
    }
}

export {
    DEFAULT_MAX_MESSAGES,
    threadKey,
    threadTitle,
    trimMessages,
};

// ─── Redis ──────────────────────────────────────────────────────────────

/**
 * Redis conversation store — shared by every process, no MongoDB involved.
 *
 * ```ts
 * memory: new agents.memory.Redis({ url: Bun.env.REDIS_URL, ttl: '7d' })
 * ```
 *
 * Layout (one key per thread, one sorted set per caller):
 *
 * ```
 * anteros:agent-memory:<tenant>:thread:<resourceId>:<threadId>   → JSON
 * anteros:agent-memory:<tenant>:resource:<resourceId>            → ZSET (score = updatedAt)
 * ```
 *
 * The **tenant is part of every key** (unlike the Mongo store, whose database is
 * already per tenant): a store instance created once at module scope can serve
 * several tenants without mixing their conversations — and refuses to run without
 * a tenant rather than putting everyone in one bucket.
 *
 * The caller index is what `list()` reads; it is pruned of threads that expired,
 * and it expires on the same TTL as the threads it points to.
 */
export class RedisAgentMemory implements AgentMemory {
    #options: RedisAgentMemoryOptions;
    #client?: RedisClientLike;

    constructor(options: RedisAgentMemoryOptions = {}) {
        this.#options = options;
        this.#client = options.client;
    }

    /** Key namespace. */
    get prefix(): string {
        return this.#options.prefix ?? "anteros:agent-memory";
    }

    /** The `ioredis` client, created on first use (`lazyConnect`). */
    #redis(): RedisClientLike {
        if (this.#client) return this.#client;

        const { url, host, port, password } = this.#options;
        const connection = url
            ?? Bun.env.REDIS_URL
            ?? (host || Bun.env.REDIS_HOST
                ? {
                    host: host ?? Bun.env.REDIS_HOST,
                    port: port ?? (Bun.env.REDIS_PORT ? Number(Bun.env.REDIS_PORT) : 6379),
                    password: password ?? Bun.env.REDIS_PASSWORD,
                }
                : "redis://localhost:6379");

        // `lazyConnect`: defining the agent (module scope) must not open a socket
        this.#client = new Redis(connection as any, { lazyConnect: true }) as unknown as RedisClientLike;
        return this.#client;
    }

    /** A thread lives with its tenant: mixing them in one bucket is a data leak. */
    #namespace(ctx?: AgentMemoryContext): string {
        const tenant = ctx?.tenant;
        if (!tenant) {
            throw new AppError(
                "A Redis memory store needs the tenant — resolve the agent from a context (`agents.get(id)`)",
                { status: 500, code: "AGENT_MEMORY_NO_TENANT" },
            );
        }
        return tenant;
    }

    #threadKey(threadId: string, ctx?: AgentMemoryContext): string {
        const scoped = this.#options.scoped ?? true;
        return `${this.prefix}:${this.#namespace(ctx)}:thread:${threadKey(threadId, ctx, scoped)}`;
    }

    #resourceKey(ctx?: AgentMemoryContext): string {
        return `${this.prefix}:${this.#namespace(ctx)}:resource:${ctx?.resourceId ?? "-"}`;
    }

    #stateKey(key: string, ctx?: AgentMemoryContext): string {
        return `${this.prefix}:${this.#namespace(ctx)}:state:${key}`;
    }

    /** `ttl` as Redis seconds. */
    #seconds(): number | null {
        const ttl = this.#options.ttl;
        if (ttl === undefined || ttl === false) return null;
        const ms = parseDuration(ttl);
        if (ms === null) throw new AppError(`Invalid memory ttl '${ttl}' — expected a duration like '7d'`, {
            status: 500, code: "AGENT_MEMORY_INVALID_TTL",
        });
        return Math.max(1, Math.ceil(ms / 1000));
    }

    async get(threadId: string, ctx?: AgentMemoryContext): Promise<AgentMessage[]> {
        const raw = await this.#redis().get(this.#threadKey(threadId, ctx));
        if (!raw) return [];
        try {
            return (JSON.parse(raw)?.messages ?? []) as AgentMessage[];
        } catch {
            // Corrupted entry — never let it break a run
            console.error(`Agent memory: unreadable thread '${threadId}' in Redis`);
            return [];
        }
    }

    async save(threadId: string, messages: AgentMessage[], ctx?: AgentMemoryContext): Promise<void> {
        const redis = this.#redis();
        const scoped = this.#options.scoped ?? true;
        const key = this.#threadKey(threadId, ctx);
        const trimmed = trimMessages(messages, Math.max(1, this.#options.maxMessages ?? DEFAULT_MAX_MESSAGES));

        // `title` and `createdAt` belong to the first exchange: Redis has no
        // `$setOnInsert`, so the previous value is read back before writing.
        const raw = await redis.get(key);
        const previous = raw ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : null;

        const now = new Date();
        const payload = {
            threadId,
            resourceId: ctx?.resourceId,
            agentId: ctx?.agentId,
            title: previous?.title ?? threadTitle(trimmed),
            messages: trimmed,
            createdAt: previous?.createdAt ?? now.toISOString(),
            updatedAt: now.toISOString(),
        };

        const seconds = this.#seconds();
        if (seconds) await redis.set(key, JSON.stringify(payload), "EX", seconds);
        else await redis.set(key, JSON.stringify(payload));

        // The caller index — what `list()` walks
        if (scoped && ctx?.resourceId) {
            const index = this.#resourceKey(ctx);
            await redis.zadd(index, now.getTime(), threadKey(threadId, ctx, true));
            // An index that outlives its threads would grow forever
            if (seconds) await redis.expire(index, seconds);
        }
    }

    async clear(threadId: string, ctx?: AgentMemoryContext): Promise<void> {
        const redis = this.#redis();
        await redis.del(this.#threadKey(threadId, ctx));
        if ((this.#options.scoped ?? true) && ctx?.resourceId) {
            await redis.zrem(this.#resourceKey(ctx), threadKey(threadId, ctx, true));
        }
    }

    async getState(key: string, ctx?: AgentMemoryContext): Promise<AgentMemoryState | undefined> {
        const raw = await this.#redis().get(this.#stateKey(key, ctx));
        if (!raw) return undefined;
        try {
            const parsed = JSON.parse(raw);
            return { value: parsed?.value, updatedAt: parsed?.updatedAt ? new Date(parsed.updatedAt) : undefined };
        } catch {
            return undefined;
        }
    }

    async setState(key: string, value: AgentMemoryState, ctx?: AgentMemoryContext): Promise<void> {
        // No expiry: a profile must outlive the conversation that created it
        await this.#redis().set(this.#stateKey(key, ctx), JSON.stringify({
            value: value.value,
            updatedAt: (value.updatedAt ?? new Date()).toISOString(),
        }));
    }

    async clearState(key: string, ctx?: AgentMemoryContext): Promise<void> {
        await this.#redis().del(this.#stateKey(key, ctx));
    }

    async list(ctx?: AgentMemoryContext & { limit?: number }): Promise<AgentThread[]> {
        const redis = this.#redis();
        const index = this.#resourceKey(ctx);
        const limit = ctx?.limit ?? DEFAULT_LIST_LIMIT;

        const members = await redis.zrevrange(index, 0, limit - 1);
        if (!members.length) return [];

        const raws = await redis.mget(...members.map((member) => `${this.prefix}:${this.#namespace(ctx)}:thread:${member}`));

        const threads: AgentThread[] = [];
        const stale: string[] = [];

        members.forEach((member, position) => {
            const raw = raws[position];
            if (!raw) { stale.push(member); return; } // expired or cleared behind our back
            try {
                const doc = JSON.parse(raw);
                threads.push({
                    threadId: doc.threadId ?? member,
                    resourceId: doc.resourceId,
                    title: doc.title,
                    messages: Array.isArray(doc.messages) ? doc.messages.length : 0,
                    createdAt: doc.createdAt ? new Date(doc.createdAt) : undefined,
                    updatedAt: doc.updatedAt ? new Date(doc.updatedAt) : new Date(),
                });
            } catch {
                stale.push(member);
            }
        });

        if (stale.length) await redis.zrem(index, ...stale);
        return threads;
    }

    /** Close the client when the store owns it (a provided one is left alone). */
    async close(): Promise<void> {
        const client: any = this.#client;
        if (this.#options.client || !client) return;
        this.#client = undefined;
        try { await client.quit?.(); } catch { /* already gone */ }
    }
}
