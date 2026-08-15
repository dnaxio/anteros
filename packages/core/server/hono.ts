import { Hono, type Context } from "hono";
import { cors } from "hono/cors"
import { compress } from 'hono/compress'
import { ipRestriction } from "hono/ip-restriction"
import { bodyLimit } from "hono/body-limit"
import { secureHeaders } from "hono/secure-headers"
import { HTTPException } from "hono/http-exception"
import { getConnInfo } from "hono/bun"
import type { ConnInfo, GetConnInfo } from "hono/conninfo"
import { Redis } from "ioredis"
import { cfg } from "./config"
import { rateLimit, createRedisStore, createMemoryStore, type RateLimitStore } from "./security"
import { initializeRoutes } from "./routes";
import { asyncContextStorage, requestCtxStorage } from "../lib/asyncContextStorage";
import { initializeApi } from "./api";
import { initializeMcp } from "./mcp";
import { getGlobalMiddlewares } from "../lib/middleware";
import { jwt } from "../utils/func";
import { AppError } from "../lib/error";
import { getMetrics } from "./metrics";
import { logger } from "../utils/logger";
import type { HonoVariables } from "./env";

/**
 * Caddy-style header collection (array values); sensitive headers stripped
 * (`authorization`, `cookie`, `proxy-authorization`, `set-cookie`).
 */
export function collectHeaders(h: Headers): Record<string, string[]> {
    const EXCLUDE = ['authorization', 'cookie', 'proxy-authorization', 'set-cookie'];
    const out: Record<string, string[]> = {};
    for (const [name, value] of h.entries()) {
        const key = name.toLowerCase();
        if (EXCLUDE.includes(key)) continue;
        out[key] = [value];
    }
    return out;
}

// ─── Redis-backed rate limiting (C3) ─────────────────────────────────────────
// Lazy singleton: created once per process and reused across createApp() calls.
// Each increment falls back to the in-memory store if Redis is unavailable,
// so the limiter keeps working during a Redis outage.
let redisRateLimitStore: RateLimitStore | null | undefined;
let redisRateLimitSignature: string | undefined;

function getRedisRateLimitStore(): RateLimitStore | null {
    const rl = cfg.server.rateLimit;
    // Re-evaluate only when the rate-limit config or Redis env vars change,
    // so multiple createApp() calls (tests, hot reload) reuse the same client.
    const signature = JSON.stringify([
        rl?.useRedis,
        rl?.redis,
        process.env.REDIS_URL,
        process.env.REDIS_HOST,
        process.env.REDIS_PORT,
        process.env.REDIS_PASSWORD,
    ]);
    if (redisRateLimitSignature === signature && redisRateLimitStore !== undefined) return redisRateLimitStore;
    redisRateLimitSignature = signature;

    if (!rl) {
        redisRateLimitStore = null;
        return null;
    }

    // Redis is used AUTOMATICALLY when connection info is present (rateLimit.redis
    // block or REDIS_* env vars) — no need for useRedis: true.
    //   - useRedis: false  → force the in-memory store
    //   - useRedis: true   → force Redis even without connection info (localhost)
    //   - unset            → auto: Redis if configured, else memory
    const conn = rl.redis ?? {};
    const hasRedisConfig =
        Boolean(conn.url || conn.host || conn.port || conn.password) ||
        Boolean(process.env.REDIS_URL || process.env.REDIS_HOST || process.env.REDIS_PORT || process.env.REDIS_PASSWORD);
    const useRedis = rl.useRedis === true || (rl.useRedis !== false && hasRedisConfig);

    if (!useRedis) {
        redisRateLimitStore = null;
        return null;
    }

    try {
        const conn = rl.redis ?? {};
        // Stop reconnecting after a few attempts: a dead Redis must not spam logs
        // or keep the process alive — the limiter falls back to memory meanwhile.
        const retryStrategy = (times: number) => (times > 5 ? null : Math.min(times * 500, 3000));
        const client = conn.url
            ? new Redis(conn.url, { retryStrategy, maxRetriesPerRequest: 2 })
            : new Redis({
                host: conn.host ?? process.env.REDIS_HOST ?? 'localhost',
                port: conn.port ?? (Number(process.env.REDIS_PORT) || 6379),
                password: conn.password ?? process.env.REDIS_PASSWORD,
                retryStrategy,
                maxRetriesPerRequest: 2,
            });
        let errorLogged = false;
        client.on('error', (err) => {
            if (errorLogged) return;
            errorLogged = true;
            console.error('[rateLimit] Redis connection error:', err?.message);
        });

        const redisStore = createRedisStore(client);
        const memoryFallback = createMemoryStore();
        redisRateLimitStore = {
            async increment(key: string, windowMs: number) {
                try {
                    return await redisStore.increment(key, windowMs);
                } catch (err: any) {
                    console.error('[rateLimit] Redis store failed, falling back to in-memory:', err?.message);
                    return memoryFallback.increment(key, windowMs);
                }
            },
        };
        console.log('[rateLimit] store: Redis (with in-memory fallback)');
    } catch (err: any) {
        console.error('[rateLimit] Redis init failed, using in-memory store:', err?.message);
        redisRateLimitStore = null;
    }
    return redisRateLimitStore;
}

function createApp(): Hono<{ Variables: HonoVariables }> {
    const app = new Hono<{ Variables: HonoVariables }>();
    const allowHeaders = [
        "Tenant-Id",
        "Content-Type",
        "Authorization",
        "Accept",
        "Origin",
        "X-Requested-With",
        "Access-Control-Request-Method",
        "Access-Control-Request-Headers",
        "CF-Connecting-IP",
        "True-Client-IP",
        "X-Forwarded-For",
        "Cookie",
        "X-Forwarded-Host",
        ...(cfg.server.cors?.allowHeaders as string[] || []),
    ]
    const allowMethods = [
        "GET",
        "POST",
        "PUT",
        "DELETE",
        "OPTIONS",
        "PATCH",
        "HEAD",
        ...(cfg.server.cors?.allowMethods as string[] || []),
    ]
    // cors — origin accepts string | string[] | function (see ServerConfig type)
    const corsConfig = cfg.server.cors?.origin;
    const corsCredentials = cfg.server.cors?.credentials ?? false;

    // Detect a wildcard in any supported form without breaking on string/function origins
    const hasWildcardOrigin =
        corsConfig === '*' ||
        (Array.isArray(corsConfig) && corsConfig.includes('*'));

    if (corsCredentials && (!corsConfig || hasWildcardOrigin)) {
        throw new Error(
            'CORS misconfiguration: credentials: true is incompatible with origin: *. '
            + 'Set explicit origins in cfg.server.cors.origin.'
        );
    }

    // Config function form: (ctx: { origin, c }) => string | string[]
    // Hono expects: (origin, c) => string | Promise<string | null | undefined> | null | undefined
    type CorsOriginOption = NonNullable<Parameters<typeof cors>[0]>['origin'];
    const corsOrigin =
        typeof corsConfig === 'function'
            ? ((origin: string, c: Context) => corsConfig({ origin, c })) as unknown as CorsOriginOption
            : corsConfig;

    // Global error handler — maps AppError thrown by user routes, global
    // middlewares and useRest to their proper status/code/message.
    // (API routes keep their own errorResponse() for backward compat.)
    app.onError((err, c) => {
        // Let Hono's HTTPException respond with its own status (401/413/…)
        if (err instanceof HTTPException) {
            return err.getResponse();
        }

        const isAppError = err instanceof AppError;
        // Always log unexpected errors (default Hono behavior preserved)
        if (!isAppError) console.error(err);

        const status = isAppError ? Number(err.status) || 500 : 500;
        return c.json({
            message: isAppError ? err.message : 'Internal server error',
            code: isAppError ? err.code : 'INTERNAL_SERVER_ERROR',
            meta: isAppError ? err.meta : undefined,
        }, status as any);
    });

    // ── Client IP: resolved once per request and shared by all middlewares ──
    // getConnInfo(c) = server.requestIP() → the real socket address. Proxy headers
    // (CF-Connecting-IP / X-Forwarded-For) are ONLY trusted when cfg.server.trustProxy
    // is explicitly enabled, otherwise they are spoofable.
    // getConnInfo throws when the app runs outside a real Bun.serve (e.g. app.request()
    // in tests) → fall back to an empty address.
    const safeGetConnInfo = (c: Context): ConnInfo => {
        try {
            return getConnInfo(c);
        } catch {
            return { remote: {} };
        }
    };

    app.use(async (c, next) => {
        const connInfo = safeGetConnInfo(c);
        c.set('connInfo', connInfo);
        c.set('clientIp', cfg.server.trustProxy
            ? c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? connInfo.remote.address ?? 'unknown'
            : connInfo.remote.address ?? 'unknown');
        await next();
    });

    // Access log — registered before /health & routes so EVERY request is logged.
    // Runs around the async-context middleware, so traceId/tenant are readable here.
    // Caddy-compatible JSONL payload: `request`/`resp_headers` blocks + flat fields.
    app.use(async (c, next) => {
        const start = performance.now();
        try {
            await next();
        } finally {
            const duration = performance.now() - start;
            const trace = requestCtxStorage.get<{ id: string }>('trace');
            const conn = c.get('connInfo');
            const token = c.get('token');
            const url = new URL(c.req.raw.url);
            const uri = url.pathname + url.search;
            const ip = c.get('clientIp') ?? 'unknown';
            const remoteIp = conn?.remote?.address ?? null;
            const remotePort = conn?.remote?.port ?? null;

            logger.info(`${c.req.method} ${uri} → ${c.res.status}`, {
                logger: 'http.log.access',
                status: c.res.status,
                duration: Math.round(duration * 10) / 10,
                method: c.req.method,
                uri,
                remote_ip: remoteIp,
                bytes_read: Number(c.req.header('content-length')) || 0,
                size: Number(c.res.headers.get('content-length')) || 0,
                user_id: (token?.decoded as Record<string, unknown> | null)?.['sub'] as string ?? '',
                ip,
                traceId: trace?.id ?? crypto.randomUUID(),
                tenant: requestCtxStorage.get<string>('tenant_id') ?? null,
                request: {
                    headers: collectHeaders(c.req.raw.headers),
                    client_ip: ip,
                    host: c.req.header('host') ?? '',
                    method: c.req.method,
                    remote_ip: remoteIp,
                    remote_port: remotePort,
                    uri,
                },
                resp_headers: collectHeaders(c.res.headers),
            });
        }
    });

    // Reuse the cached connInfo instead of re-querying the socket per middleware
    const cachedGetConnInfo: GetConnInfo = (c) =>
        (c as Context<{ Variables: HonoVariables }>).get('connInfo') ?? safeGetConnInfo(c);



    app.use(cors({
        origin: corsOrigin || ['*'],
        credentials: corsCredentials,
        allowMethods: allowMethods,
        allowHeaders: allowHeaders,
    }));

    // compress
    app.use(compress());

    // ip restriction
    app.use(ipRestriction(cachedGetConnInfo, {
        denyList: cfg.server?.ipRestriction?.denyList || [],
        allowList: cfg.server?.ipRestriction?.allowList || [],
    }))

    // security headers
    app.use(secureHeaders({
        strictTransportSecurity: true,
        xFrameOptions: true,
        xContentTypeOptions: true,
        xXssProtection: true,
        referrerPolicy: true,
        removePoweredBy: true,
    }))


    // body limit
    app.use(bodyLimit({
        maxSize: cfg.server.body?.maxSize ?? 1024 * 1024 * 100, // 100MB
    }));

    // ── Health & metrics (built-in, zero dependency) ──
    app.get('/health', (c) => {
        return c.json({
            ...getMetrics(),
            ip: c.get('clientIp') ?? 'unknown',
        });
    });



    // rate limiting (global)
    if (cfg.server.rateLimit?.enabled !== false) {
        // Redis-backed store when configured (C3), in-memory otherwise
        const store = getRedisRateLimitStore() ?? undefined;

        // Distinct keys so the stricter login limit never shares counters with the global one
        const keyByClientIp = (prefix: string) => (c: Context) =>
            `rn:rl:${prefix}${(c as any).get('clientIp') ?? 'unknown'}`;

        app.use('*', rateLimit({
            windowMs: cfg.server.rateLimit?.windowMs ?? 60_000,
            max: cfg.server.rateLimit?.max ?? 100,
            store,
            keyGenerator: keyByClientIp(''),
        }));

        // stricter limit for login endpoints
        app.use('/api/*/login', rateLimit({
            windowMs: cfg.server.rateLimit?.login?.windowMs ?? 60_000,
            max: cfg.server.rateLimit?.login?.max ?? 10,
            store,
            keyGenerator: keyByClientIp('login:'),
        }));
    }

    //  async Context Storage
    app.use(async (c, next) => {
        return asyncContextStorage.run(new Map(), async () => {
            const traceId = crypto.randomUUID();
            requestCtxStorage.set('trace', { id: traceId });
            requestCtxStorage.set('internal', false);



            const requestCtx: Record<string, string> = c.req.header();
            // Faille 1: never log sensitive headers (JWT, cookies)
            delete requestCtx.authorization;
            delete requestCtx.cookie;
            requestCtxStorage.set('meta', {
                request: {
                    ip: c.get('clientIp') ?? 'unknown',
                    user_agent: c.req.header('User-Agent') ?? '',
                    headers: requestCtx,
                    method: c.req.method,
                    path: c.req.path,
                    query: c.req.query(),
                },
                environment: Bun.env.NODE_ENV || process.env.NODE_ENV || 'dev',
                hostname: Bun.env.HOSTNAME || process.env.HOSTNAME || 'localhost',
                platform: Bun.env.PLATFORM || process.env.PLATFORM || 'unknown',
            })
            const bearer = c.req.header('Authorization')?.replace('Bearer ', '');
            if (bearer) {
                const { value, error, expired } = await jwt.verify(bearer);
                const isValid = !error && value != null;

                const tokenData = {
                    value: isValid ? bearer : null,
                    decoded: isValid ? (value as Record<string, unknown>) : null,
                    provided: true,
                    // jwt.verify already flags expiry (expired: true, value: null)
                    expired,
                };

                requestCtxStorage.set('token', tokenData);
                c.set('token', tokenData);
            } else {
                const emptyToken = { value: null, decoded: null, provided: false, expired: false };
                requestCtxStorage.set('token', emptyToken);
                c.set('token', emptyToken);
            }

            // (access log is a dedicated middleware registered earlier — see top of createApp)

            return await next();
        })
    })

    // Global user-defined middlewares — has access to requestCtxStorage, asyncContextStorage, etc.
    for (const mw of getGlobalMiddlewares()) {
        app.use(mw.handler);
    }

    // initialize routes
    initializeRoutes(app);

    // initialize api
    initializeApi(app);

    // initialize MCP (tools served at /mcp/:tenant_id)
    initializeMcp(app);


    return app;
}




export {
    createApp
}
