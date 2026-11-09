import { describe, expect, test } from "bun:test";
import { defineGateway, resolveGatewayConfig } from "../index";
import { matchMicroservice } from "../lib/router";

const config = resolveGatewayConfig(
    defineGateway({
        microservices: [
            { name: "pharmacie", upstream: "http://pharmacie:4000" },
            { name: "stats", upstream: "http://stats:4000" },
        ],
    }),
);

describe("matchMicroservice", () => {
    test("matches the first segment and keeps the path unchanged", () => {
        const match = matchMicroservice("/api/pharmacie/collections/ordonnances/find", config);
        expect(match?.microservice.name).toBe("pharmacie");
        expect(match?.path).toBe("/api/pharmacie/collections/ordonnances/find");
    });

    test("matches without a trailing segment or slash", () => {
        expect(matchMicroservice("/api/stats", config)?.path).toBe("/api/stats");
        expect(matchMicroservice("/api/stats/", config)?.path).toBe("/api/stats/");
    });

    test("returns null outside /api and for an unknown microservice", () => {
        expect(matchMicroservice("/health", config)).toBeNull();
        expect(matchMicroservice("/api/", config)).toBeNull();
        expect(matchMicroservice("/api/inconnu/x", config)).toBeNull();
        expect(matchMicroservice("/api//x", config)).toBeNull();
    });
});
