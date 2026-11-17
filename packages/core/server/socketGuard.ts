import { Hono } from "hono";
import { cors } from "hono/cors";
import { ipRestriction } from "hono/ip-restriction";
import { secureHeaders } from "hono/secure-headers";
import { getConnInfo } from "hono/bun";
import type { ConnInfo, GetConnInfo } from "hono/conninfo";
import { cfg } from "./config";
import { corsOptions } from "./cors";
import { resolveClientIp } from "./clientIp";
import { engineIo, io } from "./io";
import { jwt } from "../utils/func";
import type { SocketAuthContext } from "../types/config";

/**
 * The **Socket.IO path**, guarded like the rest of the HTTP surface (#60).
 *
 * `/socket.io/` is handled by the Bun engine before Hono, so the API middlewares
 * never saw it: a cross-origin handshake was not restricted, an IP allow-list did
 * not apply, and no security header reached the polling transport. This small
 * Hono app puts the **same** `cors` and `ipRestriction` policy in front of the
 * engine, then delegates every request to it untouched.
 *
 * What the framework still does not do is **authenticate the socket**: a socket
 * connection has no tenant path, and the session/`api.access` model is HTTP
 * request rules. That is the app's job — `server.sockets.authorize` is the
 * handshake hook (`io.use`), and the tenant handlers remain free to check more.
 */
export function createSocketApp(): Hono {
    const app = new Hono();

    // Same CORS policy as the API — answers OPTIONS before the engine sees it
    app.use(cors(corsOptions()));

    // Same IP policy, resolved from the trusted proxy chain exactly like the API.
    // Registered only when a policy exists: Hono refuses an unknown address, and
    // an empty policy must never turn "no address" into a blanket 403.
    const denyList = cfg.server.ipRestriction?.denyList ?? [];
    const allowList = cfg.server.ipRestriction?.allowList ?? [];
    if (denyList.length || allowList.length) {
        const resolvedConnInfo: GetConnInfo = (c) => {
            let info: ConnInfo = { remote: {} };
            try {
                info = getConnInfo(c);
            } catch {
                // Outside a real Bun.serve (tests): there is no socket address
            }
            const { addressType, ...remote } = info.remote ?? {};
            return { remote: { ...remote, address: resolveClientIp(c.req.raw.headers, info.remote?.address) } };
        };
        app.use(ipRestriction(resolvedConnInfo, { denyList, allowList }));
    }

    // Security headers on the polling transport (a WebSocket upgrade has no headers)
    app.use(secureHeaders({
        strictTransportSecurity: true,
        xFrameOptions: true,
        xContentTypeOptions: true,
        xXssProtection: true,
        referrerPolicy: true,
        removePoweredBy: true,
        crossOriginResourcePolicy: cfg.server.security?.crossOriginResourcePolicy ?? "same-origin",
    }));

    app.all("*", (c) => engineIo.handleRequest(c.req.raw, c.env as any));
    return app;
}

/** `Authorization: Bearer …` — the only credential a browser socket can carry as a header. */
function bearer(value?: unknown): string | null {
    if (typeof value !== "string") return null;
    const match = /^Bearer\s+(.+)$/i.exec(value.trim());
    const token = match && match[1];
    return token ? token.trim() : null;
}

/**
 * The token a Socket.IO handshake carries, in the order a client is likely to use:
 * the `auth` payload (`io(url, { auth: { token } })`), an `Authorization` header
 * (Node, a mobile client), then `?token=` (a browser that cannot set headers).
 */
function handshakeToken(handshake: any): string | null {
    const fromAuth = handshake?.auth?.token;
    if (typeof fromAuth === "string" && fromAuth.trim()) return fromAuth.trim();

    const fromHeader = bearer(handshake?.headers?.authorization);
    if (fromHeader) return fromHeader;

    const fromQuery = handshake?.query?.token;
    if (typeof fromQuery === "string" && fromQuery.trim()) return fromQuery.trim();

    return null;
}

/**
 * Register `server.sockets.authorize` as a Socket.IO handshake middleware.
 *
 * Called once at boot, before `Bun.serve`. No hook → nothing is registered: the
 * transport stays open, and the tenant handlers are the only gate (the documented
 * default — see the WebSockets page).
 */
export function registerSocketAuth(): void {
    const authorize = cfg.server.sockets?.authorize;
    if (!authorize) return;

    io.use(async (socket, next) => {
        try {
            const token = handshakeToken(socket.handshake);
            let decoded: Record<string, unknown> | null = null;
            let expired = false;

            if (token) {
                const result = await jwt.verify(token);
                decoded = result.error ? null : (result.value as Record<string, unknown>);
                expired = Boolean(result.expired);
            }

            const ctx: SocketAuthContext = {
                id: socket.id,
                token,
                decoded,
                expired,
                auth: (socket.handshake.auth ?? {}) as Record<string, any>,
                headers: (socket.handshake.headers ?? {}) as Record<string, string | string[] | undefined>,
                query: (socket.handshake.query ?? {}) as Record<string, any>,
                address: (socket.handshake as any).address ?? null,
            };

            if (!(await authorize(ctx))) return next(new Error("SOCKET_UNAUTHORIZED"));
            next();
        } catch (err: any) {
            next(new Error(err?.message ?? "SOCKET_UNAUTHORIZED"));
        }
    });
}

export { handshakeToken };
