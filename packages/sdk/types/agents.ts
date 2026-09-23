import type { RestRequestOptions } from "./rest";

/**
 * Agents — client side of `POST /api/:tenant/agents/:agent/:action`
 * (see `api.agent(id)` on the `Rest` client).
 */

/**
 * What the client can attach to a run. A browser has no filesystem, so the file
 * is encoded here: a `File`/`Blob` (base64 on the wire), raw bytes, or an
 * already-encoded payload — `{ name, data, encoding? }`.
 */
export type AgentAttachment =
    | Blob
    | Uint8Array
    | {
        /** File name — its extension decides how the server reads it (`report.pdf`, `data.csv`). */
        name: string;
        mimeType?: string;
        /** Base64 (default) or UTF-8 text with `encoding: 'utf8'`. */
        data: string;
        encoding?: "base64" | "utf8";
    };

export type AgentInput = string | AgentMessage | AgentMessage[];

/**
 * A content part — the same unified vocabulary as the server: text, an image or
 * a document **by URL or base64**, and the tool parts other LLM libraries use
 * (`tool-call` / `tool-result`), which the server hoists onto the message.
 */
export type AgentContentPart =
    | { type: "text"; text: string }
    | { type: "image"; url?: string; data?: string; mimeType?: string }
    | { type: "file"; name?: string; url?: string; data?: string; mimeType?: string }
    | {
        type: "tool-call";
        id: string;
        name: string;
        arguments?: unknown;
        args?: Record<string, any>;
        argsText?: string;
    }
    | { type: "tool-result"; id: string; name?: string; result?: unknown; error?: string };

export type AgentMessage = {
    role: "system" | "developer" | "user" | "assistant" | "tool" | string;
    /** A string, or the content parts (`text`, `image`, `file`, tool parts). */
    content?: string | AgentContentPart[] | null;
    /** Set on an assistant message that asked for tools. */
    toolCalls?: AgentToolCall[];
    /** Set on a `tool` message — id of the call it answers. */
    toolCallId?: string;
    name?: string;
    isError?: boolean;
};

export type AgentToolCall = {
    id: string;
    name: string;
    args: Record<string, any>;
    argsText?: string;
};

export type AgentToolResultEntry = {
    id: string;
    name: string;
    args: Record<string, any>;
    result?: any;
    error?: string;
    durationMs: number;
};

export type AgentStep = {
    step: number;
    text: string;
    toolCalls: AgentToolCall[];
    toolResults: AgentToolResultEntry[];
    finishReason: string;
};

export type AgentUsage = {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    requests: number;
};

/** A memory thread as listed by `agent.threads()`. */
export type AgentThread = {
    threadId: string;
    resourceId?: string;
    /** Derived from the first user message, at creation. */
    title?: string;
    /** Number of stored messages. */
    messages: number;
    createdAt?: string | Date;
    updatedAt: string | Date;
};

/** What `generate` / `stream` return — the conversation itself is served by `history`. */
export type AgentResult<T = any> = {
    text: string;
    /** Everything the model thought, when the agent declares `thinking`. */
    reasoning?: string;
    /** Present when the action is `object` (schema declared server-side). */
    object?: T;
    toolCalls: AgentToolCall[];
    toolResults: AgentToolResultEntry[];
    steps: AgentStep[];
    usage: AgentUsage;
    finishReason: string;
};

/** `info` — agent metadata (never the API key). */
export type AgentInfo = {
    id?: string;
    name: string;
    description?: string;
    tenant?: string;
    provider: {
        model: string;
        compatible?: "openai" | "anthropic";
        baseUrl?: string;
        headers?: Record<string, string>;
        options?: Record<string, any>;
    };
    instructions: string;
    tools: string[];
    maxSteps: number;
    toolChoice?: string;
    thinking?: boolean | string;
    memory: boolean;
};

/** Options of one run. Only what a caller is allowed to choose. */
export type AgentRunOptions = RestRequestOptions & {
    /** Memory thread — replays the conversation and stores the exchange. */
    thread?: string;
    /** @deprecated Alias of `thread`. */
    threadId?: string;
    /** Opaque caller identity, forwarded to the server-side instructions function. */
    resource?: string;
    /** @deprecated Alias of `resource`. */
    resourceId?: string;
    /** Lower the run's step ceiling (the server never lets it go higher). */
    maxSteps?: number;
    /**
     * Turns injected into the run — after the thread, before the input. They are sent
     * to the model **and** stored in the thread: the way to seed context without
     * assembling one long `input` array.
     */
    messages?: AgentMessage | AgentMessage[];
    /** Shrink the replayed-history window (never past what the agent declares). */
    lastMessages?: number;
    /**
     * Files and images sent with the run — a `File`/`Blob` from an `<input type="file">`,
     * raw bytes, or an already-encoded payload.
     *
     * ```ts
     * await api.agent('support').generate('What is wrong on this screenshot?', {
     *   files: [input.files[0]],
     * });
     * ```
     */
    files?: AgentAttachment[];
    /**
     * Memory of this run — the Mastra-style shorthand:
     *
     * ```ts
     * await api.agent('support').generate('Remember my favorite color is blue.', {
     *   memory: { resource: 'user-123', thread: 'conversation-123' },
     * })
     * ```
     */
    memory?: {
        thread?: string;
        /** @deprecated Alias of `thread`. */
        threadId?: string;
        resource?: string;
        /** @deprecated Alias of `resource`. */
        resourceId?: string;
        /** Read the thread without writing the run back. */
        readOnly?: boolean;
    };
};

/** Incremental event of a streamed run. */
export type AgentStreamChunk =
    | { type: "text"; text: string }
    | { type: "tool_call"; toolCall: AgentToolCall }
    | { type: "tool_result"; toolResult: AgentToolResultEntry }
    | { type: "step"; step: AgentStep }
    | { type: "finish"; finishReason: string; usage: AgentUsage };

/**
 * `agent.stream()` result — consume `textStream` as the tokens arrive, the
 * promises resolve when the whole run (tool rounds included) is over.
 */
export type AgentStream<T = any> = {
    /** Every event, tool calls and results included. */
    fullStream: AsyncIterable<AgentStreamChunk>;
    /** Just the text tokens. */
    textStream: AsyncIterable<string>;
    text: Promise<string>;
    /** Everything the model thought, when the agent declares `thinking`. */
    reasoning: Promise<string | undefined>;
    object: Promise<T | undefined>;
    toolCalls: Promise<AgentToolCall[]>;
    toolResults: Promise<AgentToolResultEntry[]>;
    steps: Promise<AgentStep[]>;
    usage: Promise<AgentUsage>;
    finishReason: Promise<string>;
    /** Stop the run — the server aborts its model call too. */
    abort: (reason?: string) => void;
};
