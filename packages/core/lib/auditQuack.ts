import { cfg } from "../server/config";
import type { Tenant } from "../types/tenant";
import { parseDuration } from "../utils/func";
import { resolveAuditRetention } from "../database/audit";

/**
 * Append-only **DuckDB mirror** of the audit trail — a `@anteros/duckdb` table fed
 * from the same choke point as `_audit_`, so an analytical store can answer
 * retention and aggregation questions without touching the operational collection.
 *
 * `_audit_` stays the primary: it is what `rest.audit.getActivities()` reads and
 * what the replication engine copies. This is a **second copy**, never a
 * replacement — a quack server that is down must not cost an audit entry.
 */
export type AuditQuackOptions = {
    /**
     * The Quack server (`'quack:host:port'`, port 9494 when omitted) **or a local
     * DuckDB file path** (`'./.data/audit.duckdb'`) — the local form needs no
     * server and no token.
     */
    url: string;
    /** Shared secret of the quack server — falls back to `DUCKDB_QUACK_TOKEN`. */
    token?: string;
    /** Table receiving the entries (default `'_audit_'`). */
    table?: string;
    /**
     * Rows kept, as a duration (`'90d'`). `false` → never purge.
     * Omitted → mirrors `audit.retention`, so both copies follow one policy.
     */
    ttl?: string | false;
    /** How often the DuckDB purge runs (default `'1h'`). */
    purgeEvery?: string;
    /**
     * Bound on the engine's in-memory write queue (default: the engine's own 64).
     * Past it, `ingest()` waits instead of growing the process.
     */
    maxQueuedBatches?: number;
    /** Where a failed background write reports itself (default `console.error`). */
    onError?: (error: Error) => void;
};

/** `false` → explicitly disabled (overrides `server.audit.quack`). */
export type AuditQuackConfig = false | AuditQuackOptions;

type Resolved = {
    url: string;
    token?: string;
    table: string;
    ttl?: string;
    purgeEvery: string;
    maxQueuedBatches?: number;
    onError: (error: Error) => void;
};

type Retention = { stop(): void };

type Sink = {
    options: Resolved;
    db: any;
    opening: Promise<any> | null;
    retention: Retention | null;
    inflight: Set<Promise<void>>;
};

type DuckdbModule = typeof import("@anteros/duckdb");

const DEFAULT_TABLE = "_audit_";
const DEFAULT_PURGE_EVERY = "1h";

const sinks = new Map<string, Sink>();
let duckdb: DuckdbModule | null = null;

/** `quack://host:port` is the shape people write; Quack parses `quack:host:port`. */
function normaliseUrl(url: string): string {
    const trimmed = url.trim();
    return /^quack:\/\//i.test(trimmed) ? `quack:${trimmed.slice("quack://".length)}` : trimmed;
}

/**
 * Resolve the DuckDB mirror — **the tenant always wins**, `server.audit.quack` is
 * only the fallback. Returns `null` when disabled (or misconfigured, with a log:
 * a broken audit mirror must never refuse a boot).
 */
function resolveAuditQuack(tenant: Tenant): Resolved | null {
    const raw: AuditQuackConfig | undefined = tenant.audit?.quack !== undefined
        ? tenant.audit.quack
        : cfg.server?.audit?.quack;

    if (raw === undefined || raw === false) return null;

    if (typeof raw !== "object" || !raw.url?.trim()) {
        console.error(`Invalid audit.quack for tenant '${tenant.id}' — 'url' is required`);
        return null;
    }

    const onError = raw.onError ?? ((error: Error) => {
        console.error(`Audit quack write failed (${tenant.id})`, error?.message ?? error);
    });

    // Retention: explicit value wins (including `false`), otherwise the mirror
    // follows the database policy so both copies are pruned alike.
    const retention = raw.ttl !== undefined ? raw.ttl : resolveAuditRetention(tenant);
    let ttl: string | undefined;
    if (retention !== undefined && retention !== false) {
        if (parseDuration(retention) === null) {
            console.error(`Invalid audit.quack ttl '${retention}' — expected a duration like '90d' or '24h'`);
        } else {
            ttl = retention;
        }
    }

    return {
        url: normaliseUrl(raw.url),
        ...(raw.token ? { token: raw.token } : {}),
        table: raw.table?.trim() || DEFAULT_TABLE,
        ...(ttl ? { ttl } : {}),
        purgeEvery: raw.purgeEvery?.trim() || DEFAULT_PURGE_EVERY,
        ...(raw.maxQueuedBatches !== undefined ? { maxQueuedBatches: raw.maxQueuedBatches } : {}),
        onError,
    };
}

function getSink(key: string, options: Resolved): Sink {
    let sink = sinks.get(key);
    if (!sink) {
        sink = { options, db: null, opening: null, retention: null, inflight: new Set() };
        sinks.set(key, sink);
    } else {
        // Options may change between boots / tests — always latest wins
        sink.options = options;
    }
    return sink;
}

/** Open the instance once, eagerly: a bad url/path must fail in the log, not on entry 42. */
function openSink(sink: Sink): Promise<any> {
    if (sink.db) return Promise.resolve(sink.db);
    if (sink.opening) return sink.opening;

    sink.opening = (async () => {
        duckdb ??= await import("@anteros/duckdb");
        const { url, token, maxQueuedBatches, onError } = sink.options;
        const remote = /^quack:/i.test(url);

        const db = new duckdb.DuckdbQuackInstance({
            // A local path opens its own database; a quack: url attaches the server.
            ...(remote ? { url, ...(token ? { token } : {}) } : { dbPath: url }),
            ...(maxQueuedBatches !== undefined ? { maxQueuedBatches } : {}),
            onError,
        });

        await db.exec("SELECT 1"); // materialise the connection (and the attach)

        sink.db = db;
        return db;
    })().catch((error) => {
        sink.opening = null; // a transient failure is retried on the next entry
        sink.options.onError(error instanceof Error ? error : new Error(String(error)));
        throw error;
    });

    return sink.opening;
}

/**
 * Arm the purge once the table exists — `ingest()` creates it, so a `retention()`
 * job declared before the first write would run its `DELETE` on a missing table.
 */
function ensureRetention(sink: Sink): void {
    if (sink.retention || !sink.db) return;
    const { table, ttl, purgeEvery, onError } = sink.options;
    if (!ttl) return;
    try {
        sink.retention = sink.db.retention({ table, column: "ts", ttl, every: purgeEvery, runOnStart: true, onError });
    } catch (error: any) {
        onError(error instanceof Error ? error : new Error(String(error)));
    }
}

/**
 * Mirror activities into the tenant's DuckDB table — opt-in, fire-and-forget:
 * it never blocks the caller, never throws, and never touches `_audit_`.
 *
 * Entries arrive **already redacted** (the caller is the audit choke point), so the
 * mirror carries exactly what the collection holds. The default columns are
 * `id / ts / data (json)`: the whole entry goes in `data`, `ts` is a real column so
 * retention can purge it, and `id` is generated by the engine.
 *
 * The returned promise settles once the rows are queued — or **written**, when
 * `options.flush` is set (the engine is the only copy). It never rejects.
 */
function writeAuditQuack(
    tenant: Tenant | null | undefined,
    activities: unknown[],
    options?: { flush?: boolean },
): Promise<void> {
    if (!tenant || !activities?.length) return Promise.resolve();

    const resolved = resolveAuditQuack(tenant);
    if (!resolved) return Promise.resolve();

    const key = `${tenant.id}:${resolved.url}:${resolved.table}`;
    const sink = getSink(key, resolved);
    const rows = activities.map((entry: any) => ({
        ts: entry?.ts instanceof Date ? entry.ts : new Date(),
        data: entry,
    }));

    const task = openSink(sink)
        .then(async (db) => {
            await db.ingest({ table: sink.options.table, rows });
            // The table exists from here on — safe to arm the purge
            ensureRetention(sink);
            // `ingest()` only queues: wait for the engine when this is the only copy
            if (options?.flush) await db.flush();
        })
        .catch((error) => {
            sink.options.onError(error instanceof Error ? error : new Error(String(error)));
        });

    sink.inflight.add(task);
    const done = () => sink.inflight.delete(task);
    task.then(done, done);
    return task;
}

/**
 * Wait for every queued row, then close the instances (graceful shutdown).
 * A later write reopens a fresh instance, so calling this in tests is safe.
 */
async function stopAuditQuack(): Promise<void> {
    for (const sink of sinks.values()) {
        await Promise.allSettled([...sink.inflight]);
        sink.inflight.clear();

        if (sink.retention) {
            try { sink.retention.stop(); } catch { /* already stopped */ }
            sink.retention = null;
        }
        if (sink.db) {
            // `close()` drains the engine's own queue (bounded by `closeTimeoutMs`)
            try { await sink.db.close(); } catch { /* already closed */ }
            sink.db = null;
        }
        sink.opening = null;
    }
}

export { resolveAuditQuack, writeAuditQuack, stopAuditQuack };
