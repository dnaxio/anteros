import type { RouteMatch } from "./router";
import { buildDownstreamHeaders, buildUpstreamHeaders } from "./headers";

export interface ProxyContext {
    readonly timeoutMs: number;
    readonly requestId: string;
    readonly clientIp?: string;
}

function errorResponse(status: number, code: string, message: string): Response {
    return Response.json({ code, message }, { status });
}

/**
 * Forwards the request to the matched upstream and returns its response untouched.
 *
 * `decompress: false` is required: Bun's `fetch` decodes gzip automatically while leaving
 * `content-encoding` and `content-length` in place, which would hand the client a decoded
 * body labelled as compressed. The timeout covers connection and response headers only —
 * once the headers arrive the body (SSE, large download) is left alone.
 */
export async function proxyRequest(request: Request, match: RouteMatch, context: ProxyContext): Promise<Response> {
    const url = new URL(match.path, match.microservice.upstream);
    const headers = buildUpstreamHeaders(request, context);

    const method = request.method;
    const hasBody = method !== "GET" && method !== "HEAD" && request.body !== null;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, context.timeoutMs);
    const signal = AbortSignal.any([request.signal, controller.signal]);

    let upstream: Response;
    try {
        const init = {
            method,
            headers,
            body: hasBody ? request.body : null,
            redirect: "manual",
            decompress: false,
            signal,
            ...(hasBody ? { duplex: "half" } : {}),
        } as RequestInit & { duplex?: "half"; decompress?: boolean };

        upstream = await fetch(url, init);
    } catch (error) {
        if (timedOut) {
            return errorResponse(504, "UPSTREAM_TIMEOUT", `Upstream did not answer headers within ${context.timeoutMs}ms`);
        }
        return errorResponse(502, "UPSTREAM_UNAVAILABLE", (error as Error).message);
    } finally {
        clearTimeout(timer);
    }

    const body = upstream.status === 204 || upstream.status === 304 ? null : upstream.body;
    return new Response(body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: buildDownstreamHeaders(upstream),
    });
}
