import type { Context } from "hono";
import type { Tenant } from "./tenant";
import type { IPRestrictionRule } from "hono/ip-restriction";
import type { Collection } from "./collection";
import type { Route } from "./route";
import type { Service } from "./service";
import type { Script } from "./scripts";
import type { FileCollection } from "./file";
import type { McpTool, McpResource } from "./mcp";
import type { VarDefinition } from "./vars";
import type { AgentDefinition } from "./agent";
import type { AuditFileConfig } from "../lib/audit";
export type ServerConfig = {
    debug?: boolean;
    version?: string;
    server: {
        name?: string;
        port: number;
        /** Bun's SO_REUSEPORT — allows multiple processes to bind the same port. Spawn them yourself. */
        reusePort?: boolean;
        /** Number of worker processes when reusePort is on (default: CPU count) */
        workers?: number;
        /** Master supervision port exposing aggregated /health (default: port + 1) */
        metricsPort?: number;
        /** When true, trusts proxy headers (CF-Connecting-IP / X-Forwarded-For) as the client IP. Default: false. */
        trustProxy?: boolean;
        /**
         * Audit trail defaults for every tenant. A tenant declaring its own
         * `tenant.audit` always wins (even `false`).
         */
        audit?: {
            /**
             * How long `_audit_` entries are kept (MongoDB TTL on `ts`).
             * Duration string: `'90d'`, `'24h'`.
             * `false` → explicitly disabled (drops the TTL index if one exists).
             * Omitted → untouched: entries are kept forever.
             */
            retention?: string | false;
            /**
             * Local append-only JSONL copy of the audit trail (one file per day,
             * rotated on size, pruned by age).
             * `true` → defaults, `string` → directory, object → full options.
             * `false` / omitted → disabled.
             */
            file?: AuditFileConfig;
            /**
             * Object keys whose value is replaced by `"[redacted]"` in every audit
             * entry (`operation.input`, `operation.result` and `meta`), at any depth,
             * case-insensitively. `false` → disabled.
             *
             * Default: password, passwd, pwd, token, authorization, apikey, api_key,
             * key, secret, cookie, otp, pin.
             */
            redact?: string[] | false;
            /**
             * What an audit entry keeps of the operation's **result**
             * (default: `'summary'`).
             *
             * - `'summary'` (default) → the **generated identifiers** (`_id`,
             *   `insertedIds`) plus the operational counters (`matchedCount`,
             *   `modifiedCount`, `deletedCount`, `nIndexesWas`…). Never a document:
             *   the data lives in the collection (and in its replications).
             * - `'none'`    → the generated identifiers only.
             * - `'full'`    → the raw result, documents included.
             *
             * Reads (`find`, `findOne`, `aggregate`, streams, `watch`) and custom
             * actions/services never store a result, whatever this setting.
             */
            results?: 'none' | 'summary' | 'full';
        };
        /**
         * Workflow defaults for every tenant — a tenant declaring its own
         * `tenant.workflows` always wins.
         */
        workflows?: {
            /**
             * How long **finished** workflow runs are kept (MongoDB TTL on
             * `completedAt`). Duration string: `'30d'`, `'90d'`.
             * `false` → explicitly disabled. Omitted → untouched.
             */
            retention?: string | false;
        };
        body?: {
            maxSize?: number;
        };
        /**
         * Boot mode (default: `'full'`).
         *
         * - `'full'` — HTTP API **and** the replication engine.
         * - `'replication-only'` — a process dedicated to the replication engine: no
         *   HTTP API, no websocket handlers, no scripts, no services, no MCP tools,
         *   no middlewares. Loaded: tenant databases, collections, file collections,
         *   variables and lifecycle hooks (`beforeBoot` / `onDestroy`).
         * - `'no-replication'` — a full server that never starts the replication
         *   engine (no scheduling, no tombstones, no `_replication_` state).
         * - `'api-only'` — the HTTP API and nothing around it: no replication, no
         *   scripts, no sockets.
         *
         * Flags always win over this setting: `--replication-only`, `--no-replication`,
         * `--api-only`, `--no-scripts`, `--no-sockets`.
         */
        mode?: 'full' | 'replication-only' | 'no-replication' | 'api-only';
        cors?: {
            origin: string | string[] | ((ctx: { origin: string, c: Context }) => string | string[]);
            credentials?: boolean;
            allowHeaders?: string[];
            allowMethods?: string[];
        }
        ipRestriction?: {
            denyList?: IPRestrictionRule[];
            allowList?: IPRestrictionRule[];
        }
        jwt?: {
            secret?: string;
            expiresIn?: string;
        }
        rateLimit?: {
            enabled?: boolean;
            windowMs?: number;
            max?: number;
            /** Redis store override: unset = auto (Redis when `redis` block or REDIS_* env vars are present), false = force in-memory, true = force Redis */
            useRedis?: boolean;
            /** Redis connection used when useRedis is true (env fallbacks: REDIS_URL / REDIS_HOST / REDIS_PORT / REDIS_PASSWORD) */
            redis?: {
                /** redis:// connection string (takes precedence over host/port/password) */
                url?: string;
                host?: string;
                port?: number;
                password?: string;
            };
            /** Stricter limits for login endpoints */
            login?: {
                windowMs?: number;
                max?: number;
            };
        };
        logging?: {
            /** Minimum level emitted (default: 'info') */
            level?: 'debug' | 'info' | 'warn' | 'error';
            /** Also write to the console (default: true) */
            console?: boolean;
            /** File logging: true → <dir>/anteros.log, string → custom path, false → disabled (default: true) */
            file?: boolean | string;
            /** Directory used when `file` is true (default: '.logs') */
            dir?: string;
            /** Rotate when the log file exceeds this size in bytes (default: 10MB) */
            maxSize?: number;
            /** Keep this many rotated files (default: 5) */
            maxFiles?: number;
            /** Log database operations slower than this many ms (default: 200) */
            slowQueryMs?: number;
        };
        /** DB query caching (find + useCache) — driver + defaults for the query cache */
        cache?: {
            enabled?: boolean;
            /** Driver: 'memory' (default), 'filesystem' (.cache/ folder), 'redis' */
            driver?: 'memory' | 'filesystem' | 'redis';
            /** Filesystem driver directory (default: ./.cache) */
            directory?: string;
            /** Redis connection (driver: 'redis') */
            redis?: {
                url?: string;
                host?: string;
                port?: number;
                password?: string;
            };
            /** Filesystem prune interval (default: '1h') */
            pruneInterval?: string;
            /** Default TTL for cached queries — human string ('5m') or ms (default: '5m') */
            ttl?: string | number;
            /** Max `_id` tags per cached entry — large results are tagged up to this count (default: 50000; each tag costs ~0.18µs per cache hit) */
            maxTags?: number;
        };
        /** Encryption keys — defaults used by utils.crypt.useSymCrypt() / utils.crypt.useAsymCrypt() */
        encryption?: {
            /** REQUIRED — encryption mode: 'symmetric' (AES-256-GCM) or 'asymmetric' (RSA-OAEP envelope) */
            mode: 'symmetric' | 'asymmetric';
            /** Symmetric AES-256-GCM secret (useSymCrypt) — required when mode is 'symmetric'. Falls back to env APP_SECRET */
            secret?: string;
            /** Version of the active secret — written into new ciphertexts (default: 1) */
            version?: number;
            /** Older secrets for decrypt-only — key rotation, e.g. { 1: 'v1-secret' } */
            previousSecrets?: Record<number, string>;
            /** Default AAD context — bound to every ciphertext when no explicit AAD is passed. Must stay stable (changing it makes old data undecryptable) */
            aad?: string;
            /** Asymmetric RSA-OAEP private key JWK for decryption (useAsymCrypt) — required when mode is 'asymmetric'. Object or JSON string */
            privateKey?: JsonWebKey | string;
        };
    }
    tenants: Tenant[];
}

export type Config = ServerConfig & {
    version?: string;
    collections?: Collection[]
    routes?: Route[]
    services?: Service[]
    scripts?: Script[]
    fileCollections?: FileCollection[]
    mcpTools?: McpTool[]
    mcpResources?: McpResource[]
    vars?: VarDefinition[]
    agents?: AgentDefinition[]
}
