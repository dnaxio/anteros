import { GatewayConfigError } from "../types";
import { resolveCors } from "./cors";
import {
    DEFAULT_CAPTURE_CONTENT_TYPES,
    DEFAULT_CAPTURE_MAX_BYTES,
    DEFAULT_CAPTURE_METHODS,
    DEFAULT_REDACT_KEYS,
} from "./bodyCapture";
import type {
    GatewayBodyCaptureConfig,
    GatewayConfig,
    GatewayLogEntry,
    ResolvedGatewayBodyCaptureConfig,
    ResolvedGatewayConfig,
    ResolvedGatewayLoggingConfig,
    ResolvedGatewayLogRotation,
    ResolvedGatewayMicroservice,
} from "../types";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const FIELD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DEFAULT_PORT = 8080;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Fields the gateway itself writes; a `logging.fields` key must not shadow them. */
const RESERVED_LOG_FIELDS = new Set([
    "timestamp",
    "level",
    "logger",
    "requestId",
    "method",
    "path",
    "microservice",
    "upstream",
    "status",
    "durationMs",
]);

/** Identity helper: exists so a config file is typed and autocompleted. */
export function defineGateway(config: GatewayConfig): GatewayConfig {
    return config;
}

/**
 * Applies the defaults and validates the routing table. The first URL segment is the
 * microservice name and, because the path is forwarded unchanged, the Anteros tenant id
 * the backend expects — so the name must be a safe URL segment.
 */
export function resolveGatewayConfig(config: GatewayConfig): ResolvedGatewayConfig {
    if (!Array.isArray(config?.microservices) || config.microservices.length === 0) {
        throw new GatewayConfigError("microservices must be a non-empty array");
    }

    const globalCors = resolveCors(config.cors);
    const seen = new Set<string>();
    const microservices: ResolvedGatewayMicroservice[] = config.microservices.map((entry) => {
        const name = entry?.name;
        if (typeof name !== "string" || !NAME.test(name)) {
            throw new GatewayConfigError(`invalid microservice name '${name ?? ""}'`);
        }
        if (seen.has(name)) {
            throw new GatewayConfigError(`duplicate microservice name '${name}'`);
        }
        seen.add(name);

        let url: URL;
        try {
            url = new URL(entry.upstream);
        } catch {
            throw new GatewayConfigError(`invalid upstream '${entry.upstream}' for '${name}'`);
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new GatewayConfigError(`upstream for '${name}' must be http or https, got '${url.protocol}'`);
        }
        if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
            throw new GatewayConfigError(`upstream for '${name}' must be an origin, got '${entry.upstream}'`);
        }

        return {
            name,
            upstream: url.origin,
            cors: entry.cors === undefined ? globalCors : resolveCors(entry.cors),
        };
    });

    const port = config.port ?? DEFAULT_PORT;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new GatewayConfigError(`invalid port ${port}`);
    }

    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new GatewayConfigError(`invalid timeoutMs ${timeoutMs}`);
    }

    const loggingEnabled = config.logging?.enabled ?? true;
    if (typeof loggingEnabled !== "boolean") {
        throw new GatewayConfigError(`logging.enabled must be a boolean`);
    }

    const scope = config.logging?.microservices ?? "*";
    let loggingMicroservices: "*" | Set<string>;
    if (scope === "*") {
        loggingMicroservices = "*";
    } else {
        if (!Array.isArray(scope)) {
            throw new GatewayConfigError(`logging.microservices must be '*' or an array of names`);
        }
        for (const name of scope) {
            if (!seen.has(name)) {
                throw new GatewayConfigError(`logging.microservices: unknown microservice '${name}'`);
            }
        }
        loggingMicroservices = new Set(scope);
    }

    const loggingName = config.logging?.name ?? "gateway";
    if (typeof loggingName !== "string" || !FIELD_NAME.test(loggingName)) {
        throw new GatewayConfigError(`invalid logging.name '${loggingName}'`);
    }

    const engine = config.logging?.engine ?? "stdout";
    if (engine !== "stdout" && engine !== "file" && engine !== "duckdb") {
        throw new GatewayConfigError(`invalid logging.engine '${engine}'`);
    }
    if (config.logger && engine !== "stdout") {
        throw new GatewayConfigError("logger cannot be combined with logging.engine 'file' or 'duckdb'");
    }
    const file =
        engine === "stdout"
            ? undefined
            : (config.logging?.file ?? (engine === "duckdb" ? ".logs/gateway.duckdb" : ".logs/gateway.log"));
    if (file !== undefined && (typeof file !== "string" || file.trim() === "")) {
        throw new GatewayConfigError(`invalid logging.file '${file}'`);
    }

    const mode = config.logging?.rotate;
    let rotate: ResolvedGatewayLogRotation | null = null;
    if (mode) {
        if (engine !== "file") {
            throw new GatewayConfigError(`logging.rotate is only supported with logging.engine 'file'`);
        }
        if (!["size", "hourly", "daily", "weekly", "monthly", "yearly"].includes(mode)) {
            throw new GatewayConfigError(`invalid logging.rotate '${mode}'`);
        }

        const maxFiles = config.logging?.maxFiles ?? 5;
        if (!Number.isInteger(maxFiles) || maxFiles < 1) {
            throw new GatewayConfigError(`invalid logging.maxFiles ${maxFiles}`);
        }

        const compress = config.logging?.compress ?? false;
        if (typeof compress !== "boolean") {
            throw new GatewayConfigError(`logging.compress must be a boolean`);
        }

        let maxSize: number | undefined;
        if (mode === "size") {
            maxSize = parseLogSize(config.logging?.maxSize ?? 10 * 1024 * 1024);
        } else if (config.logging?.maxSize !== undefined) {
            throw new GatewayConfigError(`logging.maxSize only applies to logging.rotate 'size'`);
        }

        rotate = { mode, maxSize, maxFiles, compress };
    } else if (
        config.logging?.maxSize !== undefined ||
        config.logging?.maxFiles !== undefined ||
        config.logging?.compress !== undefined
    ) {
        throw new GatewayConfigError(`logging.maxSize/maxFiles/compress require logging.rotate`);
    }

    const ttl = config.logging?.ttl;
    let ttlMs: number | undefined;
    let purgeEveryMs: number | undefined;
    let purgeOnStart: boolean | undefined;
    if (ttl !== undefined) {
        if (engine !== "duckdb") {
            throw new GatewayConfigError(`logging.ttl is only supported with logging.engine 'duckdb'`);
        }
        ttlMs = parseDuration(ttl, "logging.ttl");
        purgeEveryMs = parseDuration(config.logging?.purgeEvery ?? "1h", "logging.purgeEvery");
        purgeOnStart = config.logging?.purgeOnStart ?? true;
        if (typeof purgeOnStart !== "boolean") {
            throw new GatewayConfigError(`logging.purgeOnStart must be a boolean`);
        }
    } else if (config.logging?.purgeEvery !== undefined || config.logging?.purgeOnStart !== undefined) {
        throw new GatewayConfigError(`logging.purgeEvery/purgeOnStart require logging.ttl`);
    }

    const captureBody = resolveBodyCapture(config.logging?.captureBody);

    const loggingFields = config.logging?.fields ?? {};
    if (typeof loggingFields !== "object" || loggingFields === null || Array.isArray(loggingFields)) {
        throw new GatewayConfigError("logging.fields must be an object of string values");
    }
    for (const [key, value] of Object.entries(loggingFields)) {
        if (!FIELD_NAME.test(key)) {
            throw new GatewayConfigError(`invalid logging.fields key '${key}'`);
        }
        if (RESERVED_LOG_FIELDS.has(key)) {
            throw new GatewayConfigError(`logging.fields cannot override '${key}'`);
        }
        if (typeof value !== "string") {
            throw new GatewayConfigError(`logging.fields['${key}'] must be a string`);
        }
    }

    return {
        port,
        timeoutMs,
        microservices,
        cors: globalCors,
        logging: {
            enabled: loggingEnabled,
            microservices: loggingMicroservices,
            name: loggingName,
            fields: { ...loggingFields },
            engine,
            file,
            rotate,
            ttlMs,
            purgeEveryMs,
            purgeOnStart,
            captureBody,
        },
        logger: config.logger ?? ((entry: GatewayLogEntry) => console.log(JSON.stringify(entry))),
    };
}

/** True when a request for `microservice` must be logged. A 404 has no microservice. */
export function shouldLogRequest(logging: ResolvedGatewayLoggingConfig, microservice?: string): boolean {
    if (!logging.enabled) return false;
    if (logging.microservices === "*") return true;
    return microservice !== undefined && logging.microservices.has(microservice);
}

/** `10m`, `1g`, `512k` or a byte count. */
function parseLogSize(value: number | string): number {
    if (typeof value === "number") {
        if (!Number.isFinite(value) || value <= 0) {
            throw new GatewayConfigError(`invalid logging.maxSize ${value}`);
        }
        return Math.floor(value);
    }

    const match = /^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb)?$/i.exec(String(value).trim());
    if (!match) {
        throw new GatewayConfigError(`invalid logging.maxSize '${value}'`);
    }

    const amount = Number(match[1]);
    const unit = (match[2] ?? "b").toLowerCase();
    const factor = unit.startsWith("g") ? 1024 ** 3 : unit.startsWith("m") ? 1024 ** 2 : unit.startsWith("k") ? 1024 : 1;
    const bytes = Math.floor(amount * factor);

    if (!Number.isFinite(bytes) || bytes <= 0) {
        throw new GatewayConfigError(`invalid logging.maxSize '${value}'`);
    }
    return bytes;
}

/** `500ms`, `30m`, `24h`, `7d`, `2w` → milliseconds. */
function parseDuration(value: string, name: string): number {
    const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i.exec(String(value).trim());
    if (!match) {
        throw new GatewayConfigError(`invalid ${name} '${value}'`);
    }

    const amount = Number(match[1]);
    const unit = match[2]!.toLowerCase();
    const factor =
        unit === "ms" ? 1
        : unit === "s" ? 1_000
        : unit === "m" ? 60_000
        : unit === "h" ? 3_600_000
        : unit === "d" ? 86_400_000
        : 604_800_000;

    const milliseconds = Math.floor(amount * factor);
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
        throw new GatewayConfigError(`invalid ${name} '${value}'`);
    }
    return milliseconds;
}

function resolveBodyCapture(
    value?: boolean | GatewayBodyCaptureConfig,
): ResolvedGatewayBodyCaptureConfig | null {
    if (!value) return null;
    const options = value === true ? {} : value;
    if (typeof options !== "object" || Array.isArray(options)) {
        throw new GatewayConfigError(`logging.captureBody must be a boolean or an object`);
    }

    const maxBytes = options.maxBytes ?? DEFAULT_CAPTURE_MAX_BYTES;
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
        throw new GatewayConfigError(`invalid logging.captureBody.maxBytes ${maxBytes}`);
    }

    const methods = options.methods ?? DEFAULT_CAPTURE_METHODS;
    if (!Array.isArray(methods) || methods.length === 0) {
        throw new GatewayConfigError(`logging.captureBody.methods must be a non-empty array`);
    }
    const normalizedMethods = methods.map((method) => {
        if (typeof method !== "string" || method.trim() === "") {
            throw new GatewayConfigError(`invalid logging.captureBody.methods entry`);
        }
        return method.toUpperCase();
    });

    const contentTypes = options.contentTypes ?? DEFAULT_CAPTURE_CONTENT_TYPES;
    if (!Array.isArray(contentTypes) || contentTypes.length === 0) {
        throw new GatewayConfigError(`logging.captureBody.contentTypes must be a non-empty array`);
    }
    for (const type of contentTypes) {
        if (typeof type !== "string" || type.trim() === "") {
            throw new GatewayConfigError(`invalid logging.captureBody.contentTypes entry`);
        }
    }

    const redact = options.redact ?? DEFAULT_REDACT_KEYS;
    if (!Array.isArray(redact)) {
        throw new GatewayConfigError(`logging.captureBody.redact must be an array`);
    }
    for (const key of redact) {
        if (typeof key !== "string" || key.trim() === "") {
            throw new GatewayConfigError(`invalid logging.captureBody.redact entry`);
        }
    }

    return {
        maxBytes,
        methods: new Set(normalizedMethods),
        contentTypes: [...new Set(contentTypes.map((type) => type.toLowerCase()))],
        redact: new Set(redact.map((key) => key.toLowerCase())),
    };
}
