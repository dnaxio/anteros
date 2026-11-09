import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadGatewayConfig } from "../lib/configFile";

describe("loadGatewayConfig", () => {
    test("imports the default export of a TypeScript config", async () => {
        const config = await loadGatewayConfig(join(import.meta.dir, "fixtures/gateway.config.ts"));
        expect(config.microservices[0]?.name).toBe("pharmacie");
        expect(config.port).toBe(0);
    });

    test("refuses a module without a default config", async () => {
        await expect(loadGatewayConfig(join(import.meta.dir, "fixtures/empty.ts"))).rejects.toThrow();
    });
});
