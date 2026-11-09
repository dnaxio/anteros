import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GatewayConfigError } from "../types";
import type { GatewayConfig } from "../types";

/** Imports the default export of a TypeScript/JavaScript gateway config file. */
export async function loadGatewayConfig(path: string): Promise<GatewayConfig> {
    const resolved = resolve(process.cwd(), path);

    let module: Record<string, unknown>;
    try {
        module = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
    } catch (error) {
        throw new GatewayConfigError(`cannot load gateway config '${path}': ${(error as Error).message}`);
    }

    const config = module.default;
    if (!config || typeof config !== "object" || !Array.isArray((config as GatewayConfig).microservices)) {
        throw new GatewayConfigError(`gateway config '${path}' must default-export defineGateway({ microservices })`);
    }

    return config as GatewayConfig;
}
