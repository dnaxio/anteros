import { describe, it, expect } from "bun:test";
import { DuckdbQuackError, DuckdbQuackPool, DuckdbQuackServer } from "../index";
import { freePort } from "./helpers";

/**
 * `DuckdbQuackPool`, tested against a real Quack server.
 *
 * The constructor guard is the point: a pool without a `url` has nothing to share,
 * so it would open one independent local database per client instead of refusing.
 */

const TOKEN = "pool-secret";

/** The error a throwing call raised — keeps the code in the assertion. */
function captureThrow(run: () => unknown): any {
    try {
        run();
    } catch (err) {
        return err;
    }
    throw new Error("expected the call to throw");
}

describe("pool configuration", () => {
    it("refuses a pool with no remote url", () => {
        for (const options of [{}, { dbPath: "./x.duckdb" }]) {
            const error = captureThrow(() => new DuckdbQuackPool(options));
            expect(error).toBeInstanceOf(DuckdbQuackError);
            expect(error.code).toBe("DUCKDB_POOL_REMOTE_REQUIRED");
        }
    });
});

describe("pool over a real server", () => {
    it("runs a statement through a client attached to the server", async () => {
        const server = new DuckdbQuackServer({ port: freePort(), token: TOKEN });
        await server.start();
        const pool = new DuckdbQuackPool({ url: server.url, token: TOKEN, size: 1 });
        try {
            const { rows } = await pool.exec("SELECT 42 AS n");
            expect(rows).toEqual([{ n: 42 }]);
            expect(pool.created).toBe(1);
            expect(pool.idle).toBe(1);
        } finally {
            await pool.close();
            await server.stop();
        }
    }, 180_000);
});
