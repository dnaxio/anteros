import { MongoClient, ObjectId, type Db } from "mongodb";
import { cfg } from "../server/config";
import { getTenant } from "./tenant";
import { useRest } from "./rest";
import { logger } from "../utils/logger";
import * as os from "node:os";
import type { Collection } from "../types/collection";
import type { Tenant } from "../types/tenant";
import type {
    ReplicationConfig,
    ReplicationDestination,
    ReplicationInitialSync,
    ReplicationMetaName,
    ReplicationResetOptions,
    ReplicationResetResult,
    ReplicationRunResult,
    ReplicationSeedOptions,
    ReplicationSeedResult,
    ReplicationSeedValue,
    ReplicationState,
    ReplicationStats,
} from "../types/replication";
import { AUDIT_TTL_INDEX, resolveAuditRetention } from "./audit";
import { WORKFLOW_RUNS_TTL_INDEX, resolveWorkflowsRetention } from "../lib/workflow";
import { agentMemoryCollections } from "../lib/agents";
import { syncTtlRetention } from "./ttl";

const META_COLLECTION = "_replication_";
const DEFAULT_KEY = "updatedAt";
const DEFAULT_BATCH = 1000;
/** MongoDB `bulkWrite` is capped per call — split batches into chunks of this size. */
const BULK_CHUNK = 1000;
/** Distributed-lock TTL used to guard a run across cluster workers. */
const LOCK_TTL = 5 * 60_000;
/** How often a watcher persists its resume token (bounded write rate on `_replication_`). */
const STATE_FLUSH_MS = 5_000;
/** Reopen delay of a failed change stream, doubling up to `WATCH_MAX_BACKOFF_MS`. */
const WATCH_BACKOFF_MS = 1_000;
const WATCH_MAX_BACKOFF_MS = 30_000;
/**
 * Driver / server errors that mean the resume token is unusable and the stream must
 * start from a fresh position: `CursorNotFound`, `ChangeStreamHistoryLost`,
 * `ChangeStreamInvalidated`, `ChangeStreamFatalError`.
 */
const RESUME_TOKEN_ERRORS = new Set([43, 280, 286, 40573]);
/**
 * How long a boot gives the collections it could not take at once — the ones a
 * catch-up run is holding for the time of its pass. Shared by all of them, and
 * **after** a first pass that takes everything free: a collection another node's
 * stream owns must delay neither the boot nor its neighbours.
 */
const WATCH_LOCK_WAIT_MS = 5_000;
const WATCH_LOCK_RETRY_MS = 500;

/**
 * Framework collections replication covers **by default**, with the date key each
 * one's **backfill** is read with (the stream itself needs no key). `'vars'` is
 * handled apart, per namespace, and `'memory'` covers the agent memory collections
 * — whose names the tenant chooses, so they come from the agent registry instead
 * (see below).
 */
const META_COLLECTIONS: Record<Exclude<ReplicationMetaName, 'vars' | 'memory'>, { slug: string; key: string }> = {
    audit: { slug: "_audit_", key: "ts" },
    workflows: { slug: "_workflows_", key: "updatedAt" },
    locks: { slug: "_locks_", key: "expiresAt" },
    replication: { slug: "_replication_", key: "updatedAt" },
};

/**
 * Everything replicated for a tenant: the collections that opted in, plus the
 * framework's meta collections — which are replicated **by default** and left out
 * with `replication.exclude: ['audit', 'locks', …]`.
 */
function replicatedCollectionsFor(tenantId: string, config: ReplicationConfig): Collection[] {
    const excluded = new Set<string>(config.exclude ?? []);

    const collections: Collection[] = [
        ...(cfg.collections ?? []).filter((c) => c._tenant_ === tenantId && c.replication?.enabled),
        ...(cfg.fileCollections ?? [])
            .filter((c) => c._tenant_ === tenantId && c.replication?.enabled)
            .map((c) => ({ slug: c.slug, _tenant_: tenantId, replication: c.replication }) as any),
    ];

    for (const [name, meta] of Object.entries(META_COLLECTIONS)) {
        if (excluded.has(name)) continue;
        // Each meta collection knows its own date key (`_audit_` is indexed on `ts`),
        // so a tenant-level `key` never breaks it
        collections.push({
            slug: meta.slug,
            _tenant_: tenantId,
            replication: { enabled: true, key: meta.key },
        } as any);
    }

    if (!excluded.has('vars')) {
        // Every namespace, minus the ones explicitly opting out — a per-document
        // filter: `replication.exclude: ['vars']` is the blunt way out.
        const optedOut = (cfg.vars ?? [])
            .filter((v) => v._tenant_ === tenantId && v.replication?.enabled === false)
            .map((v) => v.namespace);
        collections.push({
            slug: "_vars_",
            _tenant_: tenantId,
            replication: { enabled: true },
            _baseFilter_: { ns: { $nin: optedOut } },
        } as any);
    }

    // Agent memory collections — the tenant names them, the agent loader publishes
    // them (`cfg.agentMemories`). `exclude: ['memory']` covers all of them.
    if (!excluded.has('memory')) {
        for (const slug of agentMemoryCollections(tenantId)) {
            // A memory collection may also be declared as a collection: one entry only
            if (collections.some((collection) => collection.slug === slug)) continue;
            collections.push({
                slug,
                _tenant_: tenantId,
                replication: { enabled: true, key: "updatedAt" },
            } as any);
        }
    }

    return collections;
}

type Runtime = {
    tenantId: string;
    destination: ReplicationDestination;
    client: MongoClient;
    db: Db;
    running: boolean;
};

const runtimes = new Map<string, Runtime>();
/** Ensured indexes / collections — avoids re-creating them on every run. */
const ensured = new Set<string>();
let started = false;

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

function resolveConfig(tenant: Tenant): ReplicationConfig | null {
    const config = tenant.replication;
    if (!config) return null;
    if (config.enabled === false) return null;
    if (!config.destinations?.length) return null;
    validateReplication(config);
    return config;
}

function validateReplication(config: ReplicationConfig): void {
    for (const destination of config.destinations ?? []) {
        if (!destination.id || !String(destination.id).trim()) {
            throw new Error("replication.destinations[].id is required");
        }
        if (!destination.uri || !String(destination.uri).trim()) {
            throw new Error(`replication.destinations['${destination.id}'].uri is required`);
        }
    }
}

function resolveKey(collection: Collection, config: ReplicationConfig): string {
    return collection.replication?.key ?? config.key ?? DEFAULT_KEY;
}

function stateIdFor(tenantId: string, destinationId: string, collection: string): string {
    return `rep:${tenantId}:${destinationId}:${collection}`;
}

/**
 * The single lock of a (destination, collection) pair — taken by whichever writer
 * owns that collection: a one-shot run for the duration of its pass, or a change
 * stream for as long as it watches.
 */
function watchLockName(destinationId: string, slug: string): string {
    return `replication:${destinationId}:${slug}`;
}

function filterCollections(collections: Collection[], destination: ReplicationDestination): Collection[] {
    if (!destination.collections?.length) return collections;
    const wanted = new Set(destination.collections);
    return collections.filter((c) => wanted.has(c.slug));
}

function runtimesFor(tenantId: string): Runtime[] {
    return [...runtimes.values()].filter((rt) => rt.tenantId === tenantId && rt.destination.enabled !== false);
}

/* ------------------------------------------------------------------ */
/* Incremental helpers                                                 */
/* ------------------------------------------------------------------ */

/**
 * `key > cursor.value` OR (`key == cursor.value` AND `_id > cursor.id`).
 * The `_id` tie-breaker guarantees no document is skipped or duplicated when
 * several documents share the same timestamp.
 */
function incrementalFilter(key: string, cursor: { value: any; id: any } | null): Record<string, any> {
    if (!cursor || cursor.value === null || cursor.value === undefined) return {};
    return {
        $or: [
            { [key]: { $gt: cursor.value } },
            { [key]: cursor.value, _id: { $gt: cursor.id } },
        ],
    };
}

/** Combine a collection's base filter (if any) with the incremental cursor filter. */
function mergedFilter(base: Record<string, any> | undefined, incremental: Record<string, any>): Record<string, any> {
    if (!base) return incremental;
    return Object.keys(incremental).length ? { $and: [base, incremental] } : base;
}

/**
 * Resolve the initial cursor from `initialSync` — used only when no
 * `_replication_` state exists yet (first run), so a pre-loaded destination can
 * skip the full backfill.
 * - `"full"` → no filter (backfill everything)
 * - `"skip"` → start from now
 * - `"latest"` → max `(key, _id)` of the source
 * - ISO string / `Date` → start from that date
 */
async function resolveInitialSync(source: any, key: string, initialSync: ReplicationInitialSync): Promise<{ value: any; id: any } | null> {
    if (initialSync === "full") return null;
    if (initialSync === "skip") return { value: new Date(), id: null };
    if (initialSync === "latest") {
        const docs = await source.find().sort({ [key]: -1, _id: -1 } as any).limit(1).toArray();
        const last = docs[0];
        if (last) return { value: last[key] ?? null, id: last._id ?? null };
        return null;
    }
    const value = initialSync instanceof Date ? initialSync : new Date(initialSync);
    return { value, id: null };
}

function toId(value: any): any {
    if (value instanceof ObjectId) return value;
    if (typeof value === "string" && ObjectId.isValid(value)) return new ObjectId(value);
    return value;
}

/** Retry a transient operation with exponential backoff. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 250): Promise<T> {
    let lastError: any;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err: any) {
            lastError = err;
            if (i < attempts - 1) await Bun.sleep(baseMs * Math.pow(2, i));
        }
    }
    throw lastError;
}

async function ensureIndex(db: Db, slug: string, key: string, scope: string): Promise<void> {
    const cacheKey = `${scope}:${db.databaseName}:${slug}:${key}`;
    if (ensured.has(cacheKey)) return;
    ensured.add(cacheKey);
    try {
        const exists = await db.listCollections({ name: slug }).toArray();
        if (!exists.length) {
            try { await db.createCollection(slug); } catch { /* created concurrently */ }
        }
        const col = db.collection(slug);
        try { await col.createIndex({ [key]: 1, _id: 1 }); } catch { /* ignore */ }
        try { await col.createIndex({ createdAt: -1, updatedAt: -1 }); } catch { /* ignore */ }
    } catch (err: any) {
        logger.file("warn", "replication: failed to ensure collection/index", { collection: slug, scope, error: err?.message });
    }
}

/* ------------------------------------------------------------------ */
/* State (`_replication_`)                                             */
/* ------------------------------------------------------------------ */

async function saveState(
    meta: any,
    stateId: string,
    tenant: Tenant,
    runtime: Runtime,
    collection: Collection,
    key: string,
    cursor: { value: any; id: any },
    stats: ReplicationStats,
    status: ReplicationState["status"],
    error: string | null,
): Promise<void> {
    const now = new Date();
    await meta.updateOne(
        { _id: stateId },
        {
            $set: {
                type: "state",
                tenant: tenant.id,
                destination: runtime.destination.id,
                collection: collection.slug,
                key,
                cursor,
                lastRunAt: now,
                status,
                error,
                stats: { ...stats },
                // Which process owns this run — `reusePort`/forked deployments can
                // see at a glance which worker is replicating (the lock holds the
                // same information)
                pid: process.pid,
                hostname: os.hostname(),
                updatedAt: now,
            },
            $setOnInsert: { createdAt: now },
        },
        { upsert: true },
    );
}

async function markError(meta: any, stateId: string, error: string): Promise<void> {
    const now = new Date();
    await meta.updateOne(
        { _id: stateId },
        { $set: { status: "error", error, updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true },
    ).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Bulk upsert                                                         */
/* ------------------------------------------------------------------ */

async function bulkUpsert(target: any, docs: any[]): Promise<{ inserted: number; updated: number; failed: number }> {
    let inserted = 0;
    let updated = 0;
    let failed = 0;
    for (let i = 0; i < docs.length; i += BULK_CHUNK) {
        const slice = docs.slice(i, i + BULK_CHUNK);
        const ops = slice.map((doc) => ({
            replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
        }));
        const res: any = await withRetry(() => target.bulkWrite(ops as any, { ordered: false }));
        inserted += res.upsertedCount ?? 0;
        updated += res.matchedCount ?? 0;
        const writeErrors = (res as any).getWriteErrors?.() ?? [];
        failed += writeErrors.length;
        if (writeErrors.length) {
            logger.file("warn", "replication: bulkWrite errors", {
                count: writeErrors.length,
                sample: writeErrors.slice(0, 5).map((e: any) => e?.errmsg),
            });
        }
    }
    return { inserted, updated, failed };
}

/* ------------------------------------------------------------------ */
/* Replication                                                         */
/* ------------------------------------------------------------------ */

async function replicateCollection(
    tenant: Tenant,
    runtime: Runtime,
    collection: Collection,
    config: ReplicationConfig,
    key: string,
    meta: any,
): Promise<ReplicationStats> {
    const startedAt = Date.now();
    const stateId = stateIdFor(tenant.id, runtime.destination.id, collection.slug);

    // A run only seeds a destination that has never been backfilled (a fresh
    // tenant, or after `replication.reset()`). Once a state document exists a
    // change stream owns the collection and is already up to date — backfilling on
    // top of it would let a stale read overwrite a newer event. The
    // `replication:<destination>:<collection>` lock in `replicateTenant` is what
    // keeps the two writers apart.
    if (await meta.findOne({ _id: stateId })) {
        return { inserted: 0, updated: 0, deleted: 0, failed: 0, batches: 0, durationMs: Date.now() - startedAt };
    }

    const { stats, cursor } = await backfillCollection(tenant, runtime, collection, config, key, meta);

    stats.durationMs = Date.now() - startedAt;
    await saveState(meta, stateId, tenant, runtime, collection, key, cursor, stats, "success", null);
    return stats;
}

/**
 * Copy the source into the destination, from the position stored in `_replication_`.
 *
 * This is the **backfill**: the one-shot run a stream performs on a cold start
 * (no resume token yet — a fresh tenant, `seed()`, `reset()`), and what
 * `replication.now()` runs for a collection nobody has seeded. The indexes, the
 * mirrored audit/workflow retention, the `initialSync` seeding and the batched
 * upserts all live here.
 *
 * It leaves the state `running`: the caller owns the run's final status.
 */
async function backfillCollection(
    tenant: Tenant,
    runtime: Runtime,
    collection: Collection,
    config: ReplicationConfig,
    key: string,
    meta: any,
): Promise<{ stats: ReplicationStats; cursor: { value: any; id: any } }> {
    const stateId = stateIdFor(tenant.id, runtime.destination.id, collection.slug);
    const state = (await meta.findOne({ _id: stateId })) as ReplicationState | null;
    let cursor = state?.cursor ?? { value: null, id: null };

    const source = tenant.database.db!.collection(collection.slug);
    const target = runtime.db.collection(collection.slug);
    const batchSize = config.batchSize ?? DEFAULT_BATCH;
    const startedAt = Date.now();
    const stats: ReplicationStats = { inserted: 0, updated: 0, deleted: 0, failed: 0, batches: 0, durationMs: 0 };

    await ensureIndex(tenant.database.db!, collection.slug, key, "source");
    await ensureIndex(runtime.db, collection.slug, key, `destination:${runtime.destination.id}`);

    // Mirror the source's audit/workflow retention on the destination as well: the
    // stream already propagates the TTL deletes one by one, but the index keeps a
    // restored or re-seeded destination pruned on its own.
    if (collection.slug === '_audit_' || collection.slug === '_workflows_') {
        const isAudit = collection.slug === '_audit_';
        const retention = isAudit ? resolveAuditRetention(tenant) : resolveWorkflowsRetention(tenant);
        if (retention !== undefined) {
            await syncTtlRetention(runtime.db, {
                collection: collection.slug,
                index: isAudit ? AUDIT_TTL_INDEX : WORKFLOW_RUNS_TTL_INDEX,
                field: isAudit ? 'ts' : 'completedAt',
                retention,
                label: `${collection.slug} (destination)`,
            });
        }
    }

    // Resolve the initial cursor on the first run — `initialSync` lets a
    // pre-loaded destination skip the full backfill (`full` = default).
    if (!state) {
        const initialSync = collection.replication?.initialSync ?? config.initialSync;
        if (initialSync !== undefined && initialSync !== "full") {
            const seeded = await resolveInitialSync(source, key, initialSync);
            if (seeded) cursor = seeded;
        }
    }

    // Optional per-collection document filter (used by `_vars_` to replicate only
    // the opted-in namespaces).
    const baseFilter = (collection as any)._baseFilter_ as Record<string, any> | undefined;

    // Inserts and updates are copied the same way: both refresh the date key, so
    // the incremental cursor picks them up.
    while (true) {
        const docs = await source
            .find(mergedFilter(baseFilter, incrementalFilter(key, cursor)) as any)
            .sort({ [key]: 1, _id: 1 } as any)
            .limit(batchSize)
            .toArray();
        if (!docs.length) break;

        const { inserted, updated, failed } = await bulkUpsert(target, docs);
        stats.inserted += inserted;
        stats.updated += updated;
        stats.failed += failed;
        stats.batches += 1;

        const last: any = docs[docs.length - 1];
        if (!last) break;
        cursor = { value: last[key] ?? null, id: last._id ?? null };

        await saveState(meta, stateId, tenant, runtime, collection, key, cursor, stats, "running", null);
        if (docs.length < batchSize) break;
    }

    stats.durationMs = Date.now() - startedAt;
    return { stats, cursor };
}

/* ------------------------------------------------------------------ */
/* Change streams                                                      */
/* ------------------------------------------------------------------ */

/** One watcher per (tenant, destination) — it tails every collection in parallel. */
type Watcher = { stop: () => Promise<void> };

const watchers = new Map<string, Watcher>();
/** Change-stream support, probed once per (tenant, database). */
const changeStreamSupport = new Map<string, boolean>();

/**
 * Does this source serve change streams? They only exist on a replica set or a
 * sharded cluster — a standalone `mongod` raises `$changeStream is only supported
 * on replica sets` on the first `watch()`.
 */
async function supportsChangeStreams(tenantId: string, db: Db): Promise<boolean> {
    const cacheKey = `${tenantId}:${db.databaseName}`;
    const cached = changeStreamSupport.get(cacheKey);
    if (cached !== undefined) return cached;

    let supported = false;
    try {
        const hello: any = await db.admin().command({ hello: 1 });
        supported = Boolean(hello?.setName) || hello?.msg === "isdbgrid";
    } catch (err: any) {
        logger.file("warn", "replication: change-stream capability probe failed", { tenant: tenantId, error: err?.message });
    }
    changeStreamSupport.set(cacheKey, supported);
    return supported;
}

/**
 * The source's current operation time — the `startAtOperationTime` of a fresh
 * stream, so a first run replays from "now" rather than from the oplog head at
 * whatever instant the cursor happened to be created.
 */
async function currentOperationTime(db: Db): Promise<any | null> {
    try {
        const hello: any = await db.admin().command({ hello: 1 });
        return hello?.operationTime ?? null;
    } catch {
        return null;
    }
}

/**
 * Change-stream pipeline: the collection's base filter, read off the **post-image**.
 *
 * Change streams `$match` the *event*, whose fields are not the document's (`ns` is
 * the namespace of the event, not the `ns` field of a `_vars_` document), so every
 * condition is prefixed with `fullDocument`. A `delete` event has no post-image and
 * `$nin` / `$eq` match a missing field, so a delete of a filtered-out document
 * simply becomes a no-op `deleteOne` on the target.
 */
function watchPipeline(collection: Collection): Record<string, any>[] {
    const base = (collection as any)._baseFilter_ as Record<string, any> | undefined;
    if (!base || !Object.keys(base).length) return [];
    const match: Record<string, any> = {};
    for (const [field, condition] of Object.entries(base)) match[`fullDocument.${field}`] = condition;
    return [{ $match: match }];
}

/** Persist the watcher's position — the resume token, and nothing else. */
async function saveWatchState(
    meta: any,
    stateId: string,
    tenant: Tenant,
    runtime: Runtime,
    collection: Collection,
    key: string,
    resumeToken: any,
    stats: ReplicationStats,
    status: ReplicationState["status"],
): Promise<void> {
    const now = new Date();
    const set: Record<string, any> = {
        type: "state",
        tenant: tenant.id,
        destination: runtime.destination.id,
        collection: collection.slug,
        key,
        status,
        lastRunAt: now,
        stats: { ...stats },
        pid: process.pid,
        hostname: os.hostname(),
        updatedAt: now,
    };
    if (resumeToken) set.resumeToken = resumeToken;

    await meta.updateOne(
        { _id: stateId },
        // `cursor` is the backfill position, `resumeToken` the stream's: neither
        // overwrites the other, so `replication.now()` keeps a resumable seed
        { $set: set, $setOnInsert: { createdAt: now, cursor: { value: null, id: null } } },
        { upsert: true },
    );
}

/** Mirror one change-stream event on the destination. */
async function applyChangeEvent(
    target: any,
    collection: Collection,
    event: any,
): Promise<{ written: boolean; deleted: boolean }> {
    switch (event?.operationType) {
        case "insert":
        case "update":
        case "replace": {
            const doc = event.fullDocument;
            // `updateLookup` could not resolve the document (it was deleted in the
            // meantime): the `delete` event that follows removes it from the target
            if (!doc) return { written: false, deleted: false };
            await withRetry(() => target.replaceOne({ _id: doc._id }, doc, { upsert: true }));
            return { written: true, deleted: false };
        }
        case "delete": {
            const id = event.documentKey?._id;
            if (id === undefined) return { written: false, deleted: false };
            // `_id` comes back typed from the oplog: an `ObjectId` is deleted as an
            // `ObjectId`, with no string round-trip
            await withRetry(() => target.deleteOne({ _id: toId(id) }));
            return { written: false, deleted: true };
        }
        default:
            // `drop` / `rename` / `dropDatabase` / `invalidate`: applying them would
            // destroy data on the destination on a whim — report instead
            logger.file("warn", "replication: unhandled change-stream event", {
                collection: collection.slug,
                operationType: event?.operationType,
                ns: event?.ns,
            });
            return { written: false, deleted: false };
    }
}

/**
 * Tail one collection and mirror every event on the destination, until `stopped`
 * is set.
 *
 * Deletes come straight from the oplog — including the TTL expiries of `_audit_` /
 * `_workflows_`, which no hook sees.
 *
 * A transient driver error reopens the stream from the last **persisted** resume
 * token: at most `STATE_FLUSH_MS` of events are replayed, and every write is an
 * idempotent `replaceOne` / `deleteOne`, so replaying is harmless.
 */
async function watchCollection(
    tenant: Tenant,
    runtime: Runtime,
    collection: Collection,
    config: ReplicationConfig,
    key: string,
    meta: any,
    stopped: { value: boolean },
    openStreams: Set<any>,
): Promise<void> {
    const stateId = stateIdFor(tenant.id, runtime.destination.id, collection.slug);
    const source = tenant.database.db!.collection(collection.slug);
    const target = runtime.db.collection(collection.slug);
    const pipeline = watchPipeline(collection);
    const stats: ReplicationStats = { inserted: 0, updated: 0, deleted: 0, failed: 0, batches: 0, durationMs: 0 };

    let state = (await meta.findOne({ _id: stateId })) as ReplicationState | null;
    let token: any = state?.resumeToken ?? null;
    let startAt: any = null;
    let lastFlush = 0;

    // Nothing to resume from (first run, `seed()`, `reset()`): backfill first. The
    // stream's starting point is taken **before** it, so a write that lands while
    // the backfill runs is replayed by the stream afterwards instead of being lost
    // — the upsert is idempotent, a lost event is not.
    if (!token) {
        startAt = await currentOperationTime(tenant.database.db!);
        try {
            const { stats: backfill } = await backfillCollection(tenant, runtime, collection, config, key, meta);
            Object.assign(stats, { ...backfill, deleted: 0 });
        } catch (err: any) {
            logger.file("error", "replication: backfill failed, watching from now", {
                tenant: tenant.id,
                destination: runtime.destination.id,
                collection: collection.slug,
                error: err?.message,
            });
        }
        state = (await meta.findOne({ _id: stateId })) as ReplicationState | null;
        token = state?.resumeToken ?? null;
    }

    let backoff = WATCH_BACKOFF_MS;
    while (!stopped.value) {
        let stream: any = null;
        try {
            stream = source.watch(pipeline as any, {
                // We replace the whole document on the target, so an update must carry
                // its post-image rather than just the delta
                fullDocument: "updateLookup",
                // No `maxAwaitTimeMS` here: it must stay below the client's `timeoutMS`
                // (the driver refuses a tailable awaitData cursor otherwise) and the
                // default 1s server-side wait is what we want anyway
                ...(token ? { resumeAfter: token } : startAt ? { startAtOperationTime: startAt } : {}),
            } as any);
            openStreams.add(stream);
            backoff = WATCH_BACKOFF_MS;

            for await (const event of stream) {
                if (stopped.value) break;
                const { written, deleted } = await applyChangeEvent(target, collection, event);
                if (written) stats.inserted += 1;
                if (deleted) stats.deleted += 1;
                if (event?._id) token = event._id;

                const now = Date.now();
                if (now - lastFlush >= STATE_FLUSH_MS) {
                    lastFlush = now;
                    await saveWatchState(meta, stateId, tenant, runtime, collection, key, token, stats, "watching");
                }
            }
        } catch (err: any) {
            if (stopped.value) break;
            const message = err?.message ?? String(err);

            // The resume token outlived the oplog window (or the replica set was
            // rolled back): the stream must restart from a fresh position, and what
            // happened in between is gone — only a full rescan brings it back
            if (RESUME_TOKEN_ERRORS.has(err?.code)) {
                logger.file("error", "replication: resume token invalid, restarting from now — run replication.reset() for a full rescan", {
                    tenant: tenant.id,
                    destination: runtime.destination.id,
                    collection: collection.slug,
                    code: err?.code,
                });
                token = null;
                startAt = await currentOperationTime(tenant.database.db!);
            } else {
                logger.file("error", "replication: change stream failed, reopening", {
                    tenant: tenant.id,
                    destination: runtime.destination.id,
                    collection: collection.slug,
                    retryInMs: backoff,
                    error: message,
                });
            }

            await markError(meta, stateId, message);
            await Bun.sleep(backoff);
            backoff = Math.min(backoff * 2, WATCH_MAX_BACKOFF_MS);
        } finally {
            if (stream) {
                openStreams.delete(stream);
                try { await stream.close(); } catch { /* already closed */ }
            }
        }
    }

    // Do not resurrect a state deleted underneath us (`reset()`): only refresh a
    // position that is still there — the next run replays from its own last durable
    // token, and every write is idempotent
    const alive = await meta.findOne({ _id: stateId }, { projection: { _id: 1 } });
    if (alive) {
        await saveWatchState(meta, stateId, tenant, runtime, collection, key, token, stats, "idle").catch(() => {});
    }
}

/**
 * Watch one destination: tail every replicated collection in parallel, each under its
 * own **`replication:<destination>:<collection>`** lock.
 *
 * That lock is the whole arbitration: a one-shot run (`replication.now()`, the boot
 * catch-up) takes the same one for the duration of its backfill, so the stream and
 * the run can never write the same collection at the same time — and two cluster
 * nodes can never tail the same collection onto the same destination.
 */
async function startWatcher(tenant: Tenant, runtime: Runtime, config: ReplicationConfig, meta: any): Promise<void> {
    const watcherKey = `${tenant.id}:${runtime.destination.id}`;
    if (watchers.has(watcherKey)) return;

    const rest = new useRest({ tenant_id: tenant.id });
    const stopped = { value: false };
    const openStreams = new Set<any>();
    const collections = filterCollections(replicatedCollectionsFor(tenant.id, config), runtime.destination);
    const locks: string[] = [];
    const running: Promise<void>[] = [];

    let heartbeat: any = null;
    const stop = async () => {
        if (stopped.value) return;
        stopped.value = true;
        if (heartbeat) clearInterval(heartbeat);
        for (const stream of openStreams) {
            try { await stream.close(); } catch { /* already closed */ }
        }
        openStreams.clear();
        await Promise.allSettled(running);
        for (const name of locks) await rest.unlock(name).catch(() => {});
        locks.length = 0;
        watchers.delete(watcherKey);
    };

    const launch = (collection: Collection) => {
        running.push(
            watchCollection(tenant, runtime, collection, config, resolveKey(collection, config), meta, stopped, openStreams)
                .catch((err) => logger.file("error", "replication: watcher stopped", {
                    tenant: tenant.id,
                    destination: runtime.destination.id,
                    collection: collection.slug,
                    error: err?.message,
                })),
        );
    };

    // First pass — no waiting: a boot never delays on a lock, and one collection held
    // elsewhere must not starve the others
    const held: Collection[] = [];
    for (const collection of collections) {
        const name = watchLockName(runtime.destination.id, collection.slug);
        try {
            await rest.lock(name, LOCK_TTL);
            locks.push(name);
            launch(collection);
        } catch {
            held.push(collection);
        }
    }

    // Second pass — what is left is held by a catch-up run, whose pass ends soon
    if (held.length && !stopped.value) {
        const deadline = Date.now() + WATCH_LOCK_WAIT_MS;
        for (const collection of held) {
            if (stopped.value) break;
            const name = watchLockName(runtime.destination.id, collection.slug);
            let acquired = false;
            while (!stopped.value && !acquired && Date.now() < deadline) {
                try {
                    await rest.lock(name, LOCK_TTL);
                    locks.push(name);
                    acquired = true;
                    launch(collection);
                } catch {
                    await Bun.sleep(WATCH_LOCK_RETRY_MS);
                }
            }
            if (!acquired) {
                logger.file("warn", "replication: collection lock unavailable, not watched here", {
                    tenant: tenant.id,
                    destination: runtime.destination.id,
                    collection: collection.slug,
                });
            }
        }
    }

    if (!running.length) {
        await stop();
        return;
    }

    // The locks are leases, not gifts: renew them, and stand down if one is lost —
    // another node took it over and replaying the same oplog twice would be worse
    heartbeat = setInterval(async () => {
        for (const name of [...locks]) {
            const res = await rest.db.collection("_locks_")
                .updateOne(
                    { _id: `${tenant.id}:${name}` as any, pid: process.pid },
                    { $set: { expiresAt: Date.now() + LOCK_TTL } },
                )
                .catch(() => null);
            if (!res || (res.matchedCount ?? 0) === 0) {
                logger.file("error", "replication: watcher lost a collection lock, stopping", {
                    tenant: tenant.id,
                    destination: runtime.destination.id,
                    lock: name,
                });
                await stop();
                return;
            }
        }
    }, Math.floor(LOCK_TTL / 3));
    (heartbeat as any)?.unref?.();

    watchers.set(watcherKey, { stop });
    logger.file("replication: watching", {
        tenant: tenant.id,
        destination: runtime.destination.id,
        collections: collections.map((collection) => collection.slug),
        pid: process.pid,
    });
}

async function replicateTenant(
    tenantId: string,
    opts?: { destinationId?: string; collection?: string },
): Promise<ReplicationRunResult[]> {
    const tenant = getTenant(tenantId);
    const config = tenant ? resolveConfig(tenant) : null;
    const mainDb = tenant?.database?.db;
    if (!tenant || !config || !mainDb) return [];

    // A one-shot copy without a stream would never see a later change — nor any
    // delete — so it is not replication: refuse rather than half-replicate.
    if (!(await supportsChangeStreams(tenantId, mainDb))) {
        logger.file("error", "replication: change streams unavailable — a replica set is required, run skipped", { tenant: tenantId });
        return [];
    }

    const collections = replicatedCollectionsFor(tenantId, config);
    const results: ReplicationRunResult[] = [];
    const meta = mainDb.collection(META_COLLECTION);
    const rest = new useRest({ tenant_id: tenantId });

    for (const runtime of runtimesFor(tenantId)) {
        if (opts?.destinationId && runtime.destination.id !== opts.destinationId) continue;
        if (runtime.running) continue;

        runtime.running = true;
        try {
            for (const collection of filterCollections(collections, runtime.destination)) {
                if (opts?.collection && collection.slug !== opts.collection) continue;
                const key = resolveKey(collection, config);
                const startedAt = Date.now();
                const totals: ReplicationStats = { inserted: 0, updated: 0, deleted: 0, failed: 0, batches: 0, durationMs: 0 };

                // One writer per (destination, collection): a change stream holds this
                // lock for as long as it watches, so a run neither writes the same
                // collection concurrently nor queues behind a long-lived stream
                const lockName = watchLockName(runtime.destination.id, collection.slug);
                let locked = false;
                try {
                    await rest.lock(lockName, LOCK_TTL);
                    locked = true;
                } catch {
                    // The stream (or another node) owns this collection: it is already up
                    // to date, and letting two writers share it is how a stale scan
                    // overwrites a fresh event
                    logger.file("replication: collection owned by another writer, skipped", {
                        tenant: tenantId,
                        destination: runtime.destination.id,
                        collection: collection.slug,
                    });
                    continue;
                }

                try {
                    const stats = await replicateCollection(tenant, runtime, collection, config, key, meta);
                    Object.assign(totals, stats);
                    totals.durationMs = Date.now() - startedAt;
                    results.push({ tenant: tenantId, destination: runtime.destination.id, collection: collection.slug, ...totals });
                } catch (err: any) {
                    const message = err?.message ?? String(err);
                    await markError(meta, stateIdFor(tenantId, runtime.destination.id, collection.slug), message);
                    logger.file("error", "replication: collection failed", {
                        tenant: tenantId, destination: runtime.destination.id, collection: collection.slug, error: message,
                    });
                    totals.durationMs = Date.now() - startedAt;
                    results.push({ tenant: tenantId, destination: runtime.destination.id, collection: collection.slug, ...totals, error: message });
                } finally {
                    if (locked) await rest.unlock(lockName).catch(() => {});
                }
            }
        } finally {
            runtime.running = false;
        }
    }

    return results;
}

/**
 * Stand a tenant's watchers down, returning the keys it stopped — so
 * `startWatchers()` can re-arm exactly those, once the position has been rewritten.
 *
 * `reset()` and `seed()` need that order: a running stream holds its position in
 * memory and would overwrite the new one on its next flush.
 */
async function stopWatchers(tenantId: string, opts?: { destinationId?: string }): Promise<string[]> {
    const stopped: string[] = [];
    for (const [key, watcher] of [...watchers]) {
        if (!key.startsWith(`${tenantId}:`)) continue;
        if (opts?.destinationId && key !== `${tenantId}:${opts.destinationId}`) continue;
        await watcher.stop().catch(() => {});
        stopped.push(key);
    }
    return stopped;
}

/** Re-arm the watchers `stopWatchers()` stopped, after the position was rewritten. */
async function startWatchers(tenantId: string, keys: string[]): Promise<void> {
    if (!keys.length) return;

    const tenant = getTenant(tenantId);
    const config = tenant ? resolveConfig(tenant) : null;
    const mainDb = tenant?.database?.db;
    if (!tenant || !config || !mainDb) return;

    const meta = mainDb.collection(META_COLLECTION);
    for (const key of keys) {
        const destinationId = key.slice(`${tenantId}:`.length);
        const runtime = runtimes.get(key);
        if (!runtime) continue;
        await startWatcher(tenant, runtime, config, meta).catch((err) =>
            logger.file("error", "replication: watcher restart failed", { tenant: tenantId, destination: destinationId, error: err?.message }),
        );
    }
}

async function replicationNow(tenantId?: string): Promise<ReplicationRunResult[]> {
    if (tenantId) return replicateTenant(tenantId);
    const all: ReplicationRunResult[] = [];
    for (const tenant of cfg.tenants ?? []) {
        all.push(...(await replicateTenant(tenant.id)));
    }
    return all;
}

async function getReplicationState(tenantId: string, destinationId?: string, collection?: string): Promise<ReplicationState[]> {
    const tenant = getTenant(tenantId);
    const db = tenant?.database?.db;
    if (!tenant || !db) return [];
    const filter: Record<string, any> = { type: "state", tenant: tenantId };
    if (destinationId) filter.destination = destinationId;
    if (collection) filter.collection = collection;
    return (await db.collection(META_COLLECTION).find(filter).toArray()) as unknown as ReplicationState[];
}

/**
 * Forget replication progress for a tenant — deletes the `_replication_` state
 * (backfill position, resume token, stats, status), so the next run starts over.
 * Destination data is never touched: only the bookkeeping is cleared, and the
 * re-armed stream cold-starts with a fresh backfill.
 *
 * Scope it with `destination` and/or `collection`.
 */
async function resetReplication(
    tenantId: string,
    opts?: ReplicationResetOptions,
): Promise<ReplicationResetResult> {
    const tenant = getTenant(tenantId);
    const db = tenant?.database?.db;
    if (!tenant || !db) return { tenant: tenantId, state: 0 };

    const meta = db.collection(META_COLLECTION);

    // A running stream holds its position in memory: standing it down **before**
    // clearing is what makes the reset stick (its next flush would restore it), and
    // re-arming it afterwards is what makes it cold-start again
    const stoppedWatchers = await stopWatchers(tenantId, { destinationId: opts?.destination }).catch(() => []);

    const stateFilter: Record<string, any> = { type: "state", tenant: tenantId };
    if (opts?.destination) stateFilter.destination = opts.destination;
    if (opts?.collection) stateFilter.collection = opts.collection;
    const stateRes = await meta.deleteMany(stateFilter);
    const state = stateRes.deletedCount ?? 0;

    logger.file("replication: reset", {
        tenant: tenantId,
        destination: opts?.destination ?? null,
        collection: opts?.collection ?? null,
        state,
    });

    // A running stream keeps its position in memory and would silently undo the reset
    // on its next flush: restart it, so it cold-starts from the cleared position
    await startWatchers(tenantId, stoppedWatchers).catch(() => {});

    return { tenant: tenantId, state };
}

/**
 * Set where a tenant's **backfill** starts, by writing the `_replication_` cursor —
 * the counterpart of `reset()`. Use it from `beforeBoot` to start from a given date
 * (or `'now'` / `'latest'`) instead of copying everything: the watch that follows
 * picks up from there, and every event after it comes from the stream anyway.
 *
 * The date field is the collection's replication key (`replication.key`, default
 * `updatedAt`). Scope with `destination` and/or `collection`.
 */
async function seedReplication(
    tenantId: string,
    value: ReplicationSeedValue,
    opts?: ReplicationSeedOptions,
): Promise<ReplicationSeedResult> {
    const tenant = getTenant(tenantId);
    const config = tenant ? resolveConfig(tenant) : null;
    const mainDb = tenant?.database?.db;
    if (!tenant || !config || !mainDb) return { tenant: tenantId, seeded: 0 };

    const meta: any = mainDb.collection(META_COLLECTION);
    const collections = replicatedCollectionsFor(tenantId, config)
        .filter((c) => !opts?.collection || c.slug === opts.collection);
    const destinations = (config.destinations ?? []).filter(
        (d) => d.enabled !== false && d.id && d.uri && (!opts?.destination || d.id === opts.destination),
    );

    let seeded = 0;
    // Same order as `reset()`: a live stream must not overwrite the seeded position
    const stoppedWatchers = await stopWatchers(tenantId, { destinationId: opts?.destination }).catch(() => []);
    for (const destination of destinations) {
        for (const collection of filterCollections(collections, destination)) {
            const key = resolveKey(collection, config);
            const source = mainDb.collection(collection.slug);

            // Resolve the cursor value (and its tie-breaker).
            let cursor: { value: any; id: any };
            if (value === "latest") {
                const resolved = await resolveInitialSync(source, key, "latest");
                if (!resolved) continue; // empty collection — nothing to seed from
                cursor = { value: resolved.value, id: opts?.id ?? resolved.id };
            } else if (value === "now") {
                cursor = { value: new Date(), id: opts?.id ?? null };
            } else {
                cursor = { value: value instanceof Date ? value : new Date(value), id: opts?.id ?? null };
            }

            const stateId = stateIdFor(tenantId, destination.id, collection.slug);
            const now = new Date();
            await meta.updateOne(
                { _id: stateId },
                {
                    $set: {
                        type: "state",
                        tenant: tenantId,
                        destination: destination.id,
                        collection: collection.slug,
                        key,
                        cursor,
                        status: "idle",
                        lastError: null,
                        updatedAt: now,
                    },
                    // The seeded position **replaces** the stream's: a leftover resume
                    // token would make the watcher resume where it was instead of
                    // cold-starting from what was just seeded
                    $unset: { resumeToken: "" },
                    $setOnInsert: { createdAt: now },
                },
                { upsert: true },
            );
            seeded++;
        }
    }

    logger.file("replication: seeded", {
        tenant: tenantId,
        destinations: destinations.map((d) => d.id),
        collection: opts?.collection ?? null,
        value: value instanceof Date ? value.toISOString() : value,
        seeded,
    });

    // A running stream does not re-read the state it holds in memory: restart it so
    // the seeded position becomes its new cold-start point
    await startWatchers(tenantId, stoppedWatchers).catch(() => {});

    return { tenant: tenantId, seeded };
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

async function startReplication(): Promise<void> {
    if (started) return;
    // In cluster mode (`reusePort` + workers), only the master process runs
    // replication. Workers skip to avoid duplicate connections and timers — the
    // distributed lock already serializes runs across processes.
    if (process.env.BUN_WORKER !== undefined) return;
    started = true;

    for (const tenant of cfg.tenants ?? []) {
        const config = resolveConfig(tenant);
        const mainDb = tenant.database?.db;
        if (!config || !mainDb) continue;

        // Change streams are the only change detector: they read the oplog, so they
        // need a replica set (or a sharded cluster). There is deliberately no
        // fallback — a date scan cannot see a delete, so falling back would make the
        // destination diverge silently.
        if (!(await supportsChangeStreams(tenant.id, mainDb))) {
            logger.file("error", "replication: change streams unavailable — a replica set is required, tenant skipped", {
                tenant: tenant.id,
            });
            continue;
        }

        let connected = false;
        for (const destination of config.destinations ?? []) {
            if (destination.enabled === false || !destination.id || !destination.uri) continue;
            const key = `${tenant.id}:${destination.id}`;
            try {
                if (runtimes.has(key)) { connected = true; continue; }
                const client = new MongoClient(destination.uri, {
                    serverSelectionTimeoutMS: 5000,
                    connectTimeoutMS: 10000,
                    ...(destination.options ?? {}),
                });
                await client.connect();
                const db = destination.name ? client.db(destination.name) : client.db();
                runtimes.set(key, { tenantId: tenant.id, destination, client, db, running: false });
                connected = true;
                logger.file("replication: destination connected", { tenant: tenant.id, destination: destination.id, database: db.databaseName });
            } catch (err: any) {
                logger.file("error", "replication: destination connection failed", { tenant: tenant.id, destination: destination.id, error: err?.message });
            }
        }

        if (!connected) continue;

        const meta = mainDb.collection(META_COLLECTION);
        for (const runtime of runtimesFor(tenant.id)) {
            await startWatcher(tenant, runtime, config, meta);
        }

        if (config.runOnBoot !== false) {
            replicateTenant(tenant.id).catch((err) =>
                logger.file("error", "replication: initial run failed", { tenant: tenant.id, error: err?.message }),
            );
        }
    }
}

async function stopReplication(): Promise<void> {
    // Watchers first: their streams must stop writing before the clients go away
    for (const watcher of [...watchers.values()]) {
        try { await watcher.stop(); } catch { /* already stopped */ }
    }
    watchers.clear();
    for (const runtime of runtimes.values()) {
        try { await runtime.client.close(); } catch { /* ignore */ }
    }
    runtimes.clear();
    ensured.clear();
    changeStreamSupport.clear();
    started = false;
}

export {
    startReplication,
    stopReplication,
    replicationNow,
    replicateTenant,
    getReplicationState,
    resetReplication,
    seedReplication,
};
