import { DuckdbQuackInstance, DuckdbQuackError } from "./quack";
import type { DuckdbExecResult, QuackInstanceOptions } from "../types/quack";

/** What a pool is configured with — the instance's options, plus its size. */
export type DuckdbQuackPoolOptions = QuackInstanceOptions & {
    /** Clients kept at most (default `4`). */
    size?: number;
};

/**
 * A **bounded pool of Quack clients** — one session per client, reused instead of
 * re-created per request.
 *
 * ```ts
 * const pool = new DuckdbQuackPool({ url, token, size: 4 });
 *
 * const { rows } = await pool.exec("SELECT count(*) AS n FROM tickets");
 *
 * await pool.withClient(async (db) => {
 *   await db.ingest({ table: "events", rows });
 *   await db.flush();
 * });
 *
 * await pool.close();
 * ```
 *
 * Why: one `DuckdbQuackInstance` is one Quack session, and the server refuses new
 * clients past `quack_server_max_connections` (default `1024`) — with an error that
 * looks like a network failure. A pool makes "one client per request" impossible to
 * get wrong: `withClient()` always returns its client, even when the callback throws.
 *
 * A client whose attachment was invalidated (the server restarted) is **re-attached**
 * before it goes back to the pool; one that is closed or cannot re-attach is dropped
 * and replaced on the next call.
 */
export class DuckdbQuackPool {
    /** The maximum number of clients (`size`). */
    readonly size: number;

    #options: QuackInstanceOptions;
    #idle: DuckdbQuackInstance[] = [];
    #live = new Set<DuckdbQuackInstance>();
    #waiters: Array<{
        resolve: (db: DuckdbQuackInstance) => void;
        reject: (error: unknown) => void;
    }> = [];
    #closed = false;

    constructor(options: DuckdbQuackPoolOptions = {}) {
        const { size = 4, ...rest } = options;
        if (!Number.isInteger(size) || size < 1) {
            throw new DuckdbQuackError("A pool needs a `size` of at least 1", "DUCKDB_POOL_SIZE_INVALID");
        }
        this.size = size;
        this.#options = rest;
    }

    /** Clients currently opened (borrowed + idle). */
    get created(): number {
        return this.#live.size;
    }

    /** Clients waiting to be borrowed. */
    get idle(): number {
        return this.#idle.length;
    }

    /** Callers waiting for a client. */
    get waiting(): number {
        return this.#waiters.length;
    }

    get isClosed(): boolean {
        return this.#closed;
    }

    /**
     * Borrow a client for the duration of `work`, then give it back — the callback
     * throwing does not leak it.
     */
    async withClient<T>(work: (db: DuckdbQuackInstance) => Promise<T>): Promise<T> {
        const db = await this.#acquire();
        let reusable = true;
        try {
            return await work(db);
        } catch (err: any) {
            reusable = await this.#recover(db, err);
            throw err;
        } finally {
            this.#release(db, reusable);
        }
    }

    /** Borrow one client for a single statement. */
    exec(sql: string, values?: any[] | Record<string, any>): Promise<DuckdbExecResult> {
        return this.withClient((db) => db.exec(sql, values));
    }

    /** Close every client and refuse the next call. Idempotent. */
    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        const error = new DuckdbQuackError("This pool is closed", "DUCKDB_CLOSED");
        for (const waiter of this.#waiters.splice(0)) waiter.reject(error);

        const clients = [...this.#live];
        this.#live.clear();
        this.#idle.length = 0;
        await Promise.all(clients.map((db) => db.close().catch(() => { })));
    }

    async #acquire(): Promise<DuckdbQuackInstance> {
        if (this.#closed) throw new DuckdbQuackError("This pool is closed", "DUCKDB_CLOSED");

        const idle = this.#idle.pop();
        if (idle) return idle;

        if (this.#live.size < this.size) {
            const db = new DuckdbQuackInstance(this.#options);
            this.#live.add(db);
            try {
                await db.connect();
            } catch (err) {
                this.#live.delete(db);
                throw err;
            }
            return db;
        }

        return new Promise<DuckdbQuackInstance>((resolve, reject) => {
            this.#waiters.push({ resolve, reject });
        });
    }

    #release(db: DuckdbQuackInstance, reusable: boolean): void {
        if (!this.#live.has(db)) return;
        // A callback may have closed the client itself (`await db.close()` inside
        // `withClient`) — never hand a dead handle to the next caller.
        if (!reusable || this.#closed || !db.isConnected) {
            this.#live.delete(db);
            void db.close().catch(() => { });
            // A waiter must not stay parked forever because that slot just died:
            // the pool is below `size` again, so build a replacement for it.
            const waiter = this.#waiters.shift();
            if (waiter) this.#acquire().then(waiter.resolve, waiter.reject);
            return;
        }
        const waiter = this.#waiters.shift();
        if (waiter) waiter.resolve(db);
        else this.#idle.push(db);
    }

    /**
     * Make a client usable again after `work` threw. Returns whether it may go back
     * to the pool: a restarted server is re-attached, anything else that killed the
     * client (closed handle, broken attach) drops it.
     */
    async #recover(db: DuckdbQuackInstance, err: any): Promise<boolean> {
        const code = String(err?.code ?? "");
        if (code === "DUCKDB_QUACK_DATABASE_INVALIDATED") {
            try {
                await db.reattach();
                return true;
            } catch {
                await db.close().catch(() => { });
                return false;
            }
        }
        if (code === "DUCKDB_CLOSED" || !db.isConnected) {
            await db.close().catch(() => { });
            return false;
        }
        return true;
    }
}
