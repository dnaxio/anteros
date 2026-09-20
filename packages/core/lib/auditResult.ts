import { cfg } from "../server/config";

/**
 * What an audit entry keeps of an operation's **result** (default: `summary`).
 *
 * - `summary` → the **generated identifiers** (`_id` / `insertedIds`), plus the
 *               operational counters (`matchedCount`, `deletedCount`,
 *               `nIndexesWas`, …). Never a document.
 * - `none`    → the identifiers only.
 * - `full`    → the raw result as returned by the operation (documents included).
 */
export type AuditResults = 'none' | 'summary' | 'full'

/** Cap on the identifiers kept for a batch insert — the count stays exact */
const IDS_MAX = 100

const COUNTER_KEYS = [
    'acknowledged',
    'matchedCount',
    'modifiedCount',
    'upsertedCount',
    'upsertedId',
    'insertedCount',
    'deletedCount',
    'insertedIds',
    'upsertedIds',
]

// Default state (`results` unset = `summary`) — a sentinel like `undefined`
// would be indistinguishable from the real, unset configuration.
let cachedConfig: unknown = undefined
let cachedMode: AuditResults = 'summary'

function auditResultsMode(): AuditResults {
    const configured = cfg.server?.audit?.results
    if (configured !== cachedConfig) {
        cachedConfig = configured
        cachedMode = configured === 'full' || configured === 'none' ? configured : 'summary'
    }
    return cachedMode
}

/** Generated identifiers of an operation whose result is a document — never the document */
function identifiers(action: string, result: any): any {
    // `insertOne`, `updateOne`, `findOneAndUpdate` and a file `upload` all return
    // the document (created / updated / resulting) — only its `_id` may enter the trail.
    if (action === 'insertOne' || action === 'updateOne' || action === 'findOneAndUpdate' || action === 'upload') {
        return result?._id ? { _id: result._id } : null
    }
    if (action === 'insertMany') {
        const ids = Array.isArray(result)
            ? result.map((doc) => doc?._id).filter((id) => typeof id === 'string')
            : []
        return {
            count: ids.length,
            ...(ids.length ? { insertedIds: ids.slice(0, IDS_MAX) } : {}),
            ...(ids.length > IDS_MAX ? { truncated: true } : {}),
        }
    }
    return null
}

/** Pick the counter keys actually present in a driver result */
function counters(result: any): any {
    const out: any = {}
    for (const key of COUNTER_KEYS) {
        if (result?.[key] !== undefined) out[key] = result[key]
    }
    return Object.keys(out).length ? out : null
}

/**
 * Reduce an operation's result to what the audit trail may store.
 * `operation.input` already holds the parameters (and, for writes, the change
 * itself) — the result is only useful as *proof the operation had an effect*.
 */
function summarizeAuditResult(action: string, result: any): any {
    const mode = auditResultsMode()
    if (mode === 'full') return result ?? null
    if (result === null || result === undefined) return null

    if (mode === 'none') return identifiers(action, result)

    switch (action) {
        case 'insertOne':
        case 'insertMany':
        case 'updateOne':
        case 'findOneAndUpdate':
        case 'upload':
            // Document-returning operations: identifiers only
            return identifiers(action, result)
        case 'updateMany':
        case 'bulkWrite':
        case 'bulkUpdate':
            return counters(result)
        case 'deleteOne':
        case 'deleteFile':
            // `deleteOne` returns the deleted document — keep only "it happened"
            return { deleted: true }
        case 'deleteMany':
            return counters(result)
        case 'countDocuments':
            return typeof result === 'number' ? result : null
        case 'dropCollection':
            return typeof result === 'boolean' ? result : null
        case 'dropIndex':
            return typeof result === 'string' ? result : null
        case 'dropIndexes':
            return result?.nIndexesWas !== undefined ? { nIndexesWas: result.nIndexesWas } : null
        default:
            // Anything unknown: a document must never be stored.
            return null
    }
}

export {
    IDS_MAX,
    auditResultsMode,
    summarizeAuditResult,
}
