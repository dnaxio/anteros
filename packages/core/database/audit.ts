import type { Db } from "mongodb";
import { cfg } from "../server/config";
import type { Tenant } from "../types/tenant";
import { parseDuration } from "../utils/func";

/**
 * Collection holding the audit trail — one document per database operation
 * (see `types/activity.d.ts` / `rest.audit`).
 */
const AUDIT_COLLECTION = '_audit_'

/** Previous name of the audit collection — renamed once at boot by `migrateAuditCollection`. */
const LEGACY_AUDIT_COLLECTION = '_activities_'

/**
 * TTL index used for retention. Created only when a `tenant.audit.retention`
 * is configured — audit entries are kept forever by default.
 */
const AUDIT_TTL_INDEX = '_audit_ttl_'

/**
 * Query indexes, always ensured in the background (same convention as `_vars_`),
 * whatever the tenant config — an audit collection is queried by date, by
 * collection, by status and by trace, and grows fast enough that a COLLSCAN
 * is never acceptable.
 */
const AUDIT_INDEXES: { name: string; key: Record<string, 1 | -1> }[] = [
    /** Listing / date ranges (`getActivities` sorts on `ts` by default) */
    { name: '_audit_ts_', key: { ts: -1 } },
    /** `$match: { 'operation.collection': … }` + recent first */
    { name: '_audit_collection_ts_', key: { 'operation.collection': 1, ts: -1 } },
    /** `$match: { 'operation.status': 'error' }` + recent first */
    { name: '_audit_status_ts_', key: { 'operation.status': 1, ts: -1 } },
    /** Correlate every operation of a request (`trace.id`) */
    { name: '_audit_trace_', key: { 'trace.id': 1 } },
]

type RetentionResult = 'applied' | 'dropped' | 'unchanged' | 'skipped'

/**
 * One-off migration: `_activities_` → `_audit_`.
 *
 * Idempotent and never fatal:
 * - legacy collection absent  → no-op (the common case after the migration)
 * - target already exists     → no-op, the legacy collection is left untouched
 *   (never merged nor dropped: losing audit entries silently is worse than a stale collection)
 */
async function migrateAuditCollection(db: Db): Promise<boolean> {
    try {
        const legacy = await db.listCollections({ name: LEGACY_AUDIT_COLLECTION }).toArray()
        if (legacy.length === 0) return false

        const target = await db.listCollections({ name: AUDIT_COLLECTION }).toArray()
        if (target.length > 0) return false

        await db.renameCollection(LEGACY_AUDIT_COLLECTION, AUDIT_COLLECTION, { dropTarget: false })
        console.log(`🔁 Audit collection renamed: ${LEGACY_AUDIT_COLLECTION} → ${AUDIT_COLLECTION}`)
        return true
    } catch (err: any) {
        console.error(
            `Audit collection migration failed (${LEGACY_AUDIT_COLLECTION} → ${AUDIT_COLLECTION})`,
            err?.message,
        )
        return false
    }
}

/**
 * Ensure the audit query indexes. `createIndex` is idempotent, so this runs on
 * every boot and only fills in what is missing. Never fatal, never blocking
 * (`background: true`).
 *
 * ⚠️ Indexes cost writes, and the audit collection is the most write-heavy one —
 * four indexes are a deliberate trade-off (see the Audit documentation).
 */
async function ensureAuditIndexes(db: Db): Promise<string[]> {
    const ensured: string[] = []
    const col: any = db.collection(AUDIT_COLLECTION)

    for (const index of AUDIT_INDEXES) {
        try {
            await col.createIndex(index.key, { name: index.name, background: true })
            ensured.push(index.name)
        } catch (err: any) {
            console.error(`Audit index '${index.name}' failed`, err?.message)
        }
    }

    return ensured
}

/**
 * Declarative retention (MongoDB TTL on `ts`):
 * - duration string (`'90d'`, `'24h'`) → ensure the TTL index with that expiry
 * - `false`                            → explicitly disabled: drop the TTL index
 * - omitted                            → untouched (entries are kept forever)
 */
async function syncAuditRetention(db: Db, retention?: string | false): Promise<RetentionResult> {
    if (retention === undefined) return 'skipped'

    const col: any = db.collection(AUDIT_COLLECTION)

    try {
        const existing = (await col.listIndexes().toArray())
            .find((index: any) => index.name === AUDIT_TTL_INDEX)

        if (retention === false) {
            if (!existing) return 'unchanged'
            await col.dropIndex(AUDIT_TTL_INDEX)
            console.log(`🧹 Audit retention disabled — ${AUDIT_TTL_INDEX} dropped`)
            return 'dropped'
        }

        const parsed = parseDuration(retention)
        if (parsed === null) {
            console.error(`Invalid audit retention '${retention}' — expected a duration like '90d' or '24h'`)
            return 'skipped'
        }
        const expireAfterSeconds = Math.round(parsed / 1000)

        if (!existing) {
            await col.createIndex({ ts: 1 }, {
                name: AUDIT_TTL_INDEX,
                expireAfterSeconds,
                background: true,
            })
            console.log(`🧹 Audit retention enabled — entries expire after ${retention}`)
            return 'applied'
        }

        if (existing.expireAfterSeconds === expireAfterSeconds) return 'unchanged'

        // `expireAfterSeconds` cannot be updated through createIndex: collMod does it
        // instantly, dropping/recreating the index is only a fallback for older servers
        try {
            await db.command({
                collMod: AUDIT_COLLECTION,
                index: { name: AUDIT_TTL_INDEX, expireAfterSeconds },
            })
        } catch {
            await col.dropIndex(AUDIT_TTL_INDEX)
            await col.createIndex({ ts: 1 }, {
                name: AUDIT_TTL_INDEX,
                expireAfterSeconds,
                background: true,
            })
        }
        console.log(`🧹 Audit retention updated — entries expire after ${retention}`)
        return 'applied'
    } catch (err: any) {
        console.error(`Audit retention failed (${retention})`, err?.message)
        return 'skipped'
    }
}

/**
 * Retention resolution — **the tenant always wins**, `server.audit.retention`
 * is only the fallback:
 *
 * - `tenant.audit.retention` set (a duration, even `false`) → used as-is
 * - otherwise                                        → `server.audit.retention`
 * - neither                                          → `undefined` (kept forever)
 */
function resolveAuditRetention(tenant: Tenant): string | false | undefined {
    if (tenant.audit?.retention !== undefined) return tenant.audit.retention
    return cfg.server?.audit?.retention
}

/**
 * Boot setup for a tenant's audit collection, in this order:
 * migration → indexes → retention.
 *
 * The migration comes first on purpose: creating the indexes would create an
 * empty `_audit_`, and the migration would then refuse to rename the legacy
 * collection (leaving its entries stranded).
 */
async function setupAuditCollection(db: Db, retention?: string | false): Promise<void> {
    await migrateAuditCollection(db)
    await ensureAuditIndexes(db)
    await syncAuditRetention(db, retention)
}

export {
    AUDIT_COLLECTION,
    LEGACY_AUDIT_COLLECTION,
    AUDIT_TTL_INDEX,
    AUDIT_INDEXES,
    migrateAuditCollection,
    ensureAuditIndexes,
    syncAuditRetention,
    resolveAuditRetention,
    setupAuditCollection
}
