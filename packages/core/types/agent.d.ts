import type Joi from "joi";
import type { useRest } from "../database/rest";
import type { fn } from "../lib/error";
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
/** Base64 image part of a multimodal message (`data` is the raw base64, no `data:` prefix). */
export type AgentImagePart = { type: "image"; data: string; mimeType?: string };
export type AgentContentPart = AgentTextPart | AgentImagePart;

export type AgentUserMessage = { role: "user"; content: string | AgentContentPart[] };
export type AgentSystemMessage = { role: "system"; content: string };
export type AgentAssistantMessage = {
    role: "assistant";
    content: string | null;
    /** Set when the model asked to call tools (echoed back on the next turn). */
    toolCalls?: AgentToolCall[];
};
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

/** What `generate()` / `stream()` accept as input. */
export type AgentInput = string | AgentMessage | AgentMessage[];

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
 *   weather: {
 *     description: 'Current weather for a city',
 *     inputSchema: v.object({ city: v.string().required() }),
 *     execute: async ({ city }, { rest }) => ({ city, celsius: 21 }),
 *   },
 * }
 * ```
 *
 * An MCP tool (`define.McpTool`) is accepted as-is: its `exec` is adapted and
 * its `{ content: [...] }` result is flattened to text.
 */
export type AgentTool = {
    _isTool_?: boolean;
    _isMcpTool_?: boolean;
    _tenant_?: string;
    /** Tool name — defaults to the key it is declared under. */
    name?: string;
    id?: string;
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

export type AgentTools = Record<string, AgentTool> | AgentTool[];

/**
 * Conversation store. The agent reads the thread before a run and writes the
 * whole updated conversation after it.
 */
export type AgentMemory = {
    get(threadId: string): Promise<AgentMessage[]> | AgentMessage[];
    save(threadId: string, messages: AgentMessage[]): Promise<void> | void;
    clear(threadId: string): Promise<void> | void;
};

/** Structured output request — the answer is parsed and validated against `schema`. */
export type AgentStructuredOutput = {
    schema: Joi.Schema | any;
    /** Only used by OpenAI-compatible providers (`response_format.json_schema`). */
    name?: string;
    description?: string;
};

export type AgentCallOptions = {
    /** Thread to read from / write to the memory. */
    threadId?: string;
    /** Opaque caller identity — forwarded to the memory and the instruction function. */
    resourceId?: string;
    /** Max model calls for this run (default: the agent's `maxSteps`, then 5). */
    maxSteps?: number;
    /** Override the provider for this call — including `provider.options` (merged). */
    provider?: Partial<AgentProvider>;
    /** Override the instructions for this run. */
    instructions?: string;
    /** Extra tools for this run (merged with the agent's own). */
    tools?: AgentTools;
    /** Abort the run — the partial result is returned, not thrown. */
    signal?: AbortSignal;
    /** Shortcut for `structuredOutput: { schema }`. */
    schema?: Joi.Schema | any;
    /** Ask for a typed object instead of free text. */
    structuredOutput?: AgentStructuredOutput;
    memory?: {
        threadId: string;
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
        threadId?: string;
        resourceId?: string;
        rest?: InstanceType<typeof useRest>;
    }) => string | Promise<string>);

/**
 * An agent definition — `{tenant.dir}/agents/**\/*.agent.ts`, declared with
 * `define.Agent({ … })`.
 */
export type AgentConfig = {
    _isAgent_?: boolean;
    /** Injected by the loader — the tenant this definition belongs to. */
    _tenant_?: string;
    /** Identifier — defaults to the file name (`weather.agent.ts` → `weather`). */
    id?: string;
    name?: string;
    description?: string;
    instructions: AgentInstructions;
    provider: AgentProvider;
    tools?: AgentTools;
    memory?: AgentMemory;
    /** Max model calls per run (default 5). */
    maxSteps?: number;
    enabled?: boolean;
};

/** Alias of `AgentConfig` — what the loader registers in `cfg.agents`. */
export type AgentDefinition = AgentConfig;

/** Tenant-scoped agent registry — `rest.agents`. */
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
