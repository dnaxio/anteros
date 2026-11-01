import { describe, it, expect, spyOn } from "bun:test";
import { DuckdbQuackInstance, DuckdbQuackServer, DuckdbQuackError } from "../index";
import { freePort } from "./helpers";

/**
 * The server's administrative surface: the options the constructor refuses, the
 * sessions it reports, a drained stop, and the signal handling.
 *
 * Every case builds its own server and releases it in `finally` — a listener, a
 * port or a keep-alive timer left behind makes the next case fail for the wrong
 * reason.
 */

const TOKEN = "admin-token";

/** The columns `quack_active_connections()` exposes. */
const SESSION_COLUMNS = [
    "server_id",
    "connection_id",
    "query",
    "state",
    "client_id_hash",
    "cached_rows",
    "query_started_at",
];

/** The error a constructor call threw — a message change must not hide the check. */
function refusal(build: () => unknown): DuckdbQuackError {
    try {
        build();
    } catch (err) {
        return err as DuckdbQuackError;
    }
    throw new Error("the constructor accepted an invalid option");
}

/** Poll a condition, so an asynchronous effect is asserted when it happened. */
async function waitFor(done: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await done())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(20);
    }
}

describe("@anteros/duckdb — server administration", () => {
    it("refuses a port, a health port, a timeout or a rebuild kind it cannot honour", () => {
        const port = freePort();
        const cases: Array<[string, () => unknown, string]> = [
            ["port 0", () => new DuckdbQuackServer({ port: 0, token: TOKEN }), "DUCKDB_QUACK_PORT_INVALID"],
            ["port 65536", () => new DuckdbQuackServer({ port: 65_536, token: TOKEN }), "DUCKDB_QUACK_PORT_INVALID"],
            ["a fractional port", () => new DuckdbQuackServer({ port: 9494.5, token: TOKEN }), "DUCKDB_QUACK_PORT_INVALID"],
            ["healthPort 0", () => new DuckdbQuackServer({ healthPort: 0, token: TOKEN }), "DUCKDB_QUACK_HEALTH_PORT_INVALID"],
            ["healthPort 65536", () => new DuckdbQuackServer({ healthPort: 65_536, token: TOKEN }), "DUCKDB_QUACK_HEALTH_PORT_INVALID"],
            ["healthPort on the Quack port", () => new DuckdbQuackServer({ port, healthPort: port, token: TOKEN }), "DUCKDB_QUACK_HEALTH_PORT_INVALID"],
            ["healthPort on the default Quack port", () => new DuckdbQuackServer({ healthPort: 9494, token: TOKEN }), "DUCKDB_QUACK_HEALTH_PORT_INVALID"],
            ["a zero beforeStartTimeoutMs", () => new DuckdbQuackServer({ beforeStartTimeoutMs: 0, token: TOKEN }), "DUCKDB_QUACK_OPTION_INVALID"],
            ["a negative beforeStartTimeoutMs", () => new DuckdbQuackServer({ beforeStartTimeoutMs: -1, token: TOKEN }), "DUCKDB_QUACK_OPTION_INVALID"],
            ["a NaN beforeStartTimeoutMs", () => new DuckdbQuackServer({ beforeStartTimeoutMs: Number.NaN, token: TOKEN }), "DUCKDB_QUACK_OPTION_INVALID"],
            ["an unknown rebuild kind", () => new DuckdbQuackServer({ rebuildIndexesOnStart: ["hnsw", "ivf"] as any, token: TOKEN }), "DUCKDB_QUACK_REBUILD_INVALID"],
            ["a scalar rebuild kind", () => new DuckdbQuackServer({ rebuildIndexesOnStart: "hnsw" as any, token: TOKEN }), "DUCKDB_QUACK_REBUILD_INVALID"],
        ];

        for (const [label, build, code] of cases) {
            const error = refusal(build);
            expect(error).toBeInstanceOf(DuckdbQuackError);
            expect({ label, code: error.code }).toEqual({ label, code });
        }

        // The accepted forms stay accepted: an array of known kinds, an empty one.
        expect(new DuckdbQuackServer({ port, token: TOKEN, rebuildIndexesOnStart: ["hnsw"] }).isRunning).toBe(false);
        expect(new DuckdbQuackServer({ token: TOKEN, rebuildIndexesOnStart: [] }).isRunning).toBe(false);
    });

    it("reports the attached sessions, and none once the server is stopped", async () => {
        const server = new DuckdbQuackServer({ port: freePort(), token: TOKEN });
        expect(await server.connections()).toEqual([]);

        try {
            await server.start();
            expect(await server.connections()).toEqual([]);

            const client = new DuckdbQuackInstance({ url: server.url, token: TOKEN });
            try {
                await client.exec("SELECT 1 AS n");
                const sessions = await server.connections();
                expect(sessions).toHaveLength(1);
                for (const column of SESSION_COLUMNS) {
                    expect(Object.keys(sessions[0]!)).toContain(column);
                }
            } finally {
                await client.close();
            }

            await waitFor(async () => (await server.connections()).length === 0, "the session to detach", 20_000);
        } finally {
            await server.stop();
        }

        expect(await server.connections()).toEqual([]);
    }, 90_000);

    it("waits for the attached sessions before stopping when drain is asked for", async () => {
        const server = new DuckdbQuackServer({ port: freePort(), token: TOKEN });
        await server.start();

        const client = new DuckdbQuackInstance({ url: server.url, token: TOKEN });
        try {
            await client.exec("SELECT 1 AS n");
            expect(await server.connections()).toHaveLength(1);

            // The client leaves while the stop is draining: the stop must wait for it.
            setTimeout(() => { void client.close(); }, 300);
            const started = Date.now();
            await server.stop({ drain: true, timeoutMs: 5_000 });

            expect(Date.now() - started).toBeGreaterThanOrEqual(200);
            expect(server.isRunning).toBe(false);
            expect(await server.connections()).toEqual([]);
        } finally {
            await server.stop();
            await client.close().catch(() => { });
        }
    }, 90_000);

    it("bounds the drain, and stops anyway when a client never leaves", async () => {
        const server = new DuckdbQuackServer({ port: freePort(), token: TOKEN });
        await server.start();

        const client = new DuckdbQuackInstance({ url: server.url, token: TOKEN });
        try {
            await client.exec("SELECT 1 AS n");

            const started = Date.now();
            await server.stop({ drain: true, timeoutMs: 150 });
            const elapsed = Date.now() - started;

            expect(elapsed).toBeGreaterThanOrEqual(100);
            expect(elapsed).toBeLessThan(5_000);
            expect(server.isRunning).toBe(false);
            expect(await server.health()).toBe(false);
        } finally {
            await server.stop();
            await client.close().catch(() => { });
        }
    }, 90_000);

    it("stops and exits on a process signal, registering each listener once", async () => {
        const usr1 = process.listenerCount("SIGUSR1");
        const usr2 = process.listenerCount("SIGUSR2");

        // A server that never started: the disposer only has to remove the listener.
        const idle = new DuckdbQuackServer({ port: freePort(), token: TOKEN });
        const disposeIdle = idle.handleSignals(["SIGUSR1"]);
        expect(process.listenerCount("SIGUSR1")).toBe(usr1 + 1);
        disposeIdle();
        expect(process.listenerCount("SIGUSR1")).toBe(usr1);

        const server = new DuckdbQuackServer({ port: freePort(), token: TOKEN });
        await server.start();

        const realExit = process.exit;
        let exitCode: number | undefined;
        process.exit = ((code?: number) => { exitCode = code; }) as typeof process.exit;
        const log = spyOn(console, "log").mockImplementation(() => { });
        try {
            const dispose = server.handleSignals(["SIGUSR2"]);
            server.handleSignals(["SIGUSR2"]);
            expect(process.listenerCount("SIGUSR2")).toBe(usr2 + 1);

            // The signal name is what Node hands a listener; Bun forwards it too.
            process.emit("SIGUSR2", "SIGUSR2");
            await waitFor(() => exitCode !== undefined, "the signal handler to exit", 30_000);

            expect(exitCode).toBe(0);
            expect(String(log.mock.calls[0]?.[0])).toContain("SIGUSR2");
            expect(server.isRunning).toBe(false);
            // The handler removed itself first: a stop that hangs stays interruptible.
            expect(process.listenerCount("SIGUSR2")).toBe(usr2);

            dispose();
            expect(process.listenerCount("SIGUSR2")).toBe(usr2);
        } finally {
            log.mockRestore();
            process.exit = realExit;
            await server.stop();
        }
    }, 90_000);
});
