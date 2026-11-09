import type { Db, MongoClient, MongoClientOptions } from "mongodb";
import type { ReplicationConfig } from "./replication";
import type { AuditFileConfig } from "../lib/audit";
import type { AuditQuackConfig } from "../lib/auditQuack";
import type { AuditDriver } from "../lib/auditDriver";
export type Tenant = {
    id: string;
    name?: string;
    description?: string;
    dir: string;
    /** Per-tenant replication — each tenant has its own destinations and backfill. */
    replication?: ReplicationConfig;
    /**
     * Audit trail (`_audit_`) — query indexes are always ensured in the background,
     * retention is opt-in.
     */
    audit?: {
        /**
         * Where this tenant's audit trail is written (default: `'default'`) — the
         * storage driver, like `cache.driver`.
         * `'file'` / `'quack'` write **instead of** `_audit_` — then
         * `getActivities()` returns nothing and replication has nothing to copy.
         */
        driver?: AuditDriver;
        /**
         * How long audit entries are kept, as a MongoDB TTL index on `ts`.
         * Duration string: `'90d'`, `'24h'`, `'30m'`.
         * `false` → explicitly disabled (drops the TTL index if one exists).
         * Omitted → untouched: entries are kept forever.
         */
        retention?: string | false;
        /**
         * Local append-only JSONL copy of this tenant's audit trail.
         * `true` → defaults, `string` → directory, object → full options.
         * `false` → explicitly disabled (overrides `server.audit.file`).
         */
        file?: AuditFileConfig;
        /**
         * DuckDB mirror of this tenant's audit trail — a table (`id / ts / data`) on a
         * **quack server** (`quack:host:port`) or a local `.duckdb` file, pruned by
         * age. `false` → explicitly disabled (overrides `server.audit.quack`).
         * `_audit_` stays the primary store: the mirror is never read by the API.
         */
        quack?: AuditQuackConfig;
    };
    /**
     * Workflow runs (`_workflows_`). Indexes are always ensured in the
     * background; retention is opt-in and only prunes **finished** runs.
     */
    workflows?: {
        /**
         * How long finished runs are kept, as a MongoDB TTL index on `completedAt`
         * (runs still running, paused or failed keep no `completedAt` and are never
         * pruned). Duration string: `'30d'`, `'90d'`.
         * `false` → explicitly disabled. Omitted → untouched.
         */
        retention?: string | false;
    };
    routes?: {
        prefix?: string;
    },
    database: {
        uri: string;
        options?: MongoClientOptions;
        db?: Db;
        client?: MongoClient;
    }
}
