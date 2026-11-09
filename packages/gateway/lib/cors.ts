import { GatewayConfigError } from "../types";
import type { GatewayCorsConfig, ResolvedGatewayCorsConfig } from "../types";

const DEFAULT_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const DEFAULT_MAX_AGE = 600;

/** Validates the CORS block. `undefined`/`false` means "pass the upstream CORS headers through". */
export function resolveCors(config?: GatewayCorsConfig | false): ResolvedGatewayCorsConfig | null {
    if (!config) return null;
    if (typeof config !== "object" || Array.isArray(config)) {
        throw new GatewayConfigError("cors must be an object or false");
    }

    const origins = config.origins;
    if (origins !== "*" && (!Array.isArray(origins) || origins.length === 0)) {
        throw new GatewayConfigError(`cors.origins must be '*' or a non-empty array`);
    }
    if (origins !== "*") {
        for (const origin of origins) {
            if (typeof origin !== "string" || origin.trim() === "") {
                throw new GatewayConfigError(`cors.origins contains an invalid origin`);
            }
        }
    }

    const credentials = config.credentials ?? false;
    if (credentials && origins === "*") {
        throw new GatewayConfigError(`cors.credentials cannot be used with origins '*'`);
    }

    const methods = (config.methods ?? DEFAULT_METHODS).map((method) => {
        if (typeof method !== "string" || !/^[A-Za-z]+$/.test(method)) {
            throw new GatewayConfigError(`invalid CORS method '${method}'`);
        }
        return method.toUpperCase();
    });

    const headers = config.headers ? normalizeList(config.headers, "cors.headers") : undefined;
    const exposeHeaders = config.exposeHeaders ? normalizeList(config.exposeHeaders, "cors.exposeHeaders") : [];

    const maxAge = config.maxAge ?? DEFAULT_MAX_AGE;
    if (!Number.isInteger(maxAge) || maxAge < 0) {
        throw new GatewayConfigError(`invalid cors.maxAge ${maxAge}`);
    }

    return {
        origins: origins === "*" ? "*" : new Set(origins),
        methods: [...new Set(methods)],
        headers,
        exposeHeaders,
        credentials,
        maxAge,
    };
}

function normalizeList(values: readonly string[], name: string): string[] {
    for (const value of values) {
        if (typeof value !== "string" || value.trim() === "") {
            throw new GatewayConfigError(`${name} contains an invalid value`);
        }
    }
    return [...new Set(values)];
}

/** A browser preflight: `OPTIONS` + `Origin` + `Access-Control-Request-Method`. */
export function isPreflight(request: Request): boolean {
    return (
        request.method === "OPTIONS" &&
        request.headers.get("origin") !== null &&
        request.headers.get("access-control-request-method") !== null
    );
}

export function isOriginAllowed(cors: ResolvedGatewayCorsConfig, origin: string | null): boolean {
    if (!origin) return false;
    return cors.origins === "*" || cors.origins.has(origin);
}

/** Answers a preflight locally; no upstream is contacted. */
export function preflightResponse(cors: ResolvedGatewayCorsConfig, request: Request): Response {
    const origin = request.headers.get("origin");
    const headers = new Headers();
    if (cors.origins !== "*") addVary(headers, "Origin");

    if (isOriginAllowed(cors, origin)) {
        headers.set("access-control-allow-origin", cors.origins === "*" && !cors.credentials ? "*" : origin!);
        headers.set("access-control-allow-methods", cors.methods.join(", "));

        if (cors.headers) {
            headers.set("access-control-allow-headers", cors.headers.join(", "));
        } else {
            const requested = request.headers.get("access-control-request-headers");
            if (requested) headers.set("access-control-allow-headers", requested);
        }

        if (cors.credentials) headers.set("access-control-allow-credentials", "true");
        headers.set("access-control-max-age", String(cors.maxAge));
    }

    return new Response(null, { status: 204, headers });
}

/**
 * Applies the gateway's CORS policy to an upstream response. Upstream CORS headers are
 * always removed when the gateway owns CORS — two `Access-Control-Allow-Origin` values
 * make browsers reject the response.
 */
export function applyCors(response: Response, cors: ResolvedGatewayCorsConfig, origin: string | null): Response {
    const headers = cloneHeaders(response);
    removeCorsHeaders(headers);

    if (cors.origins !== "*") addVary(headers, "Origin");

    if (isOriginAllowed(cors, origin)) {
        headers.set("access-control-allow-origin", cors.origins === "*" && !cors.credentials ? "*" : origin!);
        if (cors.credentials) headers.set("access-control-allow-credentials", "true");
        if (cors.exposeHeaders.length > 0) {
            headers.set("access-control-expose-headers", cors.exposeHeaders.join(", "));
        }
    }

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function cloneHeaders(response: Response): Headers {
    const headers = new Headers(response.headers);
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) {
        headers.delete("set-cookie");
        for (const cookie of cookies) headers.append("set-cookie", cookie);
    }
    return headers;
}

function removeCorsHeaders(headers: Headers): void {
    for (const name of [...headers.keys()]) {
        if (name.toLowerCase().startsWith("access-control-")) headers.delete(name);
    }
}

function addVary(headers: Headers, value: string): void {
    const current = headers.get("vary");
    const values = current?.split(",").map((part) => part.trim().toLowerCase()) ?? [];
    if (values.includes(value.toLowerCase())) return;
    headers.set("vary", current ? `${current}, ${value}` : value);
}
