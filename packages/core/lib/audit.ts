import fs from "fs/promises";
import path from "path";
import { cfg } from "../server/config";
import type { Tenant } from "../types/tenant";
import { parseDuration } from "../utils/func";
import { resolveAuditRetention } from "../database/audit";

/**
 * Local, append-only backup of the audit trail — one JSONL file per day,
 * rotated on size and pruned by age. Meant for operators who want a copy of
 * `_audit_` on the same machine as the logs, independent from MongoDB.
 */
export type AuditFileOptions = {
    /** Target directory — default: `<server.logging.dir>/audit` (`.logs/audit`) */
    dir?: string;
    /**
     * Delete files older than this duration (`'30d'`).
     * `false` → never prune. Omitted → mirrors `audit.retention` when set, else keeps files forever.
     */
    retention?: string | false;
    /** Rotate when the current file exceeds this size in bytes (default: 50MB) */
    maxSize?: number;
};

/** `true` → defaults, `string` → directory shorthand, object → full options */
export type AuditFileConfig = boolean | string | AuditFileOptions;

type ResolvedAuditFile = {
    dir: string;
    retentionMs: number | null;
    maxSize: number;
};

type Sink = ResolvedAuditFile & {
    /** Current file ('' until opened) */
    file: string;
    /** `YYYY-MM-DD` of the current file */
    day: string;
    size: number;
    pending: string[];
    writing: boolean;
    prunedAt: number;
    inFlight: Promise<void>;
};

const DEFAULT_MAX_SIZE = 50 * 1024 * 1024; // 50MB
const PRUNE_INTERVAL_MS = 5 * 60 * 1000; // prune at most every 5 minutes
const EXT = '.jsonl';

const sinks = new Map<string, Sink>();

/**
 * Resolve the file backup settings — **the tenant always wins**,
 * `server.audit.file` is only the fallback. Returns `null` when disabled.
 */
function resolveAuditFile(tenant: Tenant): ResolvedAuditFile | null {
    const raw: AuditFileConfig | undefined = tenant.audit?.file !== undefined
        ? tenant.audit.file
        : cfg.server?.audit?.file

    if (raw === undefined || raw === false) return null

    const options: AuditFileOptions = raw === true
        ? {}
        : typeof raw === 'string' ? { dir: raw } : raw

    const dir = options.dir ?? path.join(cfg.server?.logging?.dir ?? '.logs', 'audit')

    // Retention: explicit value wins (including `false`), otherwise the local
    // copy mirrors the database retention so both follow the same policy.
    const retention = options.retention !== undefined ? options.retention : resolveAuditRetention(tenant)
    let retentionMs: number | null = null
    if (retention !== undefined && retention !== false) {
        const parsed = parseDuration(retention)
        if (parsed === null) {
            console.error(`Invalid audit file retention '${retention}' — expected a duration like '30d' or '24h'`)
        } else {
            retentionMs = parsed
        }
    }

    return { dir, retentionMs, maxSize: options.maxSize ?? DEFAULT_MAX_SIZE }
}

function prefix(tenantId: string): string {
    return `audit-${tenantId}`
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `JSON.stringify` that never throws (an activity must never break a request) */
function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value)
    } catch {
        return JSON.stringify({ error: 'unserializable activity' })
    }
}

function getSink(key: string, resolved: ResolvedAuditFile): Sink {
    let sink = sinks.get(key)
    if (!sink) {
        sink = {
            ...resolved,
            file: '',
            day: '',
            size: 0,
            pending: [],
            writing: false,
            prunedAt: 0,
            inFlight: Promise.resolve(),
        }
        sinks.set(key, sink)
    } else {
        // Options may change between boots / tests — always latest wins
        sink.dir = resolved.dir
        sink.retentionMs = resolved.retentionMs
        sink.maxSize = resolved.maxSize
    }
    return sink
}

/**
 * Pick the file `day` should be appended to: `audit-<tenant>-<day>.jsonl`,
 * then `-1`, `-2`… when the size cap is reached.
 *
 * Files of the day are scanned in rotation order and the first one with room is
 * reused — so a restart mid-day keeps appending to the current file, and the cap
 * is never exceeded (a single line larger than the cap gets its own file).
 */
async function openFile(sink: Sink, tenantId: string, day: string, bytes: number): Promise<void> {
    await fs.mkdir(sink.dir, { recursive: true })

    const base = `${prefix(tenantId)}-${day}`
    const re = new RegExp(`^${escapeRegex(base)}(?:-(\\d+))?${escapeRegex(EXT)}$`)

    const candidates: { index: number; name: string; size: number }[] = []
    try {
        for (const entry of await fs.readdir(sink.dir)) {
            const match = entry.match(re)
            if (!match) continue
            try {
                candidates.push({
                    index: Number(match[1] ?? 0),
                    name: entry,
                    size: (await fs.stat(path.join(sink.dir, entry))).size,
                })
            } catch { /* vanished between readdir and stat */ }
        }
    } catch { /* unreadable dir — treated as empty */ }

    candidates.sort((a, b) => a.index - b.index)

    const target = candidates.find((candidate) => candidate.size + bytes <= sink.maxSize)
    if (target) {
        sink.file = path.join(sink.dir, target.name)
        sink.day = day
        sink.size = target.size
        return
    }

    const next = candidates.length ? candidates[candidates.length - 1]!.index + 1 : 0
    sink.file = path.join(sink.dir, next === 0 ? `${base}${EXT}` : `${base}-${next}${EXT}`)
    sink.day = day
    sink.size = 0
}

/** Delete this tenant's audit files older than `retentionMs` (by mtime). Returns the removed names. */
async function pruneAuditFiles(dir: string, tenantId: string, retentionMs: number): Promise<string[]> {
    const removed: string[] = []
    try {
        const re = new RegExp(`^${escapeRegex(prefix(tenantId))}-.*${escapeRegex(EXT)}$`)
        const cutoff = Date.now() - retentionMs

        for (const entry of await fs.readdir(dir)) {
            if (!re.test(entry)) continue
            const full = path.join(dir, entry)
            try {
                const stat = await fs.stat(full)
                if (stat.mtimeMs < cutoff) {
                    await fs.unlink(full)
                    removed.push(entry)
                }
            } catch { /* already gone */ }
        }
    } catch { /* dir missing — nothing to prune */ }

    return removed
}

async function maybePrune(sink: Sink, tenantId: string): Promise<void> {
    if (sink.retentionMs === null) return
    if (Date.now() - sink.prunedAt < PRUNE_INTERVAL_MS) return
    sink.prunedAt = Date.now()
    const removed = await pruneAuditFiles(sink.dir, tenantId, sink.retentionMs)
    if (removed.length) {
        console.log(`🧹 Audit files pruned (${tenantId}): ${removed.length} file(s)`)
    }
}

/**
 * Serialized per tenant: concurrent callers coalesce their lines into a single
 * append, order is preserved, and lines are never interleaved.
 */
async function drain(key: string, tenantId: string): Promise<void> {
    const sink = sinks.get(key)
    if (!sink || sink.writing) return
    sink.writing = true

    try {
        while (sink.pending.length) {
            const lines = sink.pending.splice(0)
            const batch = lines.join('\n') + '\n'
            const bytes = Buffer.byteLength(batch)
            const day = new Date().toISOString().slice(0, 10)

            try {
                if (!sink.file || sink.day !== day || sink.size + bytes > sink.maxSize) {
                    await openFile(sink, tenantId, day, bytes)
                }
                await fs.appendFile(sink.file, batch)
            } catch (err) {
                // Keep the lines for the next call instead of losing them
                sink.pending.unshift(...lines)
                throw err
            }

            sink.size += bytes
            await maybePrune(sink, tenantId)
        }
    } catch (err: any) {
        console.error(`Audit file write failed (${tenantId})`, err?.message)
    } finally {
        sink.writing = false
    }
}

/**
 * Append activities to the tenant's local audit file — opt-in, fire-and-forget:
 * it never blocks the caller and never throws.
 */
function writeAuditFile(tenant: Tenant | null | undefined, activities: unknown[]): void {
    if (!tenant || !activities?.length) return

    const resolved = resolveAuditFile(tenant)
    if (!resolved) return

    const key = `${tenant.id}:${resolved.dir}`
    const sink = getSink(key, resolved)
    for (const activity of activities) sink.pending.push(safeStringify(activity))

    sink.inFlight = drain(key, tenant.id).catch(() => {})
}

/** Wait until every pending line is on disk (tests, graceful shutdown). */
async function flushAuditFile(): Promise<void> {
    for (let i = 0; i < 20; i++) {
        const current = [...sinks.values()]
        await Promise.all(current.map((sink) => sink.inFlight.catch(() => {})))
        if (!current.some((sink) => sink.writing || sink.pending.length)) return
    }
}

export {
    resolveAuditFile,
    writeAuditFile,
    flushAuditFile,
    pruneAuditFiles
}
