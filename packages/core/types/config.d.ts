import type { Context } from "hono";
import type { Tenant } from "./tenant";
import type { IPRestrictionRule } from "hono/ip-restriction";
import type { Collection } from "./collection";
import type { Route } from "./route";
import type { Service } from "./service";
import type { Script } from "./scripts";
import type { FileCollection } from "./file";
import type { McpTool, McpResource } from "./mcp";
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
        body?: {
            maxSize?: number;
        };
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
}
