import type { Context } from "hono";
import { cors } from "hono/cors";
import { cfg } from "./config";

/**
 * The CORS policy, resolved **once** and shared by every HTTP surface the
 * framework owns — the Hono app, and the Socket.IO engine path served before it
 * (#60). One policy means a client that may call the API may also open a socket,
 * and one that may not is refused on both.
 */

type CorsOriginOption = NonNullable<Parameters<typeof cors>[0]>["origin"];

const BASE_ALLOW_HEADERS = [
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
];

const BASE_ALLOW_METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH", "HEAD"];

export type CorsOptions = {
    origin: CorsOriginOption;
    credentials: boolean;
    allowMethods: string[];
    allowHeaders: string[];
};

export function corsOptions(): CorsOptions {
    const allowHeaders = [
        ...BASE_ALLOW_HEADERS,
        ...(cfg.server.cors?.allowHeaders as string[] || []),
    ];
    const allowMethods = [
        ...BASE_ALLOW_METHODS,
        ...(cfg.server.cors?.allowMethods as string[] || []),
    ];

    // cors — origin accepts string | string[] | function (see ServerConfig type)
    const corsConfig = cfg.server.cors?.origin;
    const credentials = cfg.server.cors?.credentials ?? false;

    // Detect a wildcard in any supported form without breaking on string/function origins
    const hasWildcardOrigin =
        corsConfig === "*" ||
        (Array.isArray(corsConfig) && corsConfig.includes("*"));

    if (credentials && (!corsConfig || hasWildcardOrigin)) {
        throw new Error(
            "CORS misconfiguration: credentials: true is incompatible with origin: *. "
            + "Set explicit origins in cfg.server.cors.origin."
        );
    }

    // Config function form: (ctx: { origin, c }) => string | string[]
    // Hono expects: (origin, c) => string | Promise<string | null | undefined> | null | undefined
    const origin =
        typeof corsConfig === "function"
            ? ((value: string, c: Context) => corsConfig({ origin: value, c })) as unknown as CorsOriginOption
            : corsConfig;

    return { origin: origin || ["*"], credentials, allowMethods, allowHeaders };
}
