const isEmptyArray = (v: unknown): v is unknown[] =>
    Array.isArray(v) && v.length === 0;
const isEmptyObject = (v: unknown): boolean =>
    typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0;
const shouldRemove = (v: unknown): boolean =>
    v === null ||
    v === undefined ||
    isEmptyArray(v) ||
    isEmptyObject(v);

/**
 * Nettoie récursivement un objet ou un tableau en supprimant :
 * - les valeurs `null` et `undefined`
 * - les tableaux vides `[]`
 * - les objets vides `{}`
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
