import type { useRest } from "../database/rest";
import type { Tenant } from "./tenant";
import type { Config } from "./config";
import type { logger } from "../utils/logger";
import type { Server as SocketIO } from "socket.io";
import type { TenantReplicationApi } from "./replication";
import type { TenantAgents } from "./agent";
import type { Api } from "../lib/api";

/** Signal that triggered the shutdown. */
export type LifecycleReason = "SIGINT" | "SIGTERM";

/** Base context shared by every lifecycle hook. `rest` is tenant-scoped. */
export type LifecycleContext = {
    tenant: Tenant;
    rest: InstanceType<typeof useRest>;
    /** Tenant-scoped LLM registry — `agents.get('support')`, bound to `rest`. */
    agents: TenantAgents;
    /** The in-process facade — `api.collection("orders")`, `api.service("analytics")`, `api.vars`, `api.files`, `api.agent(id)`. */
    api: Api;
    logger: typeof logger;
    cfg: Config;
    /** Tenant-scoped replication API — `reset()`, `seed()`, `now()`, `state()` (no tenant id needed). */
    replication: TenantReplicationApi;
};

/** Context of `beforeBoot` — runs before replication and before the HTTP server listens. */
export type LifecycleBootContext = LifecycleContext;

/** Context of `afterBoot` — runs once the server is listening. */
export type LifecycleReadyContext = LifecycleContext & {
    io: SocketIO;
    server: ReturnType<typeof Bun.serve>;
};

/** Context of `onDestroy` — runs on SIGINT/SIGTERM, before replication stops and DB clients close. */
export type LifecycleDestroyContext = LifecycleContext & {
    reason: LifecycleReason;
};

/**
 * Per-tenant lifecycle — one `lifecycle.ts` at the tenant root.
 *
 * @example
 * ```ts
 * export default define.Lifecycle({
 *   beforeBoot: async ({ rest, tenant }) => { await rest.insertOne('settings', { tenant: tenant.id }) },
 *   afterBoot: async ({ server, logger }) => { logger.info(`ready on :${server.port}`) },
 *   onDestroy: async ({ reason }) => { await flushSomething(reason) },
 * })
 * ```
 */
export type Lifecycle = {
    _isLifecycle_?: boolean;
    /** Injected by the loader — the tenant this lifecycle belongs to. */
    _tenant_?: string;
    /** Turn this lifecycle off without removing the file (default: true). */
    enabled?: boolean;
    /**
     * Blocking — runs after databases are connected and collections are loaded,
     * before replication starts and before the HTTP server listens. Ideal for
     * migrations, seeding, warmup. Throwing aborts the boot.
     */
    beforeBoot?: (ctx: LifecycleBootContext) => Promise<void> | void;
    /**
     * Runs once the server is listening (after `Bun.serve`). Ideal for
     * notifications and cache warming. Errors are logged, never fatal.
     */
    afterBoot?: (ctx: LifecycleReadyContext) => Promise<void> | void;
    /**
     * Runs on SIGINT/SIGTERM, before replication stops and tenant DB clients
     * close — so `rest` is still usable. Errors are logged; shutdown proceeds.
     */
    onDestroy?: (ctx: LifecycleDestroyContext) => Promise<void> | void;
    /** Max time (ms) allowed for `onDestroy` before shutdown proceeds anyway (default: 10000). */
    destroyTimeout?: number;
};
