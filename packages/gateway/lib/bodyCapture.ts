import type { ResolvedGatewayBodyCaptureConfig } from "../types";

export const DEFAULT_CAPTURE_MAX_BYTES = 4096;
export const DEFAULT_CAPTURE_METHODS = ["POST", "PUT", "PATCH", "DELETE"];
export const DEFAULT_CAPTURE_CONTENT_TYPES = [
    "application/json",
    "application/x-www-form-urlencoded",
    "text/",
];
export const DEFAULT_REDACT_KEYS = [
    "password",
    "passwd",
    "pwd",
    "token",
    "access_token",
    "refresh_token",
    "authorization",
    "secret",
    "api_key",
    "apikey",
    "cookie",
    "pin",
    "otp",
];

/**
 * Captures a request body for the log without touching what is forwarded upstream:
 * `request.clone()` reads a bounded copy. Bodies without `Content-Length`, above
 * `maxBytes`, or with a non-textual content type are skipped.
 */
export async function captureRequestBody(
    request: Request,
    config: ResolvedGatewayBodyCaptureConfig | null,
): Promise<unknown> {
    if (!config || !config.methods.has(request.method.toUpperCase())) return undefined;

    const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
    if (!matchesContentType(contentType, config.contentTypes)) return undefined;

    const lengthHeader = request.headers.get("content-length");
    if (!lengthHeader) return undefined;
    const length = Number(lengthHeader);
    if (!Number.isFinite(length) || length <= 0 || length > config.maxBytes) return undefined;

    try {
        const text = await request.clone().text();
        return redact(parseBody(text, contentType), config.redact);
    } catch {
        return undefined;
    }
}

function matchesContentType(contentType: string, allowed: readonly string[]): boolean {
    return allowed.some((type) => {
        if (type.endsWith("/")) return contentType.startsWith(type);
        if (type === "application/json" && contentType.endsWith("+json")) return true;
        return contentType === type || contentType.startsWith(`${type};`);
    });
}

function parseBody(text: string, contentType: string): unknown {
    if (contentType.includes("json")) {
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }

    if (contentType.startsWith("application/x-www-form-urlencoded")) {
        const fields: Record<string, string> = {};
        for (const [key, value] of new URLSearchParams(text)) fields[key] = value;
        return fields;
    }

    return text;
}

function redact(value: unknown, keys: ReadonlySet<string>): unknown {
    if (Array.isArray(value)) return value.map((entry) => redact(entry, keys));

    if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) {
            out[key] = keys.has(key.toLowerCase()) ? "[redacted]" : redact(entry, keys);
        }
        return out;
    }

    return value;
}
