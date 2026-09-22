import { MongoClient, ObjectId, type Db } from "mongodb";
import { cfg } from "../server/config";
import { getTenant } from "./tenant";
import { useRest } from "./rest";
import { logger } from "../utils/logger";
import * as func from "../utils/func";
import * as os from "node:os";
import type { Collection } from "../types/collection";
import type { Tenant } from "../types/tenant";
import type { HookContext } from "../types/hook";
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
import { syncTtlRetention } from "./ttl";

const META_COLLECTION = "_replication_";
const DEFAULT_KEY = "updatedAt";
const DEFAULT_BATCH = 1000;
/** MongoDB `bulkWrite` is capped per call — split batches into chunks of this size. */
const BULK_CHUNK = 1000;
/** Distributed-lock TTL used to guard a run across cluster workers. */
const LOCK_TTL = 5 * 60_000;

/**
 * Framework collections replication covers **by default**, with the date key each
 * one is read with (the engine's cursor). `'vars'` is handled apart, per namespace.
 */
const META_COLLECTIONS: Record<Exclude<ReplicationMetaName, 'vars'>, { slug: string; key: string }> = {
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

    return collections;
}

type Runtime = {
    tenantId: string;
    destination: ReplicationDestination;
    client: MongoClient;
    db: Db;
    running: boolean;
};

type Job = { tenant: string; stop: () => void };

const runtimes = new Map<string, Runtime>();
const jobs: Job[] = [];
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

function deleteMarkerId(collection: Collection, docId: string): string {
    return `rep.delete:${collection._tenant_}:${collection.slug}:${docId}`;
}

function filterCollections(collections: Collection[], destination: ReplicationDestination): Collection[] {
    if (!destination.collections?.length) return collections;
    const wanted = new Set(destination.collections);
    return collections.filter((c) => wanted.has(c.slug));
}

function runtimesFor(tenantId: string): Runtime[] {
    return [...runtimes.values()].filter((rt) => rt.tenantId === tenantId && rt.destination.enabled !== false);
}

/** Active destination ids that must apply deletes for the given collection. */
function deleteDestinationsFor(config: ReplicationConfig, collection: Collection): string[] {
    return (config.destinations ?? [])
        .filter((d) => d.enabled !== false && d.id && d.uri)
        .filter((d) => !d.collections?.length || d.collections.includes(collection.slug))
        .map((d) => d.id);
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

/** Rewind the cursor by `lookback` ms to catch out-of-order / clock-skewed writes. */
function applyLookback(cursor: { value: any; id: any } | null, lookback: number): { value: any; id: any } | null {
    if (!cursor || cursor.value === null || cursor.value === undefined || !lookback) return cursor;
    const value = cursor.value instanceof Date ? new Date(cursor.value.getTime() - lookback) : cursor.value;
    return { value, id: cursor.id };
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
/* Deletes (hook + tombstone)                                          */
/* ------------------------------------------------------------------ */

async function recordDeletes(collection: Collection, ctx: HookContext): Promise<void> {
    if (ctx.action !== "deleteOne" && ctx.action !== "deleteMany") return;
    const ids: string[] = ctx.action === "deleteOne"
        ? (ctx.meta.id ? [String(ctx.meta.id)] : [])
        : (ctx.meta.ids ?? []).map((id) => String(id));
    if (!ids.length) return;

    const db = (ctx.rest as any)?.db as Db | undefined;
    if (!db) return;

    const meta = db.collection(META_COLLECTION);
    const now = new Date();
    const ops = ids.map((docId) => {
        const _id = deleteMarkerId(collection, docId);
        return {
            replaceOne: {
                filter: { _id },
                replacement: {
                    _id,
                    type: "delete",
                    tenant: collection._tenant_,
                    collection: collection.slug,
                    docId,
                    deletedAt: now,
                    synced: [],
                    updatedAt: now,
                },
                upsert: true,
            },
        };
    });
    await meta.bulkWrite(ops as any, { ordered: false });
}

function instrumentCollection(collection: Collection): void {
    if (!collection.hooks) collection.hooks = {};
    const hooks: any = collection.hooks;
    if (hooks._replicationDeleteHook) return;
    const previous = collection.hooks.afterOperation;
    collection.hooks.afterOperation = async (ctx: HookContext) => {
        if (previous) await previous(ctx);
        await recordDeletes(collection, ctx).catch((err) =>
            logger.file("warn", "replication: failed to record delete", { collection: collection.slug, error: err?.message }),
        );
    };
    hooks._replicationDeleteHook = true;
}

/**
 * Apply pending delete tombstones on the destination. The `key` guard prevents
 * deleting a document that was re-inserted/updated after the deletion occurred.
 */
async function flushDeletes(
    meta: any,
    runtime: Runtime,
    collection: Collection,
    key: string,
    batchSize: number,
    expectedDestinations: string[],
): Promise<{ deleted: number; processed: number }> {
    const markers = await meta.find({
        type: "delete",
        collection: collection.slug,
        synced: { $ne: runtime.destination.id },
    }).limit(batchSize).toArray();
    if (!markers.length) return { deleted: 0, processed: 0 };

    const ops = markers.map((m: any) => ({
        deleteOne: {
            filter: {
                _id: toId(m.docId),
                // The key is a Date on most collections, but a number on `_locks_`:
                // accept either, so a numeric key never silently skips the delete
                $or: [
                    { [key]: { $lte: m.deletedAt } },
                    { [key]: { $lte: m.deletedAt?.getTime?.() ?? m.deletedAt } },
                ],
            },
        },
    }));
    const res = await withRetry(() => runtime.db.collection(collection.slug).bulkWrite(ops as any, { ordered: false }));
    const applied = (res as any).deletedCount ?? 0;

    await meta.updateMany(
        { _id: { $in: markers.map((m: any) => m._id) } },
        { $addToSet: { synced: runtime.destination.id }, $set: { updatedAt: new Date() } },
    );

    // Purge tombstones fully applied by every expected destination.
    if (expectedDestinations.length) {
        await meta.deleteMany({
            type: "delete",
            collection: collection.slug,
            synced: { $all: expectedDestinations },
        }).catch(() => {});
    }

    return { deleted: applied, processed: markers.length };
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
    const stateId = stateIdFor(tenant.id, runtime.destination.id, collection.slug);
    const state = (await meta.findOne({ _id: stateId })) as ReplicationState | null;
    let cursor = state?.cursor ?? { value: null, id: null };

    const source = tenant.database.db!.collection(collection.slug);
    const target = runtime.db.collection(collection.slug);
    const batchSize = config.batchSize ?? DEFAULT_BATCH;
    const lookback = config.lookback ?? 0;
    const startedAt = Date.now();
    const stats: ReplicationStats = { inserted: 0, updated: 0, deleted: 0, failed: 0, batches: 0, durationMs: 0 };

    await ensureIndex(tenant.database.db!, collection.slug, key, "source");
    await ensureIndex(runtime.db, collection.slug, key, `destination:${runtime.destination.id}`);

    // Meta collections have no hooks, so their deletions never reach the
    // destination (an audit TTL expiry is invisible to a date cursor): mirror the
    // source's retention on the destination, otherwise the copy grows forever.
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

    // Inserts and updates are always replicated: both refresh the date key, so
    // the incremental cursor picks them up — there is no way (nor need) to tell
    // them apart.
    while (true) {
        const docs = await source
            .find(mergedFilter(baseFilter, incrementalFilter(key, applyLookback(cursor, lookback))) as any)
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

    // Deletes are always propagated too — a deleted document no longer exists, so
    // a date cursor can never see it; they are captured by the hook + tombstone.
    {
        const expected = deleteDestinationsFor(config, collection);
        while (true) {
            const { deleted, processed } = await flushDeletes(meta, runtime, collection, key, batchSize, expected);
            stats.deleted += deleted;
            if (processed < batchSize) break;
        }
    }

    stats.durationMs = Date.now() - startedAt;
    await saveState(meta, stateId, tenant, runtime, collection, key, cursor, stats, "success", null);
    return stats;
}

async function replicateTenant(
    tenantId: string,
    opts?: { destinationId?: string; collection?: string },
): Promise<ReplicationRunResult[]> {
    const tenant = getTenant(tenantId);
    const config = tenant ? resolveConfig(tenant) : null;
    const mainDb = tenant?.database?.db;
    if (!tenant || !config || !mainDb) return [];

    const collections = replicatedCollectionsFor(tenantId, config);
    const results: ReplicationRunResult[] = [];
    const meta = mainDb.collection(META_COLLECTION);
    const rest = new useRest({ tenant_id: tenantId });

    for (const runtime of runtimesFor(tenantId)) {
        if (opts?.destinationId && runtime.destination.id !== opts.destinationId) continue;
        if (runtime.running) continue;

        const lockName = `replication:${runtime.destination.id}`;
        let locked = false;
        try {
            await rest.lock(lockName, LOCK_TTL);
            locked = true;
        } catch {
            continue; // another node holds the lock
        }

        runtime.running = true;
        try {
            for (const collection of filterCollections(collections, runtime.destination)) {
                if (opts?.collection && collection.slug !== opts.collection) continue;
                const key = resolveKey(collection, config);
                const startedAt = Date.now();
                const totals: ReplicationStats = { inserted: 0, updated: 0, deleted: 0, failed: 0, batches: 0, durationMs: 0 };

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
                }
            }
        } finally {
            runtime.running = false;
            if (locked) await rest.unlock(lockName).catch(() => {});
        }
    }

    return results;
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
 * (cursor, stats, status), so the next run starts over. Destination data is
 * never touched: only the bookkeeping is cleared.
 *
 * Scope it with `destination` and/or `collection`. Pending delete tombstones are
 * cleared too, unless the reset is scoped to a single destination (tombstones
 * carry a shared `synced[]` list) or `tombstones: false`.
 */
async function resetReplication(
    tenantId: string,
    opts?: ReplicationResetOptions,
): Promise<ReplicationResetResult> {
    const tenant = getTenant(tenantId);
    const db = tenant?.database?.db;
    if (!tenant || !db) return { tenant: tenantId, state: 0, tombstones: 0 };

    const meta = db.collection(META_COLLECTION);

    const stateFilter: Record<string, any> = { type: "state", tenant: tenantId };
    if (opts?.destination) stateFilter.destination = opts.destination;
    if (opts?.collection) stateFilter.collection = opts.collection;
    const stateRes = await meta.deleteMany(stateFilter);
    const state = stateRes.deletedCount ?? 0;

    let tombstones = 0;
    if (opts?.tombstones !== false && !opts?.destination) {
        const tombFilter: Record<string, any> = { type: "delete", tenant: tenantId };
        if (opts?.collection) tombFilter.collection = opts.collection;
        const tombRes = await meta.deleteMany(tombFilter);
        tombstones = tombRes.deletedCount ?? 0;
    }

    logger.file("replication: reset", {
        tenant: tenantId,
        destination: opts?.destination ?? null,
        collection: opts?.collection ?? null,
        state,
        tombstones,
    });

    return { tenant: tenantId, state, tombstones };
}

/**
 * Set the starting point of replication for a tenant by writing the `_replication_`
 * cursor — the counterpart of `reset()`. Use it from `beforeBoot` to start a
 * replication from a given date (or `'now'` / `'latest'`) instead of backfilling.
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

    return { tenant: tenantId, seeded };
}

/* ------------------------------------------------------------------ */
/* Scheduling / lifecycle                                              */
/* ------------------------------------------------------------------ */

function scheduleTenant(tenant: Tenant, config: ReplicationConfig): void {
    const run = () => {
        replicateTenant(tenant.id).catch((err) =>
            logger.file("error", "replication: scheduled run failed", { tenant: tenant.id, error: err?.message }),
        );
    };

    if (config.schedule && "cron" in config.schedule) {
        try {
            const job: any = (Bun as any).cron(config.schedule.cron, run);
            jobs.push({ tenant: tenant.id, stop: () => { try { job?.stop?.(); } catch { /* ignore */ } } });
            logger.file("replication: scheduled", { tenant: tenant.id, cron: config.schedule.cron });
            return;
        } catch (err: any) {
            logger.file("error", "replication: invalid cron expression", { tenant: tenant.id, cron: config.schedule.cron, error: err?.message });
        }
    }

    const intervalValue = config.schedule && "interval" in config.schedule ? config.schedule.interval : undefined;
    const interval = Math.max(1000, func.parseDuration(intervalValue ?? "5m") ?? 5 * 60_000);
    const timer = setInterval(run, interval);
    (timer as any)?.unref?.();
    jobs.push({ tenant: tenant.id, stop: () => clearInterval(timer) });
    logger.file("replication: scheduled", { tenant: tenant.id, intervalMs: interval });
}

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

        // Deletes are always propagated: wrap `afterOperation` on every
        // sync-enabled collection (file collections opt in the same way)
        // so hard deletes leave a tombstone.
        for (const collection of [...(cfg.collections ?? []), ...((cfg.fileCollections ?? []) as any[])]) {
            if (collection._tenant_ === tenant.id && collection.replication?.enabled) {
                instrumentCollection(collection);
            }
        }

        scheduleTenant(tenant, config);

        if (config.runOnBoot !== false) {
            replicateTenant(tenant.id).catch((err) =>
                logger.file("error", "replication: initial run failed", { tenant: tenant.id, error: err?.message }),
            );
        }
    }
}

async function stopReplication(): Promise<void> {
    for (const job of jobs) {
        try { job.stop(); } catch { /* ignore */ }
    }
    jobs.length = 0;
    for (const runtime of runtimes.values()) {
        try { await runtime.client.close(); } catch { /* ignore */ }
    }
    runtimes.clear();
    ensured.clear();
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
