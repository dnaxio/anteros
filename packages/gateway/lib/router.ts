import type { ResolvedGatewayConfig, ResolvedGatewayMicroservice } from "../types";

export interface RouteMatch {
    readonly microservice: ResolvedGatewayMicroservice;
    /** The full pathname, unchanged — the gateway never rewrites it. */
    readonly path: string;
}

/**
 * Routes `/api/<microservice>/…` (and `/api/<microservice>`) to a configured upstream.
 * The first segment is both the microservice name and the Anteros tenant id, which is
 * why the path is forwarded as-is.
 */
export function matchMicroservice(pathname: string, config: ResolvedGatewayConfig): RouteMatch | null {
    if (!pathname.startsWith("/api/")) return null;

    const name = pathname.slice(5).split("/")[0];
    if (!name) return null;

    const microservice = config.microservices.find((entry) => entry.name === name);
    if (!microservice) return null;

    return { microservice, path: pathname };
}
