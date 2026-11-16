import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DuckdbAgentMemory } from "../lib/agentMemory";
import type { AgentMessage } from "../types/agent";

/**
 * `agents.memory.duckdb` — a thread store in a DuckDB table, local file or Quack server.
 *
 * The store keeps two tables: the threads (one row per conversation, the whole
 * thread in a `data` JSON column) and `<table>__state` for the working memory.
 */

const message = (role: string, content: string): AgentMessage => ({ role, content } as AgentMessage);

const dir = mkdtempSync(path.join(tmpdir(), "agent-memory-duckdb-"));
const dbPath = path.join(dir, "memory.duckdb");
const open: DuckdbAgentMemory[] = [];

/** Every store is closed in `afterAll` — the file stays locked otherwise. */
function store(options: Record<string, unknown> = {}): DuckdbAgentMemory {
    const memory = new DuckdbAgentMemory({ table: "agent_threads", url: dbPath, ...options } as any);
    open.push(memory);
    return memory;
}

async function freePort(): Promise<number> {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() { /* nothing */ } } });
    const port = probe.port;
    probe.stop(true);
    return port;
}

afterAll(async () => {
    for (const memory of open) await memory.close();
    rmSync(dir, { recursive: true, force: true });
});

describe("agents.memory.duckdb — local file", () => {
    it("round-trips a thread", async () => {
        const memory = store({ table: "threads_roundtrip" });
        await memory.save("t1", [message("user", "hi"), message("assistant", "hello")]);

        const read = await memory.get("t1");
        expect(read.map((m) => m.content)).toEqual(["hi", "hello"]);
        expect(await memory.get("missing")).toEqual([]);
    });

    it("namespaces the thread per caller (scoped by default)", async () => {
        const memory = store({ table: "threads_scope" });
        await memory.save("t1", [message("user", "from A")], { resourceId: "A" });
        await memory.save("t1", [message("user", "from B")], { resourceId: "B" });

        expect((await memory.get("t1", { resourceId: "A" })).map((m) => m.content)).toEqual(["from A"]);
        expect((await memory.get("t1", { resourceId: "B" })).map((m) => m.content)).toEqual(["from B"]);
        expect(await memory.get("t1")).toEqual([]); // the bare id is another thread

        await memory.clear("t1", { resourceId: "A" });
        expect(await memory.get("t1", { resourceId: "A" })).toEqual([]);
        expect((await memory.get("t1", { resourceId: "B" })).length).toBe(1);
    });

    it("bounds a thread, keeping the opening system message", async () => {
        const memory = store({ table: "threads_cap", maxMessages: 3 });
        await memory.save("cap", [
            message("system", "be brief"),
            message("user", "1"),
            message("assistant", "2"),
            message("user", "3"),
        ]);

        const read = await memory.get("cap");
        expect(read.map((m) => m.content)).toEqual(["be brief", "2", "3"]);
    });

    it("keeps createdAt and the title across saves", async () => {
        const memory = store({ table: "threads_title" });
        await memory.save("title", [message("user", "Premier message")]);
        const first = (await memory.list({})).find((t) => t.threadId === "title")!;
        expect(first.title).toBe("Premier message");
        expect(first.messages).toBe(1);

        await Bun.sleep(5);
        await memory.save("title", [message("user", "Premier message"), message("assistant", "ok")]);
        const second = (await memory.list({})).find((t) => t.threadId === "title")!;
        expect(second.title).toBe("Premier message");
        expect(second.messages).toBe(2);
        expect(second.createdAt!.getTime()).toBe(first.createdAt!.getTime());
        expect(second.updatedAt!.getTime()).toBeGreaterThan(first.updatedAt!.getTime());
    });

    it("lists newest first, filters by resource, honours limit", async () => {
        const memory = store({ table: "threads_list" });
        await memory.save("old", [message("user", "old")], { resourceId: "U1" });
        await Bun.sleep(5);
        await memory.save("new", [message("user", "new")], { resourceId: "U1" });
        await Bun.sleep(5);
        await memory.save("other", [message("user", "other")], { resourceId: "U2" });

        expect((await memory.list({ resourceId: "U1" })).map((t) => t.threadId)).toEqual(["new", "old"]);
        expect((await memory.list({ resourceId: "U2" })).map((t) => t.threadId)).toEqual(["other"]);
        expect((await memory.list({ resourceId: "U1", limit: 1 })).map((t) => t.threadId)).toEqual(["new"]);
        // No resource in the context → every thread, newest first
        expect((await memory.list({})).map((t) => t.threadId)).toEqual(["other", "new", "old"]);
    });

    it("stores the working memory in <table>__state", async () => {
        const memory = store({ table: "threads_state" });
        expect(await memory.getState("scratch")).toBeUndefined();

        const at = new Date();
        await memory.setState("scratch", { value: { step: 1 }, updatedAt: at });
        const read = await memory.getState("scratch");
        expect(read).toEqual({ value: { step: 1 }, updatedAt: at });

        await memory.setState("scratch", { value: "v2" });
        expect((await memory.getState("scratch"))!.value).toBe("v2");

        await memory.clearState("scratch");
        expect(await memory.getState("scratch")).toBeUndefined();

        const db = await memory.db();
        const { rows } = await db.exec(
            `SELECT table_name FROM information_schema.tables WHERE table_name = 'threads_state__state'`,
        );
        expect(rows).toHaveLength(1);
    });

    it("purges rows older than the ttl on write, without a timer", async () => {
        const memory = store({ table: "threads_ttl", ttl: "1d" });
        const db = await memory.db();
        const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
        await db.exec(
            `INSERT INTO "threads_ttl" (id, resource_id, data, updated_at) VALUES ($1, NULL, $2, $3)`,
            ["stale", JSON.stringify({ threadId: "stale", messages: [message("user", "old")] }), tenDaysAgo],
        );

        // The first save on this store is what triggers the purge
        await memory.save("fresh", [message("user", "new")]);

        expect(await memory.get("stale")).toEqual([]);
        expect((await memory.get("fresh")).length).toBe(1);
    });

    it("refuses an invalid table, a missing url and a bad ttl", () => {
        expect(() => new DuckdbAgentMemory({ table: 'x"; DROP TABLE y', url: dbPath } as any))
            .toThrow(/table/);
        expect(() => new DuckdbAgentMemory({ table: "t" } as any)).toThrow(/url/);
        expect(() => new DuckdbAgentMemory({ table: "t", url: dbPath, ttl: "soon" } as any)).toThrow(/ttl/);
    });
});

describe("agents.memory.duckdb — Quack server", () => {
    it("stores and reads threads on a remote server", async () => {
        const { DuckdbQuackServer } = await import("@anteros/duckdb");
        const token = "agent-memory-token";
        const server = new DuckdbQuackServer({
            token,
            port: await freePort(),
            disableSsl: true,
        });
        await server.start();

        const memory = store({
            table: "remote_threads",
            url: server.listenUri,
            token,
            dbPath: undefined,
        });

        try {
            await memory.save("r1", [message("user", "remote"), message("assistant", "served")], { resourceId: "R" });

            expect((await memory.get("r1", { resourceId: "R" })).map((m) => m.content))
                .toEqual(["remote", "served"]);
            expect((await memory.list({ resourceId: "R" })).map((t) => t.threadId)).toEqual(["r1"]);

            // The rows really live on the server, not in a local catalog
            const { rows } = await server.db.exec(`SELECT count(*)::INT AS n FROM "remote_threads"`);
            expect(Number(rows[0]!.n)).toBe(1);
        } finally {
            await memory.close();
            await server.stop();
        }
    }, 30_000);
});
