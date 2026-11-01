/**
 * Best-effort JSON for a stream: what the model has produced so far, repaired
 * enough to parse, or `undefined` while it still makes no sense.
 *
 * Used by `agent.streamObject()` — the answer of a structured run is a JSON
 * object, and a caller usually wants to render it before the last token arrives.
 */

/** Drop the markdown fence a model wraps its JSON in (` ```json … ``` `). */
function unfence(text: string): string {
    let candidate = text.trim();
    // An opening fence, whose language tag may itself be partial (` ```jso `)
    candidate = candidate.replace(/^```[a-zA-Z0-9_-]*\s*/, "");
    candidate = candidate.replace(/\s*```\s*$/, "");
    return candidate.trim();
}

/**
 * Parse a **partial** JSON document — the text of an answer still streaming.
 *
 * The scan tracks string state (and escapes, so `"a\"b"` is one string), closes
 * the open string, then the open objects and arrays, drops a dangling `,` or `:`
 * and parses. Anything that still fails returns `undefined`: a partial answer is
 * best-effort by definition, never an error.
 *
 * ```ts
 * parsePartialJson('{"cities": [{"name": "Par') // { cities: [{ name: 'Par' }] }
 * parsePartialJson('{"cities": [1,')           // { cities: [1] }
 * parsePartialJson('```json\n{"a":')           // undefined
 * ```
 */
export function parsePartialJson(text: string): unknown {
    if (typeof text !== "string") return undefined;

    const source = unfence(text);
    if (!source) return undefined;

    const open: Array<"{" | "["> = [];
    let inString = false;
    let escaped = false;

    for (const char of source) {
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === "\"") {
                inString = false;
            }
            continue;
        }

        if (char === "\"") inString = true;
        else if (char === "{" || char === "[") open.push(char);
        else if (char === "}" || char === "]") open.pop();
    }

    let repaired = source;

    // A dangling escape would escape the quote we are about to add
    if (inString) {
        if (escaped) repaired = repaired.slice(0, -1);
        repaired += "\"";
    }

    // A key or a value waiting for its other half cannot be completed
    repaired = repaired.replace(/[,:]\s*$/, "");

    for (let index = open.length - 1; index >= 0; index--) {
        repaired += open[index] === "{" ? "}" : "]";
    }

    try {
        return JSON.parse(repaired);
    } catch {
        return undefined;
    }
}
