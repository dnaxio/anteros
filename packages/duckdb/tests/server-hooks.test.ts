import { describe, it, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckdbQuackInstance, DuckdbQuackServer, DuckdbQuackError } from "../index";
import { freePort } from "./helpers";

/**
 * The server's start hooks — the order they run in, what a failure does to the
 * start, and the rebuild a persistent vector index needs.
 *
 * Every assertion goes through the real listener or the real file: whether the
 * port answers, whether a client can search, not a mock of either.
 */

/** Whether something answers HTTP on the port — Quack serves a banner on `/`. */
async function portAnswers(port: number): Promise<boolean> {
    try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
        return true;
    } catch {
        return false;
    }
}

/** Wait for an out-of-band hook to record itself, or name the events that did run. */
async function waitFor(done: () => boolean, events: string[] = [], timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!done()) {
        if (Date.now() > deadline) throw new Error(`timed out; events seen: ${events.join(", ")}`);
        await Bun.sleep(10);
    }
}

describe("@anteros/duckdb — server start hooks", () => {
    it("runs beforeStart before the port answers, onReady while serving, afterStart once started", async () => {
        const port = freePort();
        const events: string[] = [];
        let resolved = false;

        const server = new DuckdbQuackServer({
            port,
            token: "hook-token",
            async beforeStart(db) {
                events.push("beforeStart");
                await db.exec("CREATE TABLE staged AS SELECT 1 AS n");
                events.push(`beforeStart:answered=${await portAnswers(port)}`);
            },
            async onReady(ready) {
                events.push("onReady");
                const client = new DuckdbQuackInstance({ url: ready.url, token: "hook-token" });
                try {
                    const { rows } = await client.exec("SELECT n FROM staged");
                    events.push(`onReady:rows=${rows[0]!.n}`);
                } finally {
                    await client.close();
                }
            },
            async afterStart(started) {
                events.push(`afterStart:resolved=${resolved}:running=${started.isRunning}`);
            },
        });

        try {
            await server.start();
            resolved = true;
            await waitFor(() => events.some((event) => event.startsWith("afterStart")), events);
            expect(events).toEqual([
                "beforeStart",
                "beforeStart:answered=false",
                "onReady",
                "onReady:rows=1",
                "afterStart:resolved=true:running=true",
            ]);
        } finally {
            await server.stop();
        }
    }, 90_000);

    it("fails the start with a timeout code when beforeStart outlives its budget", async () => {
        const server = new DuckdbQuackServer({
            port: freePort(),
            token: "hook-token",
            beforeStart: () => new Promise<void>(() => { }),
            beforeStartTimeoutMs: 50,
        });

        try {
            const error = await server.start().catch((err) => err);
            expect(error).toBeInstanceOf(DuckdbQuackError);
            expect(error.code).toBe("DUCKDB_QUACK_BEFORE_START_TIMEOUT");
            expect(String(error.message)).toContain("beforeStart");
            expect(server.isRunning).toBe(false);
        } finally {
            await server.stop();
        }
    }, 60_000);

    it("fails the start, and releases it, when beforeStart throws", async () => {
        const server = new DuckdbQuackServer({
            port: freePort(),
            token: "hook-token",
            beforeStart: async () => {
                throw new Error("migration broke");
            },
        });

        try {
            const error = await server.start().catch((err) => err);
            expect(error).toBeInstanceOf(DuckdbQuackError);
            expect(error.code).toBe("DUCKDB_QUACK_BEFORE_START_FAILED");
            expect(String(error.message)).toContain("migration broke");
            expect(server.isRunning).toBe(false);
            expect(await server.health()).toBe(false);
        } finally {
            await server.stop();
        }
    }, 60_000);

    it("fails the start, and releases the listener, when onReady throws", async () => {
        const server = new DuckdbQuackServer({
            port: freePort(),
            token: "hook-token",
            onReady: async () => {
                throw new Error("announcement failed");
            },
        });

        try {
            const error = await server.start().catch((err) => err);
            expect(error).toBeInstanceOf(DuckdbQuackError);
            expect(error.code).toBe("DUCKDB_QUACK_READY_FAILED");
            expect(String(error.message)).toContain("announcement failed");
            expect(server.isRunning).toBe(false);
            expect(await server.health()).toBe(false);
        } finally {
            await server.stop();
        }
    }, 60_000);

    it("reports an afterStart failure through onError, without failing the start", async () => {
        const failures: Error[] = [];
        const server = new DuckdbQuackServer({
            port: freePort(),
            token: "hook-token",
            onError: (error) => failures.push(error),
            afterStart: async () => {
                throw new Error("warm-up failed");
            },
        });

        try {
            await expect(server.start()).resolves.toBe(server);
            await waitFor(() => failures.length > 0);
            expect(failures[0]!.message).toBe("warm-up failed");
        } finally {
            await server.stop();
        }
    }, 60_000);

    it("rebuilds a stored HNSW index when it restarts on a dbPath", async () => {
        const directory = await mkdtemp(join(tmpdir(), "quack-rebuild-"));
        const file = join(directory, "vectors.duckdb");

        const seeder = new DuckdbQuackInstance({ dbPath: file });
        await seeder.createTable("vecs", [
            { name: "id", type: "string", primaryKey: true },
            { name: "vec", type: "FLOAT[3]" },
        ]);
        await seeder.ingest({ table: "vecs", rows: [{ id: "v1", vec: [1, 0, 0] }, { id: "v2", vec: [0, 1, 0] }] });
        await seeder.flush();
        await seeder.createVssIndex("vecs", { column: "vec" });
        await seeder.close();

        const server = new DuckdbQuackServer({
            port: freePort(),
            token: "hook-token",
            dbPath: file,
            rebuildIndexesOnStart: ["hnsw"],
        });

        try {
            await server.start();

            const client = new DuckdbQuackInstance({ url: server.url, token: "hook-token" });
            try {
                const { rows } = await client.searchVss("vecs", [1, 0, 0], { column: "vec", limit: 1 });
                expect(rows.map((row) => row.id)).toEqual(["v1"]);
            } finally {
                await client.close();
            }

            // The replay left the index in place, with the stored HNSW definition.
            const { rows } = await server.db.exec(
                "SELECT index_name, sql FROM duckdb_indexes() WHERE index_name = 'vss_vecs_vec'",
            );
            expect(rows).toHaveLength(1);
            expect(String(rows[0]!.sql)).toMatch(/USING\s+HNSW/i);
        } finally {
            await server.stop();
            await rm(directory, { recursive: true, force: true });
        }
    }, 180_000);
});
