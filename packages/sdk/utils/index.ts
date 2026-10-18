const isEmptyArray = (v: unknown): v is unknown[] =>
    Array.isArray(v) && v.length === 0;
const isEmptyObject = (v: unknown): boolean =>
    typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0;
const shouldRemove = (v: unknown): boolean =>
    v === null ||
    v === undefined ||
    v === '' ||
    isEmptyArray(v) ||
    isEmptyObject(v);

/**
 * Recursively cleans an object or array by removing:
 * - `null` and `undefined` values
 * - empty strings `''`
 * - empty arrays `[]`
 * - empty objects `{}`
 *
 * @example
 * cleanDeep({ a: 1, b: null, c: [], e: { f: null } })
 * // => { a: 1 }
 * cleanDeep([1, null, [], {}])
 * // => [1]
 */
export function cleanDeep<T>(value: T): T {
    if (value === null || value === undefined) {
        return value;
    }

    if (Array.isArray(value)) {
        const cleaned = value
            .map((item) => cleanDeep(item))
            .filter((v) => !shouldRemove(v)) as T;
        return cleaned as T;
    }

    if (typeof value === "object" && value !== null) {
        const result: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
            const cleaned = cleanDeep(val);
            if (!shouldRemove(cleaned)) {
                result[key] = cleaned;
            }
        }
        return result as T;
    }

    return value;
}

/** An SDK-side error (same shape as the server ones: `code`, optional `status`). */
function sdkError(code: string, message: string): Error & { code: string } {
    const error = new Error(message) as Error & { code: string };
    error.code = code;
    return error;
}

/**
 * Serialize one metadata value for `multipart/form-data` — objects/arrays as JSON
 * (the server validates real field types), everything else as a string.
 */
export function toFormValue(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "object" && value !== null) return JSON.stringify(value);
    return String(value);
}

/** Update operators the external API accepts (mirrors the server allow-list). */
export const UPDATE_OPERATORS = new Set([
    "$set", "$unset", "$inc", "$mul", "$min", "$max", "$currentDate",
    "$push", "$addToSet", "$pull", "$pullAll", "$pop",
]);

/** Fail fast on a replacement document, `$rename`, or an unknown operator. */
export function assertUpdateOperators(update: unknown): void {
    if (!update || typeof update !== "object" || Array.isArray(update)) {
        throw sdkError("SDK_INVALID_UPDATE", "`update` must be a MongoDB update document");
    }
    const operators = Object.keys(update);
    if (!operators.length || !operators.every((operator) => UPDATE_OPERATORS.has(operator))) {
        throw sdkError(
            "SDK_INVALID_UPDATE",
            "`update` must use only the supported operators ($set, $unset, $inc, $mul, $min, $max, $currentDate, $push, $addToSet, $pull, $pullAll, $pop)",
        );
    }
}

/** 100 MB is the server's default per-file/upload allowance (normal JSON bodies are capped at 16MB). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Reject an upload whose total size would exceed the server body limit. */
export function assertUploadSize(files: Array<{ size?: number }>, maxBytes = MAX_UPLOAD_BYTES): void {
    const total = files.reduce((sum, file) => sum + (typeof file.size === "number" ? file.size : 0), 0);
    if (total > maxBytes) {
        throw sdkError(
            "SDK_UPLOAD_TOO_LARGE",
            `The upload is ${Math.ceil(total / 1024 / 1024)}MB — the server default limit is ${maxBytes / 1024 / 1024}MB`,
        );
    }
}
