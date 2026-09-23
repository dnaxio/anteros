import type Joi from "joi";
import type { useRest } from "../database/rest";
import type { fn } from "../lib/error";
import type { jwt } from "../utils/func";
import type { Agent } from "../lib/agent";

/**
 * Wire protocol spoken by a model provider.
 *
 * `'openai'` (the default) also covers every OpenAI-compatible gateway
 * (Groq, Mistral, OpenRouter, Ollama, LM Studio, vLLM…) — only `baseUrl` changes.
 */
export type AgentCompatible = "openai" | "anthropic";

/**
 * Model provider — **where** the agent's reasoning comes from: the model, the
 * credentials, the endpoint, and how it is called.
 *
 * ```ts
 * provider: { model: 'gpt-4o-mini', apiKey: 'sk-…' }                       // OpenAI
 * provider: { model: 'claude-sonnet-4-5', apiKey: 'sk-ant-…', compatible: 'anthropic' }
 * provider: { model: 'llama3.1', compatible: 'openai', baseUrl: 'http://localhost:11434/v1' }
 * ```
 *
 * The key falls back to the environment when omitted:
 * `ANTEROS_AI_API_KEY`, then `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` according to
 * `compatible`. It is therefore never required in the source.
 */
export type AgentProvider = {
    /** Model id sent to the API (e.g. `gpt-4o-mini`, `claude-sonnet-4-5`). */
    model: string;
    /** API key — falls back to the environment (see above). */
    apiKey?: string;
    /** Wire protocol (default `'openai'`). */
    compatible?: AgentCompatible;
    /** API root override — default `https://api.openai.com/v1` or `https://api.anthropic.com`. */
    baseUrl?: string;
    /** Extra headers sent with every request. */
    headers?: Record<string, string>;
    /** Sampling and transport — `{ temperature, maxTokens, topP, timeout, retries }`. */
    options?: AgentOptions;
};

/**
 * How the provider is called — declared under `provider.options`, overridable
 * per call (`{ provider: { options: { … } } }`, merged).
 *
 * ```ts
 * provider: { model: 'gpt-4o-mini', options: { temperature: 0.2, maxTokens: 1000 } }
 * ```
 */
export type AgentOptions = {
    /** Sampling temperature. */
    temperature?: number;
    /** Max tokens generated per model call (default 4096). */
    maxTokens?: number;
    /** Nucleus sampling. */
    topP?: number;
    /** Request timeout in ms (default 120000). */
    timeout?: number;
    /** Retries on network errors, 429 and 5xx (default 2). */
    retries?: number;
};

/** Text part of a multimodal message. */
export type AgentTextPart = { type: "text"; text: string };
/**
 * An image — by **URL** or as **base64**.
 *
 * `url` is an `https://…` (the provider fetches it) or a `data:` URL; `data` is
 * the raw base64 (no `data:` prefix), the form an upload or a `File` produces.
 * One of the two is required.
 */
export type AgentImagePart = { type: "image"; url?: string; data?: string; mimeType?: string };
/**
 * A document — a PDF today — by **URL** or as **base64** (`data` is raw base64).
 *
 * Native input where the model supports it; a text extraction happens upstream
 * for everything else. A **remote file URL is downloaded and inlined** before the
 * call (OpenAI-compatible endpoints only accept base64), with the same 10 MB cap
 * as an attachment.
 */
export type AgentFilePart = {
    type: "file";
    /** Name shown to the model — the extension is part of what it reads. */
    name?: string;
    url?: string;
    data?: string;
    mimeType?: string;
};

/**
 * A tool call, expressed as a **content part** — the spelling other LLM
 * libraries use. `normalizeMessages()` hoists it onto the assistant message's
 * `toolCalls`, so a conversation coming from anywhere lands on the same shape.
 */
export type AgentToolCallPart = {
    type: "tool-call";
    id: string;
    name: string;
    /** Parsed arguments — `args` / `argsText` are the historical spellings. */
    arguments?: unknown;
    args?: Record<string, any>;
    argsText?: string;
};

/**
 * A tool result, expressed as a content part. Accepted on a `tool` message — or
 * on a `user` message, which is how a whole tool round is replayed without
 * leaving the `user` role. It is hoisted to a `tool` message.
 */
export type AgentToolResultPart = {
    type: "tool-result";
    /** Id of the `tool-call` this answers. */
    id: string;
    name?: string;
    /** The tool's return value — serialized for the model if it is not a string. */
    result?: unknown;
    /** Set instead of `result` when the tool failed. */
    error?: string;
};

/** What a model actually receives — the media an attachment resolves to. */
export type AgentMediaPart = AgentTextPart | AgentImagePart | AgentFilePart;

/**
 * What a caller may put in a message's `content` — the media **and** the tool
 * parts, so a conversation built by another library is accepted as-is.
 */
export type AgentContentPart = AgentMediaPart | AgentToolCallPart | AgentToolResultPart;

/**
 * What a caller can attach to a run — resolved to content parts before the model
 * sees them (see `lib/attachment.ts`).
 *
 * - **server-side**: a **path** (`'./invoices/2026-01.pdf'`), relative to `filesBaseDir`
 * - **front-end / SDK**: a `File`/`Blob`, raw bytes, or `{ name, data }` in base64
 */
export type AgentAttachment =
    | string
    | Uint8Array
    | Blob
    | {
        /** File name — its extension decides how it is read. */
        name?: string;
        /** MIME type, when the name is not enough. */
        mimeType?: string;
        /** The payload: base64 (default) or UTF-8 text with `encoding: 'utf8'`. */
        data: string | Uint8Array;
        encoding?: "base64" | "utf8";
    };

export type AgentUserMessage = { role: "user"; content: string | AgentMediaPart[]; name?: string };
/**
 * A system message. `developer` is the role OpenAI-compatible endpoints use for
 * an instruction that outranks a user turn — Anthropic has no such role, so it is
 * folded into the system prompt there.
 */
export type AgentSystemMessage = { role: "system" | "developer"; content: string; name?: string };
export type AgentAssistantMessage = {
    role: "assistant";
    content: string | null;
    /** Set when the model asked to call tools (echoed back on the next turn). */
    toolCalls?: AgentToolCall[];
    /**
     * The model's reasoning blocks, kept **raw** — Anthropic requires the original
     * signed blocks to be echoed back when a tool round continues a thinking turn.
     */
    thinking?: AgentThinkingBlock[];
    name?: string;
};

/** A reasoning block, exactly as the provider returned it (signature included). */
export type AgentThinkingBlock = Record<string, any>;

/**
 * Extended thinking — off by default.
 *
 * ```ts
 * await agent.generate('Prove that …', { thinking: 'high' });
 * ```
 *
 * Mapped per protocol: Anthropic gets a real **thinking budget**, an
 * OpenAI-compatible endpoint gets a `reasoning_effort` (the two knobs are not the
 * same thing — a budget is a number, an effort is a level). On OpenAI-compatible
 * gateways only the reasoning models honour it.
 */
export type AgentThinking =
    /** `true` → the provider's default: `'medium'` effort / a 4 096-token budget. */
    | boolean
    /** Pure level — the budget becomes 2 048 / 4 096 / 8 192 tokens. */
    | "low"
    | "medium"
    | "high"
    /** Explicit Anthropic budget (OpenAI-compatible receives `'medium'`, the closest level). */
    | { budgetTokens: number };

/**
 * How the model may use the tools it is given, per protocol.
 *
 * - `'auto'` (default) — every tool is sent, the model decides
 * - `'none'` — the tools are sent but the model must answer directly
 * - `'required'` — it must call a tool (Anthropic: `tool_choice: any`)
 * - `{ name }` — it must call that one
 *
 * The framework never picks a tool itself: what reaches the model is decided by
 * the tools of the run (see `tools`), and by this alone.
 */
export type AgentToolChoice = "auto" | "none" | "required" | { name: string };

export type AgentToolMessage = {
    role: "tool";
    /** Id of the `tool_use` / `tool_call` this message answers. */
    toolCallId: string;
    name: string;
    content: string;
    isError?: boolean;
};

/** A single conversation message — the model-agnostic shape used everywhere. */
export type AgentMessage = AgentUserMessage | AgentSystemMessage | AgentAssistantMessage | AgentToolMessage;

/**
 * What a caller may **pass**: the canonical messages, plus the unified content
 * parts (`image` / `file` by URL or base64, `tool-call` / `tool-result`) another
 * LLM library uses. `normalizeMessages()` folds them onto the canonical shape —
 * a `tool-call` part becomes `toolCalls`, a `tool-result` part becomes a `tool`
 * message, a `system`/`developer` message may carry a part array.
 */
export type AgentMessageInput =
    | { role: "system" | "developer"; content: string | AgentContentPart[]; name?: string }
    | { role: "user"; content: string | AgentContentPart[]; name?: string }
    | {
        role: "assistant";
        content?: string | AgentContentPart[] | null;
        toolCalls?: AgentToolCall[];
        thinking?: AgentThinkingBlock[];
        name?: string;
    }
    | {
        role: "tool";
        content: string | AgentContentPart[];
        toolCallId?: string;
        name?: string;
        isError?: boolean;
    };

/** What `generate()` / `stream()` accept as input. */
export type AgentInput = string | AgentMessageInput | AgentMessageInput[];

/** A tool call requested by the model. */
export type AgentToolCall = {
    id: string;
    name: string;
    /** Parsed arguments (`{}` when the model produced invalid JSON). */
    args: Record<string, any>;
    /** Raw JSON string as returned by the model. */
    argsText?: string;
};

/** The outcome of executing one tool call. */
export type AgentToolResultEntry = {
    id: string;
    name: string;
    args: Record<string, any>;
    result?: any;
    /** Set when the tool threw, was unknown, or its arguments were invalid. */
    error?: string;
    durationMs: number;
};

/** Normalized finish reason (`'max_steps'` is added by the agent itself). */
export type AgentFinishReason = "stop" | "tool_use" | "length" | "content_filter" | "aborted" | "error" | "max_steps";

export type AgentUsage = {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    /** How many model calls the run needed (1 + one per tool round). */
    requests: number;
};

/** One model call of a run, with the tools it asked for. */
export type AgentStep = {
    step: number;
    text: string;
    /** The model's reasoning for this step, when extended thinking is on. */
    reasoning?: string;
    /** Ids of the tools sent for this step — every tool the run allowed. */
    tools?: string[];
    toolCalls: AgentToolCall[];
    toolResults: AgentToolResultEntry[];
    finishReason: string;
};

/** Execution context handed to a tool. */
export type AgentToolContext = {
    rest?: InstanceType<typeof useRest>;
    /** The agent currently running. */
    agent: Agent;
    /** Tenant of the agent (`_tenant_`), when loaded from a tenant folder. */
    tenant?: string;
    toolCallId: string;
    step: number;
    signal?: AbortSignal;
    /** Throw an `AppError` with a stable code. */
    error: typeof fn.error;
};

/**
 * A tool an agent can call.
 *
 * ```ts
 * tools: {
 *   forecast: {
 *     id: 'forecast',
 *     description: 'Current weather for a city',
 *     inputSchema: v.object({ city: v.string().required() }),
 *     execute: async ({ city }, { rest }) => ({ city, celsius: 21 }),
 *   },
 * }
 * ```
 *
 * An MCP tool (`define.McpTool`) is accepted as-is: its `exec` is adapted and
 * its `{ content: [...] }` result is flattened to text. It carries the protocol's
 * `name` instead of an `id` — the resolved tool name is `id ?? name`.
 */
export type AgentTool = {
    _isTool_?: boolean;
    _isMcpTool_?: boolean;
    _tenant_?: string;
    /**
     * Tool id — **required**, and the name the model calls. When a tool is declared
     * in a record (`tools: { forecast }`), the key must be that same id.
     */
    id?: string;
    /** MCP tools carry a `name`; agents resolve `id ?? name`. */
    name?: string;
    /** Shown to the model — say what it does and when to use it. */
    description?: string;
    enabled?: boolean;
    /** Arguments schema: Joi, zod or a plain JSON Schema (defaults to an open object). */
    inputSchema?: Joi.Schema | any;
    /** Handler. The returned value is serialized back to the model. */
    execute?: (input: any, ctx: AgentToolContext) => any | Promise<any>;
    /** MCP-compatible handler (`define.McpTool`) — adapted automatically. */
    exec?: (ctx: any) => any | Promise<any>;
};

/** What a tool must carry to be **declared** — `define.Tool` enforces the id. */
export type AgentToolDefinition = AgentTool & { id: string };

export type AgentTools = Record<string, AgentTool> | AgentTool[];

/**
 * Conversation store. The agent reads the thread before a run and writes the
 * whole updated conversation after it.
 *
 * The optional `ctx` carries what a store may need — the client to write with
 * (`rest`), the tenant, the agent and the caller identity. A store that ignores
 * it (a plain `Map`) stays valid.
 */
export type AgentMemory = {
    get(threadId: string, ctx?: AgentMemoryContext): Promise<AgentMessage[]> | AgentMessage[];
    save(threadId: string, messages: AgentMessage[], ctx?: AgentMemoryContext): Promise<void> | void;
    clear(threadId: string, ctx?: AgentMemoryContext): Promise<void> | void;
    /** Optional — a caller's threads, most recent first (a chat UI needs it). */
    list?(ctx?: AgentMemoryContext & { limit?: number }): Promise<AgentThread[]> | AgentThread[];
    /**
     * Optional — the agent's **working memory**: one durable value per scope key
     * (a profile, a scratchpad). A store that omits it makes `workingMemory`
     * inert — the agent simply has no scratchpad.
     */
    getState?(key: string, ctx?: AgentMemoryContext): Promise<AgentMemoryState | undefined> | AgentMemoryState | undefined;
    setState?(key: string, value: AgentMemoryState, ctx?: AgentMemoryContext): Promise<void> | void;
    /** Optional — forget a scratchpad. */
    clearState?(key: string, ctx?: AgentMemoryContext): Promise<void> | void;
    /**
     * Optional — the **MongoDB collections** the store writes to. The agent loader
     * publishes them so the replication engine copies them like a declared
     * collection (a store outside MongoDB returns nothing).
     */
    collections?(): string[];
};

/** One durable value of the working memory — a markdown block, or a JSON object. */
export type AgentMemoryState = {
    value: any;
    updatedAt?: Date;
};

/**
 * A memory processor — the extension point of a store, at the two moments a
 * memory matters:
 *
 * - `load` — after the thread, the injected turns and the input are assembled,
 *   **before** the model sees them. Rewrite them (redact, translate, drop a
 *   branch, inject what your own search found — see the Semantic recall section
 *   of the Memory page), or return nothing to leave them as they are.
 * - `save` — before the conversation is persisted. Rewrite it, or **throw** to
 *   keep it out of the store entirely (a guardrail): the run still returns its
 *   answer, only the write is skipped.
 *
 * Processors run in declaration order, and a returned array replaces the
 * messages for the next one.
 */
export type AgentMemoryProcessor = {
    /** A label for the logs — optional. */
    id?: string;
    load?: (
        messages: AgentMessage[],
        ctx: AgentMemoryContext,
    ) => AgentMessage[] | void | Promise<AgentMessage[] | void>;
    save?: (
        messages: AgentMessage[],
        ctx: AgentMemoryContext,
    ) => AgentMessage[] | void | Promise<AgentMessage[] | void>;
};

/** What a memory store knows about the run asking for a thread. */
export type AgentMemoryContext = {
    agentId?: string;
    tenant?: string;
    /** The run's client — a Mongo-backed store reads and writes through it. */
    rest?: InstanceType<typeof useRest>;
    /**
     * Opaque caller identity. **Namespaces** the threads of a caller
     * (`threadId` becomes `resourceId:threadId`) — it is **not** an authorization
     * boundary: gate `history` / `clear` with `api.access`.
     */
    resourceId?: string;
};

/** A thread as listed by a memory store (`agents.memory.Mongo().list()`). */
export type AgentThread = {
    threadId: string;
    resourceId?: string;
    /** Derived from the first user message, at creation. */
    title?: string;
    /** Number of stored messages. */
    messages: number;
    createdAt?: Date;
    updatedAt: Date;
};

/** Shared options of the built-in stores (`agents.memory.InMemory` / `.Mongo`). */
export type AgentMemoryOptions = {
    /**
     * Messages kept per thread (default 100). On every save the oldest are
     * dropped: a conversation must not grow until it blows the context window.
     */
    maxMessages?: number;
    /** Namespace each thread under its `resourceId` (default `true`). */
    scoped?: boolean;
};

/**
 * The agent's **working memory** — a durable scratchpad it keeps up to date
 * (a user profile, the state of a task):
 *
 * ```ts
 * define.Agent({
 *   memory: new agents.memory.Mongo({ collection: 'support_threads' }),
 *   workingMemory: {
 *     template: '# Profile\n- Name:\n- Timezone:\n- Preferences:',
 *   },
 * })
 * ```
 *
 * It is injected into the system prompt, and the model updates it through an
 * auto-generated `updateWorkingMemory` tool. A **`template`** is free text the
 * model replaces on each update; a **`schema`** is a validated JSON object that is
 * **deep merged** (`null` removes a field, an array replaces an array). One of the
 * two, not both.
 */
export type AgentWorkingMemory = {
    /** The markdown block the model fills in (replace semantics). */
    template?: string;
    /** Or a schema (Joi, zod, plain JSON Schema) — the update is a **partial** merge. */
    schema?: Joi.Schema | any;
    /**
     * `'resource'` (default) — one scratchpad per caller, shared by all their
     * threads (what a profile wants). `'thread'` — one per conversation.
     */
    scope?: "resource" | "thread";
    /** Expose the update tool to the model (default `true`; `false` for a read-only prompt). */
    tool?: boolean;
};

/** Options of `agents.memory.Mongo()`. */
export type MongoAgentMemoryOptions = AgentMemoryOptions & {
    /**
     * **Required** — the collection holding the threads, in the tenant database.
     * The tenant names it (`_memories_`, `support_threads`…); the store never
     * invents one, and the replication engine copies whatever you choose.
     */
    collection: string;
    /**
     * Opt-in retention on `updatedAt` (MongoDB TTL) — a duration string like
     * `'180d'` or `'24h'`. `false` → explicitly disabled (drops the TTL index),
     * omitted → threads are kept forever. Same vocabulary as the audit and
     * workflow retention.
     */
    ttl?: string | false;
};

/**
 * The subset of a Redis client the store uses — `ioredis` satisfies it.
 * Structural on purpose: a test (or another driver) only has to implement these.
 */
export type RedisClientLike = {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ...args: any[]): Promise<any>;
    del(...keys: string[]): Promise<any>;
    mget(...keys: string[]): Promise<Array<string | null>>;
    expire(key: string, seconds: number): Promise<any>;
    zadd(key: string, score: number, member: string): Promise<any>;
    zrevrange(key: string, start: number, stop: number): Promise<string[]>;
    zrem(key: string, ...members: string[]): Promise<any>;
};

/** Options of `agents.memory.Redis()`. */
export type RedisAgentMemoryOptions = AgentMemoryOptions & {
    /** An existing client — the store never closes it. Takes precedence over the connection options. */
    client?: RedisClientLike;
    /** `redis://` connection string (default: `REDIS_URL`, then host/port/password, then `localhost:6379`). */
    url?: string;
    host?: string;
    port?: number;
    password?: string;
    /** Key namespace (default `anteros:agent-memory`). */
    prefix?: string;
    /**
     * Expiry of a thread — a duration string like `'7d'`, refreshed on every save.
     * `false` → no expiry, omitted → kept forever.
     */
    ttl?: string | false;
};

/** Structured output request — the answer is parsed and validated against `schema`. */
export type AgentStructuredOutput = {
    schema: Joi.Schema | any;
    /** Only used by OpenAI-compatible providers (`response_format.json_schema`). */
    name?: string;
    description?: string;
};

export type AgentCallOptions = {
    /** Thread to read from / write to the memory (same as `memory.thread`). */
    thread?: string;
    /** @deprecated Alias of `thread` — kept for compatibility. */
    threadId?: string;
    /** Opaque caller identity (same as `memory.resource`). */
    resource?: string;
    /** @deprecated Alias of `resource` — kept for compatibility. */
    resourceId?: string;
    /** Max model calls for this run (default: the agent's `maxSteps`, then 5). */
    maxSteps?: number;
    /** Window on the replayed history for this run — the **last N** messages. */
    lastMessages?: number;
    /** Override the provider for this call — including `provider.options` (merged). */
    provider?: Partial<AgentProvider>;
    /** Override the instructions for this run. */
    instructions?: string;
    /**
     * Files and images sent with this run — a path (server-side) or a
     * `File`/`Blob`/base64 payload (front-end, SDK).
     *
     * ```ts
     * await agent.generate('Summarize this invoice', { files: ['./invoices/2026-01.pdf'] });
     * ```
     */
    files?: AgentAttachment | AgentAttachment[];
    /** Where a **path** attachment is resolved from (default: the process cwd). */
    filesBaseDir?: string;
    /**
     * Tools of this run:
     *
     * - `true` (default) — **every** tool the agent declares
     * - `false` — **none**: the run answers directly (the definitions are not even sent)
     * - `['forecast', 'echo']` — **only these** (an allow-list; an unknown name is ignored)
     * - `{ … }` / `[{ … }]` — extra tools, **merged** with the agent's own
     *
     * ```ts
     * await agent.generate('Trie ce texte.', { tools: false });
     * await agent.generate('Météo ?', { tools: ['forecast'] });
     * ```
     */
    tools?: boolean | string[] | AgentTools;
    /** How the model may use the tools (default `'auto'` — it decides). */
    toolChoice?: AgentToolChoice;
    /**
     * Turns injected into the run — **after** the thread history, **before** the
     * input. They are sent to the model *and* saved into the thread, so they are
     * how a conversation is seeded or a history imported:
     *
     * ```ts
     * await agent.generate('Et pour Lyon ?', {
     *   thread: 'chat-1',
     *   messages: [
     *     { role: 'user', content: 'Quel temps à Paris ?' },
     *     { role: 'assistant', content: '18°C et ensoleillé.' },
     *   ],
     * });
     * ```
     *
     * The block may end on an `assistant` turn (continue a conversation, prime a
     * reply); it is normalized like the input and needs no `thread` to be sent.
     * To write a thread **without** a model call, use `agent.remember()`.
     */
    messages?: AgentInput;
    /** Extended thinking for this run — overrides the agent's `thinking` default. */
    thinking?: AgentThinking;
    /** Abort the run — the partial result is returned, not thrown. */
    signal?: AbortSignal;
    /** Shortcut for `structuredOutput: { schema }`. */
    schema?: Joi.Schema | any;
    /** Ask for a typed object instead of free text. */
    structuredOutput?: AgentStructuredOutput;
    /**
     * Memory of this run — the Mastra-style shorthand:
     *
     * ```ts
     * await agent.generate('Remember my favorite color is blue.', {
     *   memory: { resource: 'user-123', thread: 'conversation-123' },
     * })
     * ```
     *
     * The `memory` block wins over the flat `thread` / `resource` options.
     * `threadId` / `resourceId` are accepted as deprecated aliases.
     */
    memory?: {
        /** Thread to read from and write to (with `resource`, its namespace). */
        thread?: string;
        /** @deprecated Alias of `thread`. */
        threadId?: string;
        /** Caller identity — namespaces the thread and feeds dynamic instructions. */
        resource?: string;
        /** @deprecated Alias of `resource`. */
        resourceId?: string;
        /** Read the history but do not write the run back. */
        readOnly?: boolean;
    };
    /** Called after each model call, before its tools run. */
    onStepFinish?: (step: AgentStep) => void | Promise<void>;
};

export type AgentGenerateResult<T = any> = {
    text: string;
    /** Present when a `schema` / `structuredOutput` was requested. */
    object?: T;
    /** Everything the model thought, when `thinking` was on (all steps joined). */
    reasoning?: string;
    toolCalls: AgentToolCall[];
    toolResults: AgentToolResultEntry[];
    steps: AgentStep[];
    usage: AgentUsage;
    finishReason: string;
    /** The complete conversation, ready to be persisted. */
    messages: AgentMessage[];
    error?: string;
};

/** Incremental event of `agent.stream()`. */
export type AgentStreamChunk =
    | { type: "text"; text: string }
    /** Thinking output — never mixed with the answer. */
    | { type: "reasoning"; text: string }
    | { type: "tool_call"; toolCall: AgentToolCall }
    | { type: "tool_result"; toolResult: AgentToolResultEntry }
    | { type: "step"; step: AgentStep }
    | { type: "finish"; finishReason: string; usage: AgentUsage };

/**
 * `agent.stream()` result — start consuming `textStream` immediately, the
 * promises resolve when the run (tool rounds included) is over.
 */
export type AgentStreamResult<T = any> = {
    /** Every event, tool calls and results included. */
    fullStream: AsyncIterable<AgentStreamChunk>;
    /** Just the text tokens, as they arrive. */
    textStream: AsyncIterable<string>;
    text: Promise<string>;
    /** Everything the model thought, when `thinking` was on — same as `generate()`. */
    reasoning: Promise<string | undefined>;
    object: Promise<T | undefined>;
    toolCalls: Promise<AgentToolCall[]>;
    toolResults: Promise<AgentToolResultEntry[]>;
    steps: Promise<AgentStep[]>;
    usage: Promise<AgentUsage>;
    finishReason: Promise<string>;
    messages: Promise<AgentMessage[]>;
    /** Stop the run — the promises resolve with what has been produced so far. */
    abort: (reason?: string) => void;
};

/** Instructions — static text, or computed per call (A/B tests, dynamic prompts). */
export type AgentInstructions =
    | string
    | ((ctx: {
        agent: Agent;
        /** Memory thread of the run. */
        thread?: string;
        /** Caller identity — what a per-user prompt branches on. */
        resource?: string;
        /** @deprecated Alias of `thread`. */
        threadId?: string;
        /** @deprecated Alias of `resource`. */
        resourceId?: string;
        rest?: InstanceType<typeof useRest>;
    }) => string | Promise<string>);

/** Actions exposed by the agents HTTP API (`POST /api/:tenant_id/agents/:agent/:action`). */
export type AgentActions =
    /** Agent metadata (tools, model, options) — no model call. */
    | "info"
    /** Run the agent to completion and return the answer. */
    | "generate"
    /** Same run, streamed as Server-Sent Events. */
    | "stream"
    /** Structured output — requires `api.object` to be declared. */
    | "object"
    /** Read a memory thread. */
    | "history"
    /** List a caller's memory threads — requires a store that supports `list`. */
    | "threads"
    /** Forget a memory thread. */
    | "clear";

/** Context handed to an `api.access` rule of an agent. */
export type AgentAccessContext = {
    rest: InstanceType<typeof useRest>;
    /** The agent the request targets. */
    agent: InstanceType<typeof Agent>;
    /** Action being attempted (`generate`, `stream`…). */
    action: string;
    /** Raw request body. */
    body: any;
    /** Input the run would receive. */
    input?: AgentInput;
    /** Memory thread of the run, when the body carried one. */
    thread?: string;
    /** @deprecated Alias of `thread`. */
    threadId?: string;
    error: typeof fn.error;
    jwt: typeof jwt;
    token: { value: string | null; decoded: Record<string, unknown> | null; provided: boolean; expired: boolean };
};

/** Per-action access rules — `'*'` wildcard, same pattern as collections and vars. */
export type AgentAccess = {
    [key in AgentActions | (string & {})]?: boolean | ((ctx: AgentAccessContext) => boolean | Promise<boolean>);
};

/**
 * HTTP API of an agent (declared in `define.Agent({ api })`).
 *
 * ```ts
 * api: {
 *   access: {
 *     info: true,                                  // public metadata
 *     generate: (ctx) => !!ctx.token.value,        // any authenticated caller
 *     stream: (ctx) => !!ctx.token.value,
 *   },
 *   object: { schema: v.object({ … }) },           // enables the `object` action
 * }
 * ```
 */
export type AgentApi = {
    /** Access rules per action — **no rules = denied** (secure by default). */
    access?: AgentAccess;
    /**
     * Schema returned by the `object` action. Declared **server-side** on purpose:
     * a client never dictates the shape, and the answer is really validated.
     */
    object?: AgentStructuredOutput;
};

/**
 * An agent definition — `{tenant.dir}/agents/**\/*.agent.ts`, declared with
 * `define.Agent({ … })`.
 */
export type AgentConfig = {
    _isAgent_?: boolean;
    /** Injected by the loader — the tenant this definition belongs to. */
    _tenant_?: string;
    /** Identifier — required, unique per tenant. */
    id?: string;
    name?: string;
    /** What the agent is for — required (served by `info`, read by humans). */
    description?: string;
    instructions: AgentInstructions;
    provider: AgentProvider;
    tools?: AgentTools;
    memory?: AgentMemory;
    /** Max model calls per run (default 5). */
    maxSteps?: number;
    /** Default tool choice for every run (default `'auto'`). */
    toolChoice?: AgentToolChoice;
    /** Default reasoning for every run (default off) — overridable per call. */
    thinking?: AgentThinking;
    /**
     * Default window on the replayed history — the **last N** messages of the
     * thread, whatever the store keeps. A cheap way to bound the prompt (a tool
     * round stores several messages, so count is a proxy, not a measure).
     */
    lastMessages?: number;
    /**
     * The agent's durable scratchpad — see `AgentWorkingMemory`. Needs a store that
     * supports it (the three built-in ones do) and, for the default scope, a
     * `resource` at call time.
     */
    workingMemory?: AgentWorkingMemory;
    /**
     * Memory processors — run in declaration order around the model call:
     * `load` on what it will see, `save` on what will be stored (Mastra-style).
     */
    processors?: AgentMemoryProcessor[];
    enabled?: boolean;
    /** HTTP API — reachable at `POST /api/:tenant_id/agents/:id/:action` once declared. */
    api?: AgentApi;
};

/** Alias of `AgentConfig` — what the loader registers in `cfg.agents`. */
export type AgentDefinition = AgentConfig;

/** Tenant-scoped agent registry — the `agents` member of every context. */
export type TenantAgents = {
    /** The agent instance (tenant-bound), or `undefined`. */
    get(id: string): InstanceType<typeof Agent> | undefined;
    has(id: string): boolean;
    /** Declared agent ids of this tenant. */
    ids(): string[];
    list(): InstanceType<typeof Agent>[];
    /** Re-scan `{tenant.dir}/agents` and rebuild the registry. */
    reload(): Promise<void>;
};
