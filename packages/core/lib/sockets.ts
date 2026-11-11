import { Glob } from "bun"
import { cfg } from "../server/config"
import path from "path"
import fs from "fs/promises"
import { useRest } from "../database/rest"
import { createAgents } from "../lib/agents"
import { createApi } from "../lib/api"
import { io } from "../server/io"
import { evaluateAccess } from "../server/access"
import * as func from "../utils/func"
import type { WebSocketHandler } from "../types/websocket"

// Socket.IO has no framework-level auth of its own. The middleware below is
// registered once at boot (after the config is loaded): every connection must
// carry a verified, tenant-bound token. `socket.data.tenant` is then the tenant
// the connection belongs to, and the handlers are filtered on it — a single
// global `/socket.io/` endpoint no longer fires every tenant's handlers.
let authRegistered = false;

function registerSocketAuth(): void {
    if (authRegistered) return;
    authRegistered = true;

    io.use(async (socket, next) => {
        try {
            const handshake = (socket.handshake ?? {}) as any;
            const rawToken = (handshake.auth?.token ?? handshake.query?.token) as string | undefined;
            if (!rawToken) return next(new Error('AUTH_REQUIRED'));

            const { value, error, expired } = await func.jwt.verify(String(rawToken));
            if (error || !value) return next(new Error(expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN'));

            const claim = value['tenant'] ?? value['_tenant_'] ?? value['tenant_id'];
            if (cfg.server.jwt?.requireTenantClaim === true && claim === undefined) {
                return next(new Error('TENANT_CLAIM_REQUIRED'));
            }

            // A token bound to a tenant may only open that tenant's handlers.
            const requestedTenant = handshake.auth?.tenant ?? handshake.query?.tenant;
            if (claim !== undefined && requestedTenant !== undefined && String(claim) !== String(requestedTenant)) {
                return next(new Error('TENANT_MISMATCH'));
            }

            socket.data.token = value;
            socket.data.rawToken = String(rawToken);
            socket.data.tenant = claim ?? requestedTenant;
            next();
        } catch {
            next(new Error('AUTH_REQUIRED'));
        }
    });
}

async function loadSockets() {
    try {
        registerSocketAuth();

        for (let tenant of cfg.tenants ?? []) {
            const TENANT_PATH = path.join(process.cwd(), tenant.dir)
            const SOCKETS_PATH = path.join(TENANT_PATH, 'sockets')
            const exist = await fs.exists(SOCKETS_PATH)
            if (!exist) continue
            const isDirectory = await (await fs.stat(SOCKETS_PATH)).isDirectory()
            if (!isDirectory) continue

            const glob = new Glob(path.join(SOCKETS_PATH, '**/*.ws.ts'))
            for await (let file of glob.scan('.')) {
                const socketModule = await import(file)
                const handler = socketModule?.default as WebSocketHandler | undefined

                if (handler?._isWebSocket_ && handler.enabled) {
                    const rest = new useRest({ tenant_id: tenant.id })
                    const label = `ws:${tenant.id}:${path.basename(file, '.ws.ts')}`

                    io.on('connection', (socket) => {
                        // Tenant scoping: this handler only runs for its own tenant.
                        if ((socket.data as any)?.tenant !== tenant.id) return;

                        const tokenData = {
                            value: (socket.data as any)?.rawToken ?? null,
                            decoded: (socket.data as any)?.token ?? null,
                            provided: true,
                            expired: false,
                        };
                        const cShim = { get: (key: string) => key === 'token' ? tokenData : undefined };

                        // Independent authorization per handler — no rule = denied.
                        evaluateAccess(
                            handler.api?.access as any,
                            'connect',
                            rest,
                            label,
                            cShim,
                            { tenant: tenant.id, socketId: socket.id },
                        )
                            .then(() => handler.exec({
                                io, rest, socket,
                                agents: createAgents(tenant.id, rest),
                                api: createApi(rest),
                            }))
                            .catch(() => {
                                socket.emit('error', { message: 'Access denied', code: 'ACCESS_DENIED' });
                                socket.disconnect(true);
                            });
                    })

                    console.log(`[socket] ${tenant.id}/${path.basename(file, '.ws.ts')} loaded`)
                }
            }
        }

    } catch (err: any) {
        console.error('[socket] Failed to load sockets:', err?.message)
    }
}

export {
    loadSockets
}
