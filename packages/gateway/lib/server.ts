import { Hono } from "hono";
import { getConnInfo } from "hono/bun";
import { matchMicroservice } from "./router";
import { proxyRequest } from "./proxy";
import { applyCors, isPreflight, preflightResponse } from "./cors";
import { resolveGatewayConfig, shouldLogRequest } from "./config";
import { captureRequestBody } from "./bodyCapture";
import { createLogSink } from "./logSink";
import type { GatewayConfig, GatewayLogEntry, ResolvedGatewayConfig } from "../types";

export interface Gateway {
    readonly server: ReturnType<typeof Bun.serve>;
    readonly config: ResolvedGatewayConfig;
    /** Resolves when the configured log sink is ready (DuckDB opens asynchronously). */
    readonly ready: Promise<void>;
    stop(force?: boolean): Promise<void>;
}

/**
 * Starts the passive reverse proxy: `/health` locally, every `/api/<microservice>/…` to
 * its upstream, everything else 404. No request is authenticated or rewritten here.
 */
export function createGateway(config: GatewayConfig): Gateway {
    const resolved = resolveGatewayConfig(config);
    const app = new Hono();
    const sink = createLogSink(resolved.logging, config.logger);

    // Logging is observability, not control: the sink swallows its own failures.
    const writeLog = (entry: GatewayLogEntry): void => sink.write(entry);

    app.get("/health", (c) => c.json({ status: "ok", microservices: resolved.microservices.map((entry) => entry.name) }));

    app.all("*", async (c) => {
        const url = new URL(c.req.url);
        const match = matchMicroservice(url.pathname, resolved);
        const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
        const started = performance.now();
        const timestamp = new Date().toISOString();
        const origin = c.req.header("origin") ?? null;

        let clientIp: string | undefined;
        try {
            clientIp = getConnInfo(c).remote.address;
        } catch {
            // No socket information (tests, non-Bun runtimes): leave it undefined.
        }

        if (!match) {
            const notFound = c.json(
                { code: "MICROSERVICE_NOT_FOUND", message: `No microservice for '${url.pathname}'` },
                404,
            );
            const response = resolved.cors ? applyCors(notFound, resolved.cors, origin) : notFound;
            if (shouldLogRequest(resolved.logging)) {
                writeLog({
                    ...resolved.logging.fields,
                    timestamp,
                    level: "info",
                    logger: resolved.logging.name,
                    requestId,
                    method: c.req.method,
                    path: url.pathname,
                    status: 404,
                    durationMs: Math.round(performance.now() - started),
                });
            }
            return response;
        }

        if (match.microservice.cors && isPreflight(c.req.raw)) {
            const response = preflightResponse(match.microservice.cors, c.req.raw);
            if (shouldLogRequest(resolved.logging, match.microservice.name)) {
                writeLog({
                    ...resolved.logging.fields,
                    timestamp,
                    level: "info",
                    logger: resolved.logging.name,
                    requestId,
                    method: c.req.method,
                    path: url.pathname,
                    microservice: match.microservice.name,
                    status: 204,
                    durationMs: Math.round(performance.now() - started),
                });
            }
            return response;
        }

        const requestBody = await captureRequestBody(c.req.raw, resolved.logging.captureBody);
        const upstreamResponse = await proxyRequest(c.req.raw, match, {
            timeoutMs: resolved.timeoutMs,
            requestId,
            clientIp,
        });
        const serviceCors = match.microservice.cors;
        const response = serviceCors ? applyCors(upstreamResponse, serviceCors, origin) : upstreamResponse;
        if (shouldLogRequest(resolved.logging, match.microservice.name)) {
            writeLog({
                ...resolved.logging.fields,
                timestamp,
                level: response.status >= 500 ? "error" : "info",
                logger: resolved.logging.name,
                requestId,
                method: c.req.method,
                path: url.pathname,
                microservice: match.microservice.name,
                upstream: match.microservice.upstream,
                status: response.status,
                durationMs: Math.round(performance.now() - started),
                ...(requestBody !== undefined ? { requestBody } : {}),
            });
        }
        return response;
    });

    const server = Bun.serve({
        port: resolved.port,
        fetch: (request, bunServer) => app.fetch(request, bunServer as never),
    });

    let stopped = false;

    return {
        server,
        config: resolved,
        ready: sink.ready,
        stop: async (force = true) => {
            if (stopped) return;
            stopped = true;
            server.stop(force);
            await sink.close();
        },
    };
}
