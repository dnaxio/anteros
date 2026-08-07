import { Hono } from "hono";
import { cors } from "hono/cors"
import { compress } from 'hono/compress'
import { ipRestriction } from "hono/ip-restriction"
import { bodyLimit } from "hono/body-limit"
import { secureHeaders } from "hono/secure-headers"
import { getConnInfo } from "hono/bun"
import { cfg } from "./config"
import { rateLimit } from "./security"
import { initializeRoutes } from "./routes";
import { sessionCtxStorage, asyncContextStorage, requestCtxStorage } from "../lib/asyncContextStorage";
import { initializeApi } from "./api";
import { getGlobalMiddlewares } from "../lib/middleware";
import { jwt } from "../utils/func";
import { AppError } from "../lib/error";
import { getMetrics } from "./metrics";
import type { HonoVariables } from "./env";

const app = new Hono<{ Variables: HonoVariables }>();
function createApp(): Hono<{ Variables: HonoVariables }> {
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
    // cors
    const corsOrigin = cfg.server.cors?.origin as string[] | undefined;
    const corsCredentials = cfg.server.cors?.credentials as boolean | undefined ?? false;

    if (corsCredentials && (!corsOrigin || corsOrigin.includes('*'))) {
        throw new Error(
            'CORS misconfiguration: credentials: true is incompatible with origin: *. '
            + 'Set explicit origins in cfg.server.cors.origin.'
        );
    }



    app.use(cors({
        origin: corsOrigin || ['*'],
        credentials: corsCredentials,
        allowMethods: allowMethods,
        allowHeaders: allowHeaders,
    }));

    // compress
    app.use(compress());

    // ip restriction
    app.use(ipRestriction(getConnInfo, {
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
        return c.json(getMetrics());
    });



    // rate limiting (global)
    if (cfg.server.rateLimit?.enabled !== false) {
        app.use('*', rateLimit({
            windowMs: cfg.server.rateLimit?.windowMs ?? 60_000,
            max: cfg.server.rateLimit?.max ?? 100,
        }));

        // stricter limit for login endpoints
        app.use('/api/*/login', rateLimit({
            windowMs: cfg.server.rateLimit?.login?.windowMs ?? 60_000,
            max: cfg.server.rateLimit?.login?.max ?? 10,
        }));
    }

    //  async Context Storage
    app.use(async (c, next) => {
        return asyncContextStorage.run(new Map(), async () => {
            const traceId = crypto.randomUUID();
            const connInfo = getConnInfo(c);
            requestCtxStorage.set('trace', { id: traceId });
            requestCtxStorage.set('internal', false);



            const requestCtx: Record<string, string> = c.req.header();
            // Faille 1: never log sensitive headers (JWT, cookies)
            delete requestCtx.authorization;
            delete requestCtx.cookie;
            requestCtxStorage.set('meta', {
                request: {
                    ip: connInfo.remote.address ?? c.req.header('CF-Connecting-IP') ?? c.req.header('True-Client-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown',
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
                    expired: expired || (value != null && typeof (value as any)?.exp === 'number' && (value as any).exp * 1000 < Date.now()),
                };

                requestCtxStorage.set('token', tokenData);
                c.set('token', tokenData);
            } else {
                const emptyToken = { value: null, decoded: null, provided: false, expired: false };
                requestCtxStorage.set('token', emptyToken);
                c.set('token', emptyToken);
            }

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


    return app;
}




export {
    createApp,
    app
}
