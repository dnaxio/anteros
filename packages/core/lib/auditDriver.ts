import { cfg } from "../server/config";
import type { Tenant } from "../types/tenant";
import { resolveAuditFile } from "./audit";
import { resolveAuditQuack } from "./auditQuack";

/**
 * Where the audit trail is **written** — the storage driver.
 *
 * - `'default'` — the `_audit_` collection of the tenant's main database. The file
 *   and the DuckDB table are additional copies when they are configured.
 * - `'file'` — the append-only JSONL file **instead of** `_audit_`.
 * - `'quack'` — the DuckDB table **instead of** `_audit_`.
 *
 * With `'file'` or `'quack'`, `_audit_` is never written: `rest.audit.getActivities()`
 * has nothing to read, and the replication engine has nothing to copy. A driver that
 * is selected but not configured falls back to `'default'`, with one log line — an
 * audit entry is never lost because of a typo.
 */
export type AuditDriver = "default" | "file" | "quack";

const DRIVERS: AuditDriver[] = ["default", "file", "quack"];
const warned = new Set<string>();

/**
 * Resolve the audit driver for a tenant — **the tenant wins**, `server.audit.driver`
 * is the fallback. Unknown values and an unconfigured `file` / `quack` degrade to
 * `'default'` (with one warning each), never to silence.
 */
function resolveAuditDriver(tenant: Tenant | null | undefined): AuditDriver {
    if (!tenant) return "default";
    const raw = tenant.audit?.driver ?? cfg.server?.audit?.driver;
    if (raw === undefined) return "default";

    if (!DRIVERS.includes(raw)) {
        warnOnce(`${tenant.id}:${String(raw)}`, `Invalid audit.driver '${raw}' for tenant '${tenant.id}' — expected 'default', 'file' or 'quack'; using 'default'`);
        return "default";
    }
    if (raw === "file" && !resolveAuditFile(tenant)) {
        warnOnce(`${tenant.id}:file`, `audit.driver is 'file' for tenant '${tenant.id}' but no file is configured — writing to _audit_ instead`);
        return "default";
    }
    if (raw === "quack" && !resolveAuditQuack(tenant)) {
        warnOnce(`${tenant.id}:quack`, `audit.driver is 'quack' for tenant '${tenant.id}' but no quack server is configured — writing to _audit_ instead`);
        return "default";
    }
    return raw;
}

/** One line per (tenant, misconfiguration) — not one per audited request. */
function warnOnce(key: string, message: string): void {
    if (warned.has(key)) return;
    warned.add(key);
    console.error(message);
}

/** Log the consequence of a non-default driver once, when the collection is set up. */
function warnDriverConsequences(tenant: Tenant | null | undefined): void {
    if (!tenant) return;
    const driver = resolveAuditDriver(tenant);
    if (driver === "default") return;
    warnOnce(
        `${tenant.id}:${driver}:consequence`,
        `Audit driver '${driver}' for tenant '${tenant.id}': _audit_ is not written — getActivities() returns nothing and replication has nothing to copy`,
    );
}

export { resolveAuditDriver, warnDriverConsequences };
