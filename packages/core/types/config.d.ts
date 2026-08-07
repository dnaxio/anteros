import type { Context } from "hono";
import type { Tenant } from "./tenant";
import type { IPRestrictionRule } from "hono/ip-restriction";
import type { Collection } from "./collection";
import type { Route } from "./route";
import type { Service } from "./service";
import type { Script } from "./scripts";
import type { FileCollection } from "./file";
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
            /** If true, uses a Redis store (ioredis) for the rate limiter */
            useRedis?: boolean;
            /** Stricter limits for login endpoints */
            login?: {
                windowMs?: number;
                max?: number;
            };
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
}
