import { Glob } from "bun";
import { cfg } from "../server/config";
import path from "path";
import fs from "fs/promises";
import { useRest } from "../database/rest";
import { createAgents } from "./agents";
import { createApi } from "./api";
import { io } from "../server/io";
import { logger } from "../utils/logger";
import type { WebSocketContext, WebSocketHandler } from "../types/websocket";
import type { Tenant } from "../types/tenant";

/**
 * The tenant **socket handlers** — `{tenant.dir}/sockets/**\/*.ws.ts`.
 *
 * Each file registers one `connection` listener, on the default namespace or on
 * the one it declares. `syncSockets()` is what the boot calls; `stopSockets()`
 * removes every listener, and `sockets.reload()` re-scans (a handler edited at
 * runtime, a test, a script). Registrations are tracked precisely so a reload
 * never stacks two listeners on the same socket.
 */

type Registered = {
    tenantId: string;
    handler: WebSocketHandler;
    namespace: string;
    listener: (socket: any) => void | Promise<void>;
};

const registry = new Map<string, Registered>();

function namespaceOf(handler: WebSocketHandler): string {
    const namespace = handler.namespace?.trim();
    if (!namespace) return "/";
    return namespace.startsWith("/") ? namespace : `/${namespace}`;
}

function targetOf(namespace: string) {
    // `io.of("/")` is the default namespace — the object that carries `sockets`
    // (a Map) and accepts `.on("connection")`, exactly like a custom one
    return io.of(namespace);
}

/**
 * Discover and register every handler. A broken file, a broken tenant or a
 * duplicate namespace never hides the others.
 */
async function syncSockets(): Promise<void> {
    await stopSockets();
    const definitions: WebSocketHandler[] = [];

    for (const tenant of cfg.tenants ?? []) {
        const socketsPath = path.join(process.cwd(), tenant.dir, "sockets");
        try {
            if (!(await fs.exists(socketsPath)) || !(await fs.stat(socketsPath)).isDirectory()) continue;

            const glob = new Glob(path.join(socketsPath, "**/*.ws.ts"));
            for await (const file of glob.scan(".")) {
                try {
                    const module = await import(file);
                    const handler = module?.default as WebSocketHandler | undefined;
                    if (!handler?._isWebSocket_ || !handler.enabled) continue;
                    if (typeof handler.exec !== "function") {
                        logger.error(`[socket] '${file}' has no exec() — skipped`, { tenant: tenant.id });
                        continue;
                    }

                    const namespace = namespaceOf(handler);
                    const rest = new useRest({ tenant_id: tenant.id });
                    const registered = register(tenant, handler, namespace, rest, file);
                    registry.set(`${tenant.id}:${file}`, registered);

                    const definition = { ...handler, namespace, _tenant_: tenant.id };
                    definitions.push(definition);
                    logger.file("info", "socket handler loaded", {
                        tenant: tenant.id,
                        file: path.basename(file),
                        namespace,
                    });
                } catch (err: any) {
                    logger.error(`[socket] failed to load '${file}'`, {
                        tenant: tenant.id,
                        error: err?.message,
                    });
                }
            }
        } catch (err: any) {
            logger.error(`[socket] cannot scan '${socketsPath}'`, { tenant: tenant.id, error: err?.message });
        }
    }

    cfg.sockets = definitions;
}

function register(
    tenant: Tenant,
    handler: WebSocketHandler,
    namespace: string,
    rest: InstanceType<typeof useRest>,
    file: string,
): Registered {
    const listener = async (socket: any) => {
        const ctx: WebSocketContext = {
            io,
            socket,
            rest,
            agents: createAgents(tenant.id, rest),
            api: createApi(rest),
            tenant,
        };
        try {
            // The per-handler gate runs after the global transport hook
            if (handler.authorize && !(await handler.authorize(ctx))) {
                socket.disconnect(true);
                return;
            }
            await handler.exec(ctx);
        } catch (err: any) {
            logger.error(`[socket] handler failed`, {
                tenant: tenant.id,
                file: path.basename(file),
                namespace,
                error: err?.message,
            });
            // A handler that throws must not leave a half-wired connection open
            try { socket.disconnect(true); } catch { /* already gone */ }
        }
    };

    targetOf(namespace).on("connection", listener);
    return { tenantId: tenant.id, handler, namespace, listener };
}

/**
 * Remove every registered listener. The Socket.IO server itself is untouched —
 * connections already established keep their listeners until they disconnect.
 */
async function stopSockets(): Promise<void> {
    for (const { namespace, listener } of registry.values()) {
        try { targetOf(namespace).off("connection", listener); } catch { /* already gone */ }
    }
    registry.clear();
    cfg.sockets = [];
}

/** What `/health` reports — connections, by the tenant they claim. */
function socketStats(): { total: number; tenants: Record<string, number> } {
    const namespaces = new Set<string>(["/"]);
    for (const entry of registry.values()) namespaces.add(entry.namespace);

    const seen = new Set<string>();
    const tenants: Record<string, number> = {};
    for (const namespace of namespaces) {
        const sockets = (targetOf(namespace) as any)?.sockets as Map<string, any> | undefined;
        if (!sockets) continue;
        for (const [id, socket] of sockets) {
            if (seen.has(id)) continue;
            seen.add(id);
            const tenant = String(socket?.handshake?.auth?.tenant ?? "unknown");
            tenants[tenant] = (tenants[tenant] ?? 0) + 1;
        }
    }
    return { total: seen.size, tenants };
}

/** The importable registry — `sockets.reload()`, `sockets.list()`, `sockets.stats()`. */
const sockets = {
    sync: syncSockets,
    reload: syncSockets,
    stop: stopSockets,
    stats: socketStats,
    list: () =>
        [...registry.values()].map((entry) => ({
            tenant: entry.tenantId,
            namespace: entry.namespace,
            enabled: entry.handler.enabled,
        })),
    ids: (tenantId: string): string[] =>
        [...registry.values()]
            .filter((entry) => entry.tenantId === tenantId)
            .map((entry) => entry.namespace)
            .sort(),
};

/** Backward-compatible name the boot used before `syncSockets`. */
const loadSockets = syncSockets;

export { loadSockets, socketStats, sockets, stopSockets, syncSockets };
