import type { MongoClientOptions } from "mongodb";

/** When to run replication — either a cron expression or a fixed interval. */
export type ReplicationSchedule =
    | { cron: string }
    | { interval: string | number };

/**
 * Initial synchronization mode — how replication starts when no `_replication_`
 * state exists yet.
 * - `"full"` — backfill everything (default)
 * - `"skip"` — ignore existing documents, start from now
 * - `"latest"` — start from the latest `key` in the source
 * - ISO string / `Date` — start from this date
 */
export type ReplicationInitialSync = "full" | "skip" | "latest" | (string & {}) | Date;

/** A destination database that receives replicated documents. */
export type ReplicationDestination = {
    /** Unique identifier — used as the `_replication_` state key (required). */
    id: string;
    /** MongoDB connection string (required). */
    uri: string;
    /** Database name override — defaults to the name in the URI. */
    name?: string;
    /** Extra MongoDB client options (pool size, timeouts…). */
    options?: MongoClientOptions;
    /** Restrict replication to these collection slugs (default: all enabled). */
    collections?: string[];
    /** Turn this destination off without removing it. */
    enabled?: boolean;
};

/** Per-tenant replication configuration (source → destination, one-way). */
export type ReplicationConfig = {
    /** Enable/disable replication for this scope (default: true when `destinations` is non-empty). */
    enabled?: boolean;
    /** Scheduling — `{ cron }` or `{ interval }` (default: every 5 minutes). */
    schedule?: ReplicationSchedule;
    /** Date key used for incremental replication (default: `'updatedAt'`). */
    key?: string;
    /**
     * Rewind the cursor by this many milliseconds on each run, so documents
     * written slightly out of order (clock skew) are not missed (default: 0).
     */
    lookback?: number;
    /** Documents transferred per batch (default: 1000). */
    batchSize?: number;
    /** Run a first replication right after boot (default: true). */
    runOnBoot?: boolean;
    /**
     * How the initial synchronization starts when no `_replication_` state exists
     * yet (default: `'full'`). Use `'skip'` or `'latest'` to avoid the full
     * backfill when the destination is already pre-loaded (e.g. via `mongorestore`).
     */
    initialSync?: ReplicationInitialSync;
    /** Destination databases (required). */
    destinations: ReplicationDestination[];
};

/** Per-collection opt-in replication. */
export type CollectionReplicationConfig = {
    /** Opt this collection into replication (required). */
    enabled: boolean;
    /** Date key override — defaults to `replication.key`. */
    key?: string;
    /** Initial sync override — defaults to `replication.initialSync`. */
    initialSync?: ReplicationInitialSync;
};

export type ReplicationStatus = "idle" | "running" | "success" | "error";

/** Cursor of the last replicated document — `value` is the date key, `id` the tie-breaker. */
export type ReplicationCursor = {
    value: Date | null;
    id: any;
};

export type ReplicationStats = {
    inserted: number;
    updated: number;
    deleted: number;
    failed: number;
    batches: number;
    durationMs: number;
};

/** State document persisted in `_replication_`, one per (tenant, destination, collection). */
export type ReplicationState = {
    _id: string;
    type: "state";
    tenant: string;
    destination: string;
    collection: string;
    key: string;
    cursor: ReplicationCursor;
    status: ReplicationStatus;
    lastRunAt: Date | null;
    lastError: string | null;
    stats: ReplicationStats;
    createdAt?: Date;
    updatedAt: Date;
};

/** Tombstone document persisted in `_replication_` when a replicated document is deleted. */
export type ReplicationDeleteMarker = {
    _id: string;
    type: "delete";
    tenant: string;
    collection: string;
    docId: string;
    deletedAt: Date;
    /** Destination ids that already applied the delete. */
    synced: string[];
    updatedAt: Date;
};

/** Scope of a `replication.reset()` call. */
export type ReplicationResetOptions = {
    /** Only reset this destination id (default: every destination). */
    destination?: string;
    /** Only reset this collection slug (default: every replicated collection). */
    collection?: string;
    /**
     * Also delete pending delete tombstones (default: true). Ignored when
     * `destination` is set — tombstones are shared across destinations.
     */
    tombstones?: boolean;
};

/** Result of a `replication.reset()` call. */
export type ReplicationResetResult = {
    tenant: string;
    /** State documents deleted (one per destination + collection). */
    state: number;
    /** Delete tombstones deleted. */
    tombstones: number;
};

/**
 * Where to (re)start replication from — accepted by `replication.seed()`.
 * - `"now"` — start from now (same as `initialSync: 'skip'`)
 * - `"latest"` — start from the latest `key` in the source
 * - ISO string / `Date` — start from this date
 */
export type ReplicationSeedValue = "now" | "latest" | (string & {}) | Date;

/** Scope of a `replication.seed()` call. */
export type ReplicationSeedOptions = {
    /** Only seed this destination id (default: every destination). */
    destination?: string;
    /** Only seed this collection slug (default: every replicated collection). */
    collection?: string;
    /** Optional `_id` tie-breaker for the cursor. */
    id?: any;
};

/** Result of a `replication.seed()` call. */
export type ReplicationSeedResult = {
    tenant: string;
    /** State documents written (one per destination + collection). */
    seeded: number;
};

/** Shape of the `replication` namespace exported by the package (multi-tenant). */
export type ReplicationApi = {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    now: (tenantId?: string) => Promise<ReplicationRunResult[]>;
    state: (tenantId: string, destinationId?: string, collection?: string) => Promise<ReplicationState[]>;
    reset: (tenantId: string, opts?: ReplicationResetOptions) => Promise<ReplicationResetResult>;
    seed: (tenantId: string, value: ReplicationSeedValue, opts?: ReplicationSeedOptions) => Promise<ReplicationSeedResult>;
};

/**
 * Tenant-scoped replication API — like `rest`, the tenant is implicit. This is
 * the `replication` passed to lifecycle hooks. Engine control (`start`/`stop`)
 * stays on the global `ReplicationApi`.
 */
export type TenantReplicationApi = {
    now: () => Promise<ReplicationRunResult[]>;
    state: (destinationId?: string, collection?: string) => Promise<ReplicationState[]>;
    reset: (opts?: ReplicationResetOptions) => Promise<ReplicationResetResult>;
    seed: (value: ReplicationSeedValue, opts?: ReplicationSeedOptions) => Promise<ReplicationSeedResult>;
};

/** Outcome of a single (tenant, destination, collection) replication. */
export type ReplicationRunResult = {
    tenant: string;
    destination: string;
    collection: string;
    inserted: number;
    updated: number;
    deleted: number;
    failed: number;
    batches: number;
    durationMs: number;
    error?: string;
};
