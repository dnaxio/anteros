#!/usr/bin/env bun
import { createGateway } from "../index";
import { loadGatewayConfig } from "../lib/configFile";

const configPath = process.argv[2] ?? "./gateway.config.ts";

try {
    const config = await loadGatewayConfig(configPath);
    const gateway = createGateway(config);
    await gateway.ready;

    console.log(`Anteros Gateway listening on ${gateway.server.url}`);

    const shutdown = async (signal: string) => {
        console.log(`${signal} received — stopping`);
        await gateway.stop(true);
        process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
} catch (error) {
    console.error((error as Error).message);
    process.exit(1);
}
