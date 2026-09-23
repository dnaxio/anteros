import path from "path";
import fs from "fs/promises";
import { cfg } from "../server/config";
import { useRest } from "../database/rest";
import { createAgents } from "./agents";
import { createApi } from "./api";
import { logger } from "../utils/logger";
import {
    replicationNow,
    getReplicationState,
    resetReplication,
    seedReplication,
} from "../database/replication";
import type { Lifecycle, LifecycleReason } from "../types/lifecycle";
import type { Tenant } from "../types/tenant";
import type { TenantReplicationApi } from "../types/replication";

/**
 * Tenant-scoped replication API — like `rest`, the tenant is implicit. Built per
 * tenant for the lifecycle context, so hooks never pass a tenant id.
 */
function tenantReplication(tenantId: string): TenantReplicationApi {
    return {
        now: () => replicationNow(tenantId),
        state: (destinationId?: string, collection?: string) => getReplicationState(tenantId, destinationId, collection),
        reset: (opts) => resetReplication(tenantId, opts),
        seed: (value, opts) => seedReplication(tenantId, value, opts),
    };
}

/** Lifecycles by tenant id — one `{tenant.dir}/lifecycle.ts` per tenant. */
const lifecycles = new Map<string, Lifecycle>();
/** Ensures `onDestroy` runs at most once per process. */
let destroyed = false;

/**
 * Load `{tenant.dir}/lifecycle.ts` for every tenant. A missing file is fine —
 * a tenant simply has no lifecycle.
 */
async function loadLifecycles(): Promise<void> {
    lifecycles.clear();
    destroyed = false;
    for (const tenant of cfg.tenants ?? []) {
        try {
            const file = path.join(process.cwd(), tenant.dir, "lifecycle.ts");
            if (!(await fs.exists(file))) continue;
            const module = await import(file);
            const lifecycle = module?.default;
            if (lifecycle?._isLifecycle_) {
                lifecycles.set(tenant.id, { ...lifecycle, _tenant_: tenant.id });
            }
        } catch (err: any) {
            logger.file("error", "lifecycle: failed to load", { tenant: tenant.id, error: err?.message });
        }
    }
}

/** Tenant-scoped context passed to every hook. */
function buildContext(tenant: Tenant, extra?: Record<string, any>) {
    const rest = new useRest({ tenant_id: tenant.id });
    return {
        tenant,
        rest,
        // Tenant-scoped LLM registry — a lifecycle hook can seed/refresh an agent
        agents: createAgents(tenant.id, rest),
        api: createApi(rest),
        logger,
        cfg,
        replication: tenantReplication(tenant.id),
        ...(extra ?? {}),
    } as any;
}

/**
 * Run every `beforeBoot` hook, sequentially in `cfg.tenants` order. Blocking:
 * a throwing hook aborts the boot (fail-fast).
 */
async function runBeforeBoot(): Promise<void> {
    for (const tenant of cfg.tenants ?? []) {
        const lifecycle = lifecycles.get(tenant.id);
        if (!lifecycle?.enabled || !lifecycle.beforeBoot) continue;
        try {
            await lifecycle.beforeBoot(buildContext(tenant));
            logger.file("lifecycle: beforeBoot", { tenant: tenant.id });
        } catch (err: any) {
            logger.error(`lifecycle beforeBoot failed for tenant '${tenant.id}'`, { error: err?.message, stack: err?.stack });
            throw new Error(`[${tenant.id}] lifecycle beforeBoot failed: ${err?.message ?? err}`);
        }
    }
}

/**
 * Run every `afterBoot` hook once the server is listening. Errors are logged
 * but never fatal — the server is already serving.
 */
async function runAfterBoot(server: any, io: any): Promise<void> {
    for (const tenant of cfg.tenants ?? []) {
        const lifecycle = lifecycles.get(tenant.id);
        if (!lifecycle?.enabled || !lifecycle.afterBoot) continue;
        try {
            await lifecycle.afterBoot(buildContext(tenant, { io, server }));
            logger.file("lifecycle: afterBoot", { tenant: tenant.id });
        } catch (err: any) {
            logger.error(`lifecycle afterBoot failed for tenant '${tenant.id}'`, { error: err?.message });
        }
    }
}

/** Bound a promise with a timeout that rejects. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Run every `onDestroy` hook on shutdown (once per process), before replication
 * stops and DB clients close. Each hook is bounded by `destroyTimeout`.
 */
async function runOnDestroy(reason: LifecycleReason): Promise<void> {
    if (destroyed) return;
    destroyed = true;

    for (const tenant of cfg.tenants ?? []) {
        const lifecycle = lifecycles.get(tenant.id);
        if (!lifecycle?.enabled || !lifecycle.onDestroy) continue;
        try {
            await withTimeout(
                Promise.resolve(lifecycle.onDestroy(buildContext(tenant, { reason }))),
                lifecycle.destroyTimeout ?? 10_000,
                `lifecycle onDestroy timed out after ${lifecycle.destroyTimeout ?? 10_000}ms`,
            );
            logger.file("lifecycle: onDestroy", { tenant: tenant.id, reason });
        } catch (err: any) {
            logger.error(`lifecycle onDestroy failed for tenant '${tenant.id}'`, { error: err?.message });
        }
    }
}

export {
    loadLifecycles,
    runBeforeBoot,
    runAfterBoot,
    runOnDestroy,
};
