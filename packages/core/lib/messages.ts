import { AppError } from "./error";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { MAX_FILE_BYTES } from "./attachment";
import type {
    AgentAssistantMessage,
    AgentContentPart,
    AgentInput,
    AgentMediaPart,
    AgentMessage,
    AgentMessageInput,
    AgentToolCall,
    AgentToolCallPart,
    AgentToolResultEntry,
    AgentToolResultPart,
} from "../types/agent";

/**
 * The message model — one shape for every provider.
 *
 * A caller may hand over anything reasonable: a bare `string`, one message, a
 * whole conversation, or the **unified content parts** another LLM library uses
 * (`text`, `image`, `file`, `tool-call`, `tool-result`). Everything is normalized
 * here, once, into the canonical `AgentMessage[]` the runtime, the providers and
 * the memory all speak:
 *
 * | Input | Canonical result |
 * | --- | --- |
 * | `'hi'` | `{ role: 'user', content: 'hi' }` |
 * | `{ role: 'user', content: [{ type: 'text', … }] }` | the same message, media parts kept |
 * | `{ role: 'user', content: [{ type: 'tool-result', … }] }` | the `tool` message it really is |
 * | `{ role: 'assistant', content: [{ type: 'tool-call', … }] }` | `toolCalls` on the assistant turn |
 * | `{ role: 'developer', … }` | kept as-is (mapped per protocol by the adapters) |
 *
 * Two rules worth knowing:
 *
 * - **Nothing is dropped silently.** A part the role cannot carry (an image on an
 *   assistant turn, a `tool-call` on a user turn) is refused with `INVALID_INPUT`
 *   rather than ignored — a conversation quietly losing a turn shows up as a wrong
 *   answer, three calls later.
 * - **A remote file is downloaded here** (10 MB cap, same as an attachment):
 *   OpenAI-compatible endpoints only accept base64 for a document, so inlining it
 *   once keeps `file: { url }` working on every provider. A remote **image** is
 *   left as a URL — both protocols fetch it themselves.
 *
 * Only the fields of the canonical message survive: an unknown key on the way in
 * (a stray `threadId`, a provider flag…) never reaches the wire.
 */

const ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);

function invalid(message: string): AppError {
    return new AppError(message, { status: 400, code: "INVALID_INPUT" });
}

/** A tool result as the model reads it — the same rendering the runtime uses. */
function serializeToolResult(entry: AgentToolResultEntry): string {
    if (entry.error) return `Error: ${entry.error}`;
    const result = entry.result;
    if (typeof result === "string") return result;
    if (result && typeof result === "object" && Array.isArray((result as any).content)) {
        const texts = (result as any).content
            .filter((block: any) => block?.type === "text" && typeof block.text === "string")
            .map((block: any) => block.text);
        if (texts.length) return texts.join("\n");
    }
    if (result === undefined || result === null) return "OK";
    try {
        return JSON.stringify(result);
    } catch {
        return String(result);
    }
}

/** The text of a part array — a `system` message is text and nothing else. */
function systemText(parts: AgentContentPart[], role: string): string {
    const foreign = parts.find((part) => part?.type !== "text");
    if (foreign) throw invalid(`A \`${role}\` message only carries \`text\` parts`);
    return parts.map((part: any) => part.text).join("\n");
}

function isHttpUrl(url: string | undefined): boolean {
    return typeof url === "string" && /^https?:\/\//i.test(url);
}

function checkAddress(part: AgentContentPart, role: string): void {
    const address = (part as { url?: string }).url;
    if (!address) return;
    if (isHttpUrl(address) || address.startsWith("data:")) return;
    throw invalid(`A \`${part.type}\` part of a ${role} message needs an \`https://\`, a \`data:\` URL or base64 \`data\``);
}

/** Remote files: public HTTPS only, bounded time and size — SSRF hardening (issue #30). */
const REMOTE_FILE_TIMEOUT_MS = 10_000;
const REMOTE_FILE_MAX_REDIRECTS = 3;

/** Refuse an address that is not publicly routable (loopback, LAN, cloud metadata…). */
function isPrivateAddress(address: string): boolean {
    const plain = address.replace(/^\[|\]$/g, "").toLowerCase();
    const family = isIP(plain);

    if (family === 4) {
        const [a, b] = plain.split(".").map(Number) as [number, number, number, number];
        if (a === 0 || a === 10 || a === 127) return true;
        if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT
        if (a === 169 && b === 254) return true;                     // link-local, cloud metadata
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 192 && b === 0) return true;                       // IETF / TEST-NET-1
        if (a === 198 && (b === 18 || b === 19)) return true;        // benchmark
        if (a === 198 && b === 51) return true;                      // TEST-NET-2
        if (a === 203 && b === 0) return true;                       // TEST-NET-3
        return a >= 224;                                             // multicast, reserved, broadcast
    }

    if (family === 6) {
        if (plain.startsWith("::")) return true;                     // ::1, ::, ::ffff:… (IPv4-mapped)
        if (plain.startsWith("fe80:")) return true;                  // link-local
        if (/^f[cd][0-9a-f]{2}:/.test(plain)) return true;           // unique local fc00::/7
        if (plain.startsWith("ff")) return true;                     // multicast
        if (plain.startsWith("2001:db8")) return true;               // documentation
        if (plain.startsWith("2002:")) return true;                  // 6to4
        if (plain.startsWith("64:ff9b:")) return true;               // NAT64 — may map a private IPv4
        return false;
    }

    return true; // not an IP: the caller resolves the hostname first
}

function remoteFileError(code: "AGENT_FILE_INVALID" | "AGENT_FILE_NOT_FOUND", message: string): AppError {
    return new AppError(message, { status: 400, code });
}

/** Parse one hop: HTTPS, no credentials, and only public addresses. */
async function assertPublicRemoteUrl(raw: string): Promise<URL> {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw remoteFileError("AGENT_FILE_INVALID", "The remote file URL is invalid");
    }
    if (url.protocol !== "https:") {
        throw remoteFileError("AGENT_FILE_INVALID", "Remote files must use HTTPS");
    }
    if (url.username || url.password) {
        throw remoteFileError("AGENT_FILE_INVALID", "Remote file URLs must not carry credentials");
    }

    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!host) throw remoteFileError("AGENT_FILE_INVALID", "The remote file URL has no host");

    if (isIP(host)) {
        if (isPrivateAddress(host)) {
            throw remoteFileError("AGENT_FILE_INVALID", "The remote file URL points to a private address");
        }
        return url;
    }

    let resolved: Array<{ address: string }>;
    try {
        resolved = await lookup(host, { all: true, verbatim: true });
    } catch {
        throw remoteFileError("AGENT_FILE_NOT_FOUND", "The remote file host could not be resolved");
    }
    if (!resolved.length || resolved.some(({ address }) => isPrivateAddress(address))) {
        throw remoteFileError("AGENT_FILE_INVALID", "The remote file URL points to a private address");
    }
    return url;
}

/** Follows a redirect only after re-validating the target — no hop may reach a private address. */
async function fetchRemoteFile(raw: string): Promise<Response> {
    let current = raw;
    for (let hop = 0; hop <= REMOTE_FILE_MAX_REDIRECTS; hop++) {
        const url = await assertPublicRemoteUrl(current);

        let response: Response;
        try {
            response = await fetch(url, {
                redirect: "manual",
                signal: AbortSignal.timeout(REMOTE_FILE_TIMEOUT_MS),
            });
        } catch {
            throw remoteFileError("AGENT_FILE_NOT_FOUND", "The remote file could not be downloaded");
        }

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get("location");
            if (!location) throw remoteFileError("AGENT_FILE_NOT_FOUND", "The remote file could not be downloaded");
            current = new URL(location, url).href;
            continue;
        }
        if (!response.ok) throw remoteFileError("AGENT_FILE_NOT_FOUND", "The remote file could not be downloaded");
        return response;
    }
    throw remoteFileError("AGENT_FILE_INVALID", "The remote file redirects too many times");
}

/** Reads the body with a hard cap — from `Content-Length` and while streaming. */
async function readRemoteBytes(response: Response): Promise<Uint8Array> {
    const limit = MAX_FILE_BYTES;
    const tooLarge = () => new AppError(
        `The remote file exceeds the ${limit / 1024 / 1024}MB limit`,
        { status: 413, code: "AGENT_FILE_TOO_LARGE" },
    );

    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > limit) throw tooLarge();
    if (!response.body) return new Uint8Array(await response.arrayBuffer());

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > limit) {
                await reader.cancel().catch(() => {});
                throw tooLarge();
            }
            chunks.push(value);
        }
    } catch (err) {
        if (err instanceof AppError) throw err;
        throw remoteFileError("AGENT_FILE_NOT_FOUND", "The remote file could not be downloaded");
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

/** A `file` part, with its remote payload fetched and inlined when there is one. */
async function inlineRemoteFile(part: AgentMediaPart): Promise<AgentMediaPart> {
    if (part.type !== "file" || !isHttpUrl(part.url)) return part;

    const url = part.url!;
    const bytes = await readRemoteBytes(await fetchRemoteFile(url));

    const name = part.name ?? url.split("?")[0]!.split("/").pop() ?? "document.pdf";
    return { type: "file", name, ...(part.mimeType ? { mimeType: part.mimeType } : {}), data: Buffer.from(bytes).toString("base64") };
}

/** One media part, validated (and fetched when it is a remote file). */
async function mediaPart(part: AgentContentPart, role: string): Promise<AgentMediaPart> {
    if (part?.type === "text") {
        if (typeof part.text !== "string") throw invalid(`A \`text\` part of a ${role} message needs a \`text\``);
        return { type: "text", text: part.text };
    }

    if (part?.type === "image" || part?.type === "file") {
        if (!part.data && !part.url) throw invalid(`A \`${part.type}\` part needs a \`url\` or a \`data\``);
        checkAddress(part, role);

        // Only what is there: an explicit `undefined` would be stored as `null`
        const address = part.url ? { url: part.url } : { data: part.data };
        const media: AgentMediaPart = part.type === "image"
            ? { type: "image", ...address, ...(part.mimeType ? { mimeType: part.mimeType } : {}) }
            : {
                type: "file",
                ...address,
                ...(part.name ? { name: part.name } : {}),
                ...(part.mimeType ? { mimeType: part.mimeType } : {}),
            };
        return media.type === "file" ? await inlineRemoteFile(media) : media;
    }

    throw invalid(`A \`${(part as any)?.type ?? "unknown"}\` part is not valid on a \`${role}\` message`);
}

/** An `assistant` turn: text (and the tool calls it asked for) — nothing else. */
function assistantContent(content: string | AgentContentPart[] | null | undefined, role: string): string | null {
    if (content === null || content === undefined) return null;
    if (typeof content === "string") return content;

    const media = content.find((part) => part?.type === "image" || part?.type === "file");
    if (media) throw invalid(`A \`${media.type}\` part is not valid on a \`${role}\` message`);

    return content
        .filter((part): part is Extract<AgentContentPart, { type: "text" }> => part?.type === "text")
        .map((part) => part.text)
        .join("") || null;
}

/** A `tool-call` part → the canonical tool call the providers are given back. */
function toToolCall(part: AgentToolCallPart): AgentToolCall {
    if (!part?.id || !part?.name) throw invalid("A `tool-call` part needs an `id` and a `name`");
    const raw = part.args ?? part.arguments ?? {};
    const args = raw && typeof raw === "object" ? (raw as Record<string, any>) : {};
    const call: AgentToolCall = { id: part.id, name: part.name, args };
    if (part.argsText) call.argsText = part.argsText;
    else if (typeof part.arguments === "string") call.argsText = part.arguments;
    return call;
}

/** A `tool-result` part → the `tool` message that answers one call. */
function toToolMessage(part: AgentToolResultPart): AgentMessage {
    if (!part?.id) throw invalid("A `tool-result` part needs the `id` of the call it answers");
    const name = part.name ?? "tool";
    return {
        role: "tool",
        toolCallId: part.id,
        name,
        content: serializeToolResult({
            id: part.id,
            name,
            args: {},
            result: part.result,
            error: part.error,
            durationMs: 0,
        }),
        ...(part.error ? { isError: true } : {}),
    };
}

/**
 * Everything a caller passed → the canonical conversation.
 *
 * Structural only: the input is **appended** to whatever a memory already holds —
 * this function never touches the thread.
 */
async function normalizeMessages(input: AgentInput): Promise<AgentMessage[]> {
    const list: AgentMessageInput[] = typeof input === "string"
        ? [{ role: "user", content: input }]
        : Array.isArray(input) ? input : [input];

    const out: AgentMessage[] = [];

    for (const message of list) {
        if (!message || typeof message !== "object" || typeof (message as any).role !== "string") {
            throw invalid("Every message needs a `role`");
        }

        const role = message.role as string;
        if (!ROLES.has(role)) throw invalid(`Unknown message role '${role}'`);

        const source = message as any;
        const content = source.content;
        const named = source.name ? { name: String(source.name) } : {};

        switch (role) {
            case "system":
            case "developer": {
                const text = typeof content === "string"
                    ? content
                    : Array.isArray(content)
                        ? systemText(content, role)
                        : (() => { throw invalid(`A \`${role}\` message needs a \`content\``); })();
                // An empty instruction is a mistake, not a message
                if (!text.trim()) throw invalid(`A \`${role}\` message needs a \`content\``);
                out.push({ role, content: text, ...named } as AgentMessage);
                break;
            }

            case "user": {
                if (typeof content === "string") {
                    out.push({ role: "user", content, ...named });
                    break;
                }
                if (!Array.isArray(content)) throw invalid("A `user` message needs a `content`");

                const parts: AgentMediaPart[] = [];
                const results: AgentMessage[] = [];
                for (const part of content) {
                    if (part?.type === "tool-result") results.push(toToolMessage(part));
                    else if (part?.type === "tool-call") {
                        throw invalid("A `tool-call` part belongs to an `assistant` message");
                    } else parts.push(await mediaPart(part, role));
                }
                if (!parts.length && !results.length) throw invalid("A `user` message needs a `content`");

                // A turn that is *only* tool results does not leave an empty user turn behind
                if (parts.length) out.push({ role: "user", content: parts, ...named });
                // A tool round expressed as `user` parts becomes the turns it means
                out.push(...results);
                break;
            }

            case "assistant": {
                const inline = Array.isArray(content)
                    ? content.filter((part): part is AgentToolCallPart => part?.type === "tool-call")
                    : [];
                const declared = source.toolCalls as AgentToolCall[] | undefined;
                const thinking = source.thinking as AgentAssistantMessage["thinking"];

                out.push({
                    role: "assistant",
                    content: assistantContent(content, role),
                    ...(declared?.length || inline.length
                        ? { toolCalls: [...(declared ?? []), ...inline.map(toToolCall)] }
                        : {}),
                    ...(thinking?.length ? { thinking } : {}),
                    ...named,
                });
                break;
            }

            case "tool": {
                if (typeof content === "string") {
                    if (!source.toolCallId) throw invalid("A `tool` message needs a `toolCallId`");
                    out.push({
                        role: "tool",
                        toolCallId: String(source.toolCallId),
                        name: source.name ? String(source.name) : "tool",
                        content,
                        ...(source.isError ? { isError: true } : {}),
                    });
                    break;
                }
                if (!Array.isArray(content)) throw invalid("A `tool` message needs a `content`");
                if (!content.length) throw invalid("A `tool` message needs a `content`");

                for (const part of content) {
                    if (part?.type !== "tool-result") throw invalid("A `tool` message only carries `tool-result` parts");
                    out.push(toToolMessage(part));
                }
                break;
            }
        }
    }

    return out;
}

export { normalizeMessages, serializeToolResult };
