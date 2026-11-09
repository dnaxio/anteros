const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
]);

export interface UpstreamHeaderContext {
    readonly requestId: string;
    readonly clientIp?: string;
}

/** Copies the client request headers, minus hop-by-hop ones, and adds the proxy headers. */
export function buildUpstreamHeaders(request: Request, context: UpstreamHeaderContext): Headers {
    const headers = new Headers(request.headers);
    for (const name of HOP_BY_HOP) headers.delete(name);
    headers.delete("host");

    headers.set("x-request-id", context.requestId);

    const url = new URL(request.url);
    const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
    headers.set("x-forwarded-proto", proto);

    const host = request.headers.get("host");
    if (host) headers.set("x-forwarded-host", host);

    if (context.clientIp) {
        const previous = headers.get("x-forwarded-for");
        headers.set("x-forwarded-for", previous ? `${previous}, ${context.clientIp}` : context.clientIp);
    }

    return headers;
}

/** Copies the upstream response headers, minus hop-by-hop ones, keeping each Set-Cookie. */
export function buildDownstreamHeaders(upstream: Response): Headers {
    const headers = new Headers();
    for (const [name, value] of upstream.headers) {
        if (HOP_BY_HOP.has(name.toLowerCase())) continue;
        headers.set(name, value);
    }

    // `Headers` folds repeated Set-Cookie values; GetSetCookie keeps them separate.
    const cookies = upstream.headers.getSetCookie();
    headers.delete("set-cookie");
    for (const cookie of cookies) headers.append("set-cookie", cookie);

    return headers;
}
