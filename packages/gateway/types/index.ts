export interface GatewayMicroservice {
    readonly name: string;
    readonly upstream: string;
    /** Per-microservice CORS policy. Omitted inherits the global `cors`; `false` disables it. */
    readonly cors?: GatewayCorsConfig | false;
}

export type GatewayLogLevel = "info" | "error";

export interface GatewayLogEntry {
    /** ISO 8601 UTC, when the request was received. Add `durationMs` to get the end. */
    readonly timestamp: string;
    /** `error` for a 5xx response, `info` otherwise (the Caddy convention). */
    readonly level: GatewayLogLevel;
    /** Configured logger name (`logging.name`, default `gateway`). */
    readonly logger: string;
    readonly requestId: string;
    readonly method: string;
    readonly path: string;
    readonly microservice?: string;
    readonly upstream?: string;
    readonly status: number;
    readonly durationMs: number;
    /** Captured request body when `logging.captureBody` is enabled; sensitive keys are redacted. */
    readonly requestBody?: unknown;
    /** Static `logging.fields` (env, instance, version…) copied onto every line. */
    readonly [field: string]: unknown;
}

export type GatewayLogEngine = "stdout" | "file" | "duckdb";

export type GatewayLogRotation = "size" | "hourly" | "daily" | "weekly" | "monthly" | "yearly";

export interface ResolvedGatewayLogRotation {
    readonly mode: GatewayLogRotation;
    /** Bytes; only for `mode: "size"`. */
    readonly maxSize?: number;
    readonly maxFiles: number;
    readonly compress: boolean;
}

export interface GatewayBodyCaptureConfig {
    /** Maximum body size in bytes. Bodies without `Content-Length` or above the limit are not captured. Default 4096. */
    readonly maxBytes?: number;
    /** Methods whose bodies are captured. Default GET-less: POST, PUT, PATCH, DELETE. */
    readonly methods?: readonly string[];
    /** Textual content types captured. Default JSON, form-urlencoded and `text/`. */
    readonly contentTypes?: readonly string[];
    /** Object keys redacted at any depth (case-insensitive). Default password/token/secret/cookie… */
    readonly redact?: readonly string[];
}

export interface ResolvedGatewayBodyCaptureConfig {
    readonly maxBytes: number;
    readonly methods: ReadonlySet<string>;
    readonly contentTypes: readonly string[];
    readonly redact: ReadonlySet<string>;
}

export interface GatewayLoggingConfig {
    /** `false` disables request logs entirely. Default `true`. */
    readonly enabled?: boolean;
    /** `"*"` (default) logs every microservice; an array restricts the logs to those names. */
    readonly microservices?: "*" | readonly string[];
    /** Logger name copied onto every line. Default `gateway`. */
    readonly name?: string;
    /** Static fields copied onto every line (`env`, `instance`, `version`…). */
    readonly fields?: Readonly<Record<string, string>>;
    /** Where to store the lines. Default `stdout`. `file` = JSONL, `duckdb` = a DuckDB database. */
    readonly engine?: GatewayLogEngine;
    /** Path for `file` (`.logs/gateway.log`) or `duckdb` (`.logs/gateway.duckdb`). Ignored for `stdout`. */
    readonly file?: string;
    /** Rotation for the `file` engine. Omitted = the file grows without rotation. */
    readonly rotate?: GatewayLogRotation;
    /** `"10m"`, `"1g"` or bytes. Only with `rotate: "size"`; default 10 MB. */
    readonly maxSize?: number | string;
    /** Rotated files to keep. Default 5. */
    readonly maxFiles?: number;
    /** Gzip each rotated file (`.gz`). Default false. */
    readonly compress?: boolean;
    /** DuckDB only: delete rows older than this duration (`"7d"`, `"24h"`, `"30m"`). */
    readonly ttl?: string;
    /** DuckDB only: how often the TTL purge runs. Default `"1h"`. Requires `ttl`. */
    readonly purgeEvery?: string;
    /** DuckDB only: purge once at startup. Default true. Requires `ttl`. */
    readonly purgeOnStart?: boolean;
    /** Capture the request body into the log. Off by default; `true` uses the safe defaults. */
    readonly captureBody?: boolean | GatewayBodyCaptureConfig;
}

export interface GatewayCorsConfig {
    /** `"*"` or an explicit allowlist. `"*"` is refused with `credentials: true`. */
    readonly origins: "*" | readonly string[];
    readonly methods?: readonly string[];
    /** Allowed request headers. When omitted, the preflight echoes `Access-Control-Request-Headers`. */
    readonly headers?: readonly string[];
    readonly exposeHeaders?: readonly string[];
    readonly credentials?: boolean;
    /** `Access-Control-Max-Age` in seconds. Default 600. */
    readonly maxAge?: number;
}

export interface ResolvedGatewayCorsConfig {
    readonly origins: "*" | ReadonlySet<string>;
    readonly methods: readonly string[];
    readonly headers?: readonly string[];
    readonly exposeHeaders: readonly string[];
    readonly credentials: boolean;
    readonly maxAge: number;
}

export interface GatewayConfig {
    /** TCP port. `0` asks Bun for a random free port (tests, local runs). Default 8080. */
    readonly port?: number;
    readonly microservices: readonly GatewayMicroservice[];
    /** Covers connection and upstream response headers, never the response body. Default 30 000. */
    readonly timeoutMs?: number;
    /** `false`/omitted keeps the upstream CORS headers untouched. Enabled = the gateway owns CORS. */
    readonly cors?: GatewayCorsConfig | false;
    readonly logging?: GatewayLoggingConfig;
    readonly logger?: (entry: GatewayLogEntry) => void;
}

export interface ResolvedGatewayLoggingConfig {
    readonly enabled: boolean;
    readonly microservices: "*" | ReadonlySet<string>;
    readonly name: string;
    readonly fields: Readonly<Record<string, string>>;
    readonly engine: GatewayLogEngine;
    readonly file?: string;
    readonly rotate: ResolvedGatewayLogRotation | null;
    readonly ttlMs?: number;
    readonly purgeEveryMs?: number;
    readonly purgeOnStart?: boolean;
    readonly captureBody: ResolvedGatewayBodyCaptureConfig | null;
}

export interface ResolvedGatewayMicroservice {
    readonly name: string;
    readonly upstream: string;
    /** Effective CORS policy: the service override, the global default, or `null` (pass-through). */
    readonly cors: ResolvedGatewayCorsConfig | null;
}

export interface ResolvedGatewayConfig {
    readonly port: number;
    readonly timeoutMs: number;
    readonly microservices: readonly ResolvedGatewayMicroservice[];
    /** Global CORS default, used for 404s and inherited by services without an override. */
    readonly cors: ResolvedGatewayCorsConfig | null;
    readonly logging: ResolvedGatewayLoggingConfig;
    readonly logger: (entry: GatewayLogEntry) => void;
}

export type GatewayConfigErrorCode = "GATEWAY_CONFIG_INVALID";

export class GatewayConfigError extends Error {
    readonly code: GatewayConfigErrorCode = "GATEWAY_CONFIG_INVALID";

    constructor(message: string) {
        super(message);
        this.name = "GatewayConfigError";
    }
}
