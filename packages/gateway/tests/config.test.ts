import { describe, expect, test } from "bun:test";
import { defineGateway, GatewayConfigError, resolveGatewayConfig } from "../index";

const valid = defineGateway({
    microservices: [
        { name: "pharmacie", upstream: "http://pharmacie:4000" },
        { name: "stats", upstream: "https://stats.internal" },
    ],
});

describe("resolveGatewayConfig", () => {
    test("applies the defaults and keeps the routing table", () => {
        const config = resolveGatewayConfig(valid);
        expect(config.port).toBe(8080);
        expect(config.timeoutMs).toBe(30_000);
        expect(config.microservices).toHaveLength(2);
    });

    test("refuses a duplicate microservice name", () => {
        expect(() =>
            resolveGatewayConfig(
                defineGateway({
                    microservices: [
                        { name: "stats", upstream: "http://a:4000" },
                        { name: "stats", upstream: "http://b:4000" },
                    ],
                }),
            ),
        ).toThrow(GatewayConfigError);
    });

    test("refuses a name that is not a safe URL segment", () => {
        expect(() =>
            resolveGatewayConfig(defineGateway({ microservices: [{ name: "a/b", upstream: "http://a:4000" }] })),
        ).toThrow(GatewayConfigError);
    });

    test("refuses an upstream with a path, a query, or a non-http scheme", () => {
        for (const upstream of ["ftp://a", "http://a/base", "http://a/?x=1", "not a url"]) {
            expect(() =>
                resolveGatewayConfig(defineGateway({ microservices: [{ name: "a", upstream }] })),
            ).toThrow(GatewayConfigError);
        }
    });

    test("refuses invalid port and timeout values", () => {
        expect(() => resolveGatewayConfig(defineGateway({ port: -1, microservices: valid.microservices }))).toThrow(
            GatewayConfigError,
        );
        expect(() =>
            resolveGatewayConfig(defineGateway({ timeoutMs: -1, microservices: valid.microservices })),
        ).toThrow(GatewayConfigError);
    });

    test("accepts port 0 (random port for tests and local runs)", () => {
        expect(resolveGatewayConfig(defineGateway({ port: 0, microservices: valid.microservices })).port).toBe(0);
    });

    test("logs every microservice by default", () => {
        const config = resolveGatewayConfig(valid);
        expect(config.logging.enabled).toBe(true);
        expect(config.logging.microservices).toBe("*");
    });

    test("restricts logging to a subset and refuses an unknown name", () => {
        const config = resolveGatewayConfig(
            defineGateway({ microservices: valid.microservices, logging: { microservices: ["pharmacie"] } }),
        );
        expect(config.logging.microservices).toBeInstanceOf(Set);
        expect([...(config.logging.microservices as Set<string>)]).toEqual(["pharmacie"]);

        expect(() =>
            resolveGatewayConfig(
                defineGateway({ microservices: valid.microservices, logging: { microservices: ["inconnu"] } }),
            ),
        ).toThrow(GatewayConfigError);
    });

    test("can disable request logging", () => {
        const config = resolveGatewayConfig(
            defineGateway({ microservices: valid.microservices, logging: { enabled: false } }),
        );
        expect(config.logging.enabled).toBe(false);
    });

    test("defaults the logger name and the static fields", () => {
        const config = resolveGatewayConfig(valid);
        expect(config.logging.name).toBe("gateway");
        expect(config.logging.fields).toEqual({});
    });

    test("accepts a logger name and static fields", () => {
        const config = resolveGatewayConfig(
            defineGateway({
                microservices: valid.microservices,
                logging: { name: "gw-1", fields: { env: "prod", instance: "i-1", version: "0.0.1" } },
            }),
        );
        expect(config.logging.name).toBe("gw-1");
        expect(config.logging.fields).toEqual({ env: "prod", instance: "i-1", version: "0.0.1" });
    });

    test("refuses a static field that shadows a gateway field", () => {
        expect(() =>
            resolveGatewayConfig(
                defineGateway({ microservices: valid.microservices, logging: { fields: { level: "debug" } } }),
            ),
        ).toThrow(GatewayConfigError);
    });

    test("refuses an invalid static field key or value", () => {
        expect(() =>
            resolveGatewayConfig(
                defineGateway({ microservices: valid.microservices, logging: { fields: { "bad key": "x" } } }),
            ),
        ).toThrow(GatewayConfigError);
        expect(() =>
            resolveGatewayConfig(
                defineGateway({ microservices: valid.microservices, logging: { fields: { env: 1 as any } } }),
            ),
        ).toThrow(GatewayConfigError);
    });

    test("refuses CORS credentials with a wildcard origin", () => {
        expect(() =>
            resolveGatewayConfig(
                defineGateway({ microservices: valid.microservices, cors: { origins: "*", credentials: true } }),
            ),
        ).toThrow(GatewayConfigError);
    });

    test("resolves CORS per microservice with the global policy as default", () => {
        const config = resolveGatewayConfig(
            defineGateway({
                cors: { origins: ["https://app.example.com"] },
                microservices: [
                    { name: "pharmacie", upstream: "http://pharmacie:4000", cors: { origins: ["https://pharma.example.com"] } },
                    { name: "stats", upstream: "http://stats:4000", cors: false },
                    { name: "auth", upstream: "http://auth:4000" },
                ],
            }),
        );

        const byName = new Map(config.microservices.map((entry) => [entry.name, entry]));
        expect([...(byName.get("pharmacie")!.cors!.origins as Set<string>)]).toEqual(["https://pharma.example.com"]);
        expect(byName.get("stats")!.cors).toBeNull();
        expect([...(byName.get("auth")!.cors!.origins as Set<string>)]).toEqual(["https://app.example.com"]);
    });

    test("a microservice can enable CORS without a global policy", () => {
        const config = resolveGatewayConfig(
            defineGateway({
                microservices: [
                    { name: "pharmacie", upstream: "http://pharmacie:4000", cors: { origins: ["https://pharma.example.com"] } },
                    { name: "stats", upstream: "http://stats:4000" },
                ],
            }),
        );

        expect(config.cors).toBeNull();
        expect(config.microservices[0]?.cors).not.toBeNull();
        expect(config.microservices[1]?.cors).toBeNull();
    });

    test("defaults the log engine to stdout", () => {
        const config = resolveGatewayConfig(valid);
        expect(config.logging.engine).toBe("stdout");
        expect(config.logging.file).toBeUndefined();
    });

    test("defaults the file and duckdb log paths", () => {
        const file = resolveGatewayConfig(
            defineGateway({ microservices: valid.microservices, logging: { engine: "file" } }),
        );
        expect(file.logging.file).toBe(".logs/gateway.log");

        const duckdb = resolveGatewayConfig(
            defineGateway({ microservices: valid.microservices, logging: { engine: "duckdb" } }),
        );
        expect(duckdb.logging.file).toBe(".logs/gateway.duckdb");
    });

    test("resolves size rotation with human-readable sizes", () => {
        const config = resolveGatewayConfig(
            defineGateway({
                microservices: valid.microservices,
                logging: { engine: "file", rotate: "size", maxSize: "1k", maxFiles: 3, compress: true },
            }),
        );
        expect(config.logging.rotate).toEqual({ mode: "size", maxSize: 1024, maxFiles: 3, compress: true });
    });

    test("defaults size rotation to 10 MB and 5 files", () => {
        const config = resolveGatewayConfig(
            defineGateway({ microservices: valid.microservices, logging: { engine: "file", rotate: "size" } }),
        );
        expect(config.logging.rotate).toEqual({ mode: "size", maxSize: 10 * 1024 * 1024, maxFiles: 5, compress: false });
    });

    test("accepts calendar rotation without maxSize", () => {
        const config = resolveGatewayConfig(
            defineGateway({ microservices: valid.microservices, logging: { engine: "file", rotate: "daily" } }),
        );
        expect(config.logging.rotate).toEqual({ mode: "daily", maxSize: undefined, maxFiles: 5, compress: false });
    });

    test("refuses rotation without the file engine, and maxSize without rotation", () => {
        expect(() =>
            resolveGatewayConfig(
                defineGateway({ microservices: valid.microservices, logging: { engine: "duckdb", rotate: "daily" } }),
            ),
        ).toThrow(GatewayConfigError);

        expect(() =>
            resolveGatewayConfig(
                defineGateway({ microservices: valid.microservices, logging: { engine: "file", maxSize: "1m" } }),
            ),
        ).toThrow(GatewayConfigError);

        expect(() =>
            resolveGatewayConfig(
                defineGateway({ microservices: valid.microservices, logging: { engine: "file", rotate: "daily", maxSize: "1m" } }),
            ),
        ).toThrow(GatewayConfigError);
    });

    test("resolves the DuckDB TTL and its purge defaults", () => {
        const config = resolveGatewayConfig(
            defineGateway({ microservices: valid.microservices, logging: { engine: "duckdb", ttl: "7d" } }),
        );
        expect(config.logging.ttlMs).toBe(7 * 86_400_000);
        expect(config.logging.purgeEveryMs).toBe(3_600_000);
        expect(config.logging.purgeOnStart).toBe(true);
    });

    test("accepts TTL units and purge overrides", () => {
        const config = resolveGatewayConfig(
            defineGateway({
                microservices: valid.microservices,
                logging: { engine: "duckdb", ttl: "500ms", purgeEvery: "30s", purgeOnStart: false },
            }),
        );
        expect(config.logging.ttlMs).toBe(500);
        expect(config.logging.purgeEveryMs).toBe(30_000);
        expect(config.logging.purgeOnStart).toBe(false);
    });

    test("refuses TTL outside DuckDB and purge options without TTL", () => {
        expect(() =>
            resolveGatewayConfig(
                defineGateway({ microservices: valid.microservices, logging: { engine: "file", ttl: "7d" } }),
            ),
        ).toThrow(GatewayConfigError);

        expect(() =>
            resolveGatewayConfig(
                defineGateway({ microservices: valid.microservices, logging: { engine: "duckdb", purgeEvery: "1h" } }),
            ),
        ).toThrow(GatewayConfigError);
    });

    test("resolves body capture with safe defaults", () => {
        const config = resolveGatewayConfig(
            defineGateway({ microservices: valid.microservices, logging: { captureBody: true } }),
        );
        const body = config.logging.captureBody!;

        expect(body.maxBytes).toBe(4096);
        expect(body.methods.has("POST")).toBe(true);
        expect(body.methods.has("GET")).toBe(false);
        expect(body.contentTypes).toContain("application/json");
        expect(body.contentTypes).toContain("text/");
        expect(body.redact.has("password")).toBe(true);
        expect(body.redact.has("token")).toBe(true);
    });

    test("accepts body capture overrides and refuses invalid values", () => {
        const config = resolveGatewayConfig(
            defineGateway({
                microservices: valid.microservices,
                logging: {
                    captureBody: {
                        maxBytes: 1024,
                        methods: ["post"],
                        contentTypes: ["application/json"],
                        redact: ["password"],
                    },
                },
            }),
        );
        expect(config.logging.captureBody).toEqual({
            maxBytes: 1024,
            methods: new Set(["POST"]),
            contentTypes: ["application/json"],
            redact: new Set(["password"]),
        });

        expect(() =>
            resolveGatewayConfig(
                defineGateway({ microservices: valid.microservices, logging: { captureBody: { maxBytes: 0 } } }),
            ),
        ).toThrow(GatewayConfigError);
        expect(() =>
            resolveGatewayConfig(
                defineGateway({ microservices: valid.microservices, logging: { captureBody: { methods: [] } } }),
            ),
        ).toThrow(GatewayConfigError);
    });

    test("refuses a custom logger combined with a file engine", () => {
        expect(() =>
            resolveGatewayConfig(
                defineGateway({
                    microservices: valid.microservices,
                    logging: { engine: "file" },
                    logger: () => {},
                }),
            ),
        ).toThrow(GatewayConfigError);
    });

    test("refuses an unknown log engine", () => {
        expect(() =>
            resolveGatewayConfig(
                defineGateway({
                    microservices: valid.microservices,
                    logging: { engine: "sqlite" as any },
                }),
            ),
        ).toThrow(GatewayConfigError);
    });
});
