import { cfg } from "../server/config";

/**
 * Keys whose value is replaced by `[redacted]` before an audit entry is stored
 * (in `_audit_` **and** in the local file backup), at any depth.
 *
 * Override with `server.audit.redact: ['…']`, disable with `server.audit.redact: false`.
 */
const DEFAULT_REDACT_KEYS = [
    'password',
    'passwd',
    'pwd',
    'token',
    'auth_token',
    'access_token',
    'refresh_token',
    'id_token',
    'authorization',
    'apikey',
    'api_key',
    'key',
    'secret',
    'cookie',
    'session_id',
    'otp',
    'pin',
]

const REDACTED = '[redacted]'

/** Depth guard — a pathological payload must never cost more than a bounded walk */
const MAX_DEPTH = 8

// Cache initialised for the default state (`redact` unset) — a sentinel like
// `undefined` would be indistinguishable from the real, unset configuration.
let cachedConfig: unknown = undefined
let cachedKeys: Set<string> | null = new Set(DEFAULT_REDACT_KEYS.map((key) => key.toLowerCase()))

/** Lower-cased redaction keys, or `null` when redaction is disabled */
function redactKeys(): Set<string> | null {
    const configured = cfg.server?.audit?.redact
    if (configured !== cachedConfig) {
        cachedConfig = configured
        cachedKeys = configured === false
            ? null
            : new Set((configured ?? DEFAULT_REDACT_KEYS).map((key) => key.toLowerCase()))
    }
    return cachedKeys
}

/**
 * Is this key sensitive? Exact match, case-insensitive, `-`/`.` normalised to `_`
 * (`api-key` → `api_key`), plus the usual header prefix (`x-api-key` → `api_key`).
 *
 * Deliberately **not** a substring match: `key` must not match `monkey`.
 */
function isSensitiveKey(name: string, keys: Set<string>): boolean {
    const normalized = name.toLowerCase().replace(/[-.]/g, '_')
    if (keys.has(normalized)) return true
    if (normalized.startsWith('x_')) return keys.has(normalized.slice(2))
    return false
}

/**
 * Replace the value of every sensitive key (see `isSensitiveKey`), at any depth.
 * Arrays are traversed; **non-plain objects** (`Date`, `ObjectId`, `Buffer`,
 * `Map`…) are left untouched so stored types are never altered.
 *
 * Returns the **same reference** when nothing matched — the common case (no
 * sensitive key in the payload) costs the walk but no allocation.
 */
function redact(value: any, keys: Set<string>, depth = 0): any {
    if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value

    if (Array.isArray(value)) {
        let changed = false
        const out = value.map((item) => {
            const next = redact(item, keys, depth + 1)
            if (next !== item) changed = true
            return next
        })
        return changed ? out : value
    }

    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value

    let changed = false
    const out: Record<string, any> = {}
    for (const [name, item] of Object.entries(value)) {
        if (isSensitiveKey(name, keys)) {
            out[name] = REDACTED
            changed = true
            continue
        }
        const next = redact(item, keys, depth + 1)
        if (next !== item) changed = true
        out[name] = next
    }
    return changed ? out : value
}

/** Redact an audit payload — `input`, `result`, `meta` or `request` */
function redactPayload(value: any): any {
    const keys = redactKeys()
    if (!keys || value === undefined || value === null) return value
    return redact(value, keys)
}

export {
    DEFAULT_REDACT_KEYS,
    REDACTED,
    redactKeys,
    isSensitiveKey,
    redactPayload,
    redact,
}
