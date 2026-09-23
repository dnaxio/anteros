import type { RestRequestOptions } from "../types/rest";
import type {
    AgentAttachment,
    AgentInfo,
    AgentInput,
    AgentMessage,
    AgentResult,
    AgentRunOptions,
    AgentStream,
    AgentStreamChunk,
    AgentThread,
} from "../types/agents";
import { AsyncQueue, deferred, sseData } from "./stream";

/** The error a consumer sees when it aborted its own stream. */
function abortedError(reason?: string): Error {
    const error: any = new Error(reason ?? "The agent stream was aborted");
    error.name = "AbortError";
    error.code = "AGENT_STREAM_ABORTED";
    return error;
}

/** `memory.thread` first, then the flat `thread` (and its `threadId` alias). */
function threadOf(options?: AgentRunOptions): string | undefined {
    return options?.memory?.thread ?? options?.memory?.threadId ?? options?.thread ?? options?.threadId;
}

/** Same resolution on the caller identity. */
function resourceOf(options?: AgentRunOptions): string | undefined {
    return options?.memory?.resource ?? options?.memory?.resourceId ?? options?.resource ?? options?.resourceId;
}

function readOnlyOf(options?: AgentRunOptions): boolean {
    return options?.memory?.readOnly === true;
}

/**
 * Encode the attachments for the wire — a `Blob`/`File` or raw bytes become base64,
 * an already-encoded payload is passed through. The server decides what each file
 * becomes (text, image, document) from its name.
 */
async function encodeFiles(files?: AgentAttachment[]): Promise<Array<Record<string, any>>> {
    if (!files?.length) return [];

    const encoded: Array<Record<string, any>> = [];

    for (const file of files) {
        if (typeof Blob !== "undefined" && file instanceof Blob) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            encoded.push({
                name: (file as File).name ?? "attachment",
                ...((file as File).type ? { mimeType: (file as File).type } : {}),
                data: toBase64(bytes),
            });
            continue;
        }

        if (file instanceof Uint8Array) {
            encoded.push({ name: "attachment", data: toBase64(file) });
            continue;
        }

        const payload = file as { name?: string; mimeType?: string; data: string; encoding?: "base64" | "utf8" };
        encoded.push({ ...payload, name: payload.name ?? "attachment" });
    }

    return encoded;
}

function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return typeof btoa === "function"
        ? btoa(binary)
        : Buffer.from(bytes).toString("base64");
}

type Post = (action: string, body: any, options?: RestRequestOptions) => Promise<any>;
/** Raw POST — resolves the `Response` (already error-checked) or throws. */
type Raw = (action: string, body: any, options?: RestRequestOptions) => Promise<Response>;

/**
 * One agent, bound to a tenant — `api.agent('support')`.
 * Talks to `POST /api/:tenant/agents/:agent/:action` (server: `server/agents.ts`).
 *
 * ```ts
 * const support = api.agent('support');
 *
 * const { text, toolCalls, usage } = await support.generate('Where is my order?', {
 *   thread: 'user-42',
 * });
 *
 * const stream = await support.stream('And in Lyon?', { thread: 'user-42' });
 * for await (const chunk of stream.textStream) process.stdout.write(chunk);
 * console.log(await stream.text);
 * ```
 *
 * A client only chooses the input, the memory thread and (lower) `maxSteps`:
 * the model, the endpoint, the options and the structured-output schema stay
 * server-side.
 */
class Agent<T = any> {
    #id: string;
    #post: Post;
    #raw: Raw;

    constructor(id: string, post: Post, raw: Raw) {
        this.#id = id;
        this.#post = post;
        this.#raw = raw;
    }

    /** The agent id used in the URL. */
    getId(): string {
        return this.#id;
    }

    /** Only what a caller may send — no provider, no options, no schema. */
    async #body(input: AgentInput | undefined, options?: AgentRunOptions): Promise<Record<string, any>> {
        const body: Record<string, any> = {};
        if (input !== undefined) body.input = input;

        const thread = threadOf(options);
        const resource = resourceOf(options);
        if (thread) body.thread = thread;
        if (resource) body.resource = resource;
        if (options?.maxSteps !== undefined) body.maxSteps = options.maxSteps;
        if (options?.lastMessages !== undefined) body.lastMessages = options.lastMessages;
        if (options?.messages !== undefined) body.messages = options.messages;
        if (readOnlyOf(options)) body.readOnly = true;

        const files = await encodeFiles(options?.files);
        if (files.length) body.files = files;

        return body;
    }

    /** Agent metadata (tools, model, options) — spends no token. */
    async info(options?: RestRequestOptions): Promise<AgentInfo> {
        const res = await this.#post("info", undefined, options);
        return res?.agent as AgentInfo;
    }

    /** Run the agent to completion and return the answer. */
    async generate(input: AgentInput, options?: AgentRunOptions): Promise<AgentResult<T>> {
        return this.#post("generate", await this.#body(input, options), options) as Promise<AgentResult<T>>;
    }

    /**
     * Same run, forced into a typed object — the schema is declared server-side
     * (`api.object`), so the answer is really validated (`AGENT_NO_OBJECT_SCHEMA`
     * when the agent declares none, `AGENT_OUTPUT_INVALID` when it stays invalid).
     */
    async object(input: AgentInput, options?: AgentRunOptions): Promise<T> {
        const res = await this.#post("object", await this.#body(input, options), options) as AgentResult<T>;
        return res.object as T;
    }

    /**
     * Run the agent and stream the tokens.
     * Resolves once the response headers are in — an access error (`401`) or a
     * missing agent (`AGENT_NOT_FOUND`) therefore throws here, not mid-stream.
     *
     * ```ts
     * const stream = await api.agent('support').stream('hi');
     * for await (const token of stream.textStream) process.stdout.write(token);
     * const { toolResults } = await stream;
     * ```
     */
    async stream(input: AgentInput, options?: AgentRunOptions): Promise<AgentStream<T>> {
        const response = await this.#raw("stream", await this.#body(input, options), options);
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();

        const textQueue = new AsyncQueue<string>();
        const fullQueue = new AsyncQueue<AgentStreamChunk>();
        const outcome = deferred<{ result: AgentResult<T>; object?: T }>();
        // The caller may only drain `textStream` — a rejection nobody awaits must
        // never become an unhandled one.
        outcome.promise.catch(() => {});

        let aborted: string | undefined;
        const finishAborted = () => {
            // The streams simply end, the promises say why.
            textQueue.close();
            fullQueue.close();
            outcome.reject(abortedError(aborted));
        };

        void (async () => {
            try {
                let final: { result: AgentResult<T>; object?: T } | undefined;

                for await (const data of sseData(reader)) {
                    let payload: any;
                    try {
                        payload = JSON.parse(data);
                    } catch {
                        continue;
                    }

                    if (payload?.type === "error") {
                        const error: any = new Error(payload.message ?? "The agent stream failed");
                        error.code = payload.code;
                        throw error;
                    }

                    if (payload?.type === "done") {
                        final = payload as { result: AgentResult<T>; object?: T };
                        continue;
                    }

                    fullQueue.push(payload as AgentStreamChunk);
                    if (payload?.type === "text") textQueue.push(payload.text);
                }

                if (!final) {
                    if (aborted !== undefined) return finishAborted();
                    throw new Error("The agent stream ended without a result");
                }

                outcome.resolve(final);
                textQueue.close();
                fullQueue.close();
            } catch (err) {
                if (aborted !== undefined) return finishAborted();
                outcome.reject(err);
                textQueue.fail(err);
                fullQueue.fail(err);
            }
        })();

        const view = <R>(pick: (payload: { result: AgentResult<T>; object?: T }) => R): Promise<R> => {
            const promise = outcome.promise.then(pick);
            // A view nobody awaits (the caller only drains `textStream`) must not
            // crash the process when the run fails or is aborted.
            promise.catch(() => {});
            return promise;
        };

        return {
            textStream: textQueue,
            fullStream: fullQueue,
            text: view((payload) => payload.result.text),
            reasoning: view((payload) => payload.result.reasoning),
            object: view((payload) => payload.object ?? payload.result.object),
            toolCalls: view((payload) => payload.result.toolCalls ?? []),
            toolResults: view((payload) => payload.result.toolResults ?? []),
            steps: view((payload) => payload.result.steps ?? []),
            usage: view((payload) => payload.result.usage),
            finishReason: view((payload) => payload.result.finishReason),
            abort: (reason?: string) => {
                // Stop consuming: cancelling the reader closes the connection, which
                // is how the server learns about it and aborts its own model call.
                aborted = reason ?? "The agent stream was aborted";
                void reader.cancel().catch(() => {});
            },
        };
    }

    /** The stored conversation of a thread (an aged thread is still returned). */
    async history(thread: string, options?: AgentRunOptions): Promise<AgentMessage[]> {
        const res = await this.#post("history", { thread, resource: resourceOf(options) }, options);
        return (res?.messages ?? []) as AgentMessage[];
    }

    /**
     * The caller's threads, most recent first — needs a store that lists them
     * (`agents.memory.Mongo`; `AGENT_MEMORY_NO_LIST` otherwise).
     */
    async threads(options?: AgentRunOptions & { limit?: number }): Promise<AgentThread[]> {
        const res = await this.#post("threads", {
            resource: resourceOf(options),
            limit: options?.limit,
        }, options);
        return (res?.threads ?? []) as AgentThread[];
    }

    /** Forget a thread. */
    async clear(thread: string, options?: AgentRunOptions): Promise<boolean> {
        const res = await this.#post("clear", { thread, resource: resourceOf(options) }, options);
        return !!res?.ok;
    }
}

export { Agent };
