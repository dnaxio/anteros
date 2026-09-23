import { AppError, fn } from "./error";
import { toJsonSchema, validateWithSchema } from "./jsonSchema";
import { InMemoryAgentMemory, trimMessages } from "./agentMemory";
import { forMemory, resolveAttachments } from "./attachment";
import { normalizeMessages, serializeToolResult } from "./messages";
import {
    EMPTY_USAGE,
    resolveProvider,
} from "./providers";
import type {
    AgentToolSpec,
    ModelAdapter,
    ModelChatRequest,
} from "./providers";
import type { useRest } from "../database/rest";
import type {
    AgentCallOptions,
    AgentConfig,
    AgentGenerateResult,
    AgentInput,
    AgentInstructions,
    AgentMediaPart,
    AgentMemory,
    AgentMemoryContext,
    AgentMemoryProcessor,
    AgentMemoryState,
    AgentMessage,
    AgentOptions,
    AgentTextPart,
    AgentThinkingBlock,
    AgentThread,
    AgentProvider,
    AgentStreamChunk,
    AgentStreamResult,
    AgentStep,
    AgentTool,
    AgentToolCall,
    AgentToolContext,
    AgentToolResultEntry,
    AgentTools,
    AgentUsage,
    AgentWorkingMemory,
} from "../types/agent";

/**
 * Agents — an LLM with instructions, tools and memory.
 *
 * Use an agent when the task is open-ended: the model decides which tools to
 * call, how many times, and when to answer. Use a workflow when the steps are
 * known in advance.
 *
 * ```ts
 * // v1/agents/weather.agent.ts
 * import { define, v } from '@anteros/core'
 *
 * export default define.Agent({
 *   id: 'weather',
 *   instructions: 'You are a concise weather assistant.',
 *   provider: { model: 'gpt-4o-mini', apiKey: Bun.env.OPENAI_API_KEY },
 *   tools: {
 *     forecast: {
 *       description: 'Current weather for a city',
 *       inputSchema: v.object({ city: v.string().required() }),
 *       execute: async ({ city }, { rest }) => ({ city, celsius: 21 }),
 *     },
 *   },
 * })
 *
 * // anywhere you have a context — a route, a service, a hook, a script…
 * const { text } = await agents.get('weather')!.generate('Weather in Paris?')
 * ```
 *
 * The provider is declared inline — `{ model, apiKey, compatible }` — with no
 * SDK: `'openai'` (the default, and every OpenAI-compatible gateway) or
 * `'anthropic'`.
 */

const DEFAULT_MAX_STEPS = 5;

// ─── Small async primitives ──────────────────────────────────────────────

/** Unbounded async queue — bridges a push producer with a pull consumer. */
class AsyncQueue<T> {
    #items: T[] = [];
    #waiters: Array<() => void> = [];
    #closed = false;
    #error: any = null;

    push(item: T): void {
        if (this.#closed) return;
        this.#items.push(item);
        for (const wake of this.#waiters.splice(0)) wake();
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        for (const wake of this.#waiters.splice(0)) wake();
    }

    fail(error: any): void {
        if (this.#closed) return;
        this.#error = error;
        this.#closed = true;
        for (const wake of this.#waiters.splice(0)) wake();
    }

    async next(): Promise<IteratorResult<T>> {
        for (;;) {
            if (this.#error) throw this.#error;
            if (this.#items.length) return { value: this.#items.shift() as T, done: false };
            if (this.#closed) return { value: undefined as any, done: true };
            await new Promise<void>((resolve) => this.#waiters.push(resolve));
        }
    }

    [Symbol.asyncIterator](): AsyncIterator<T> {
        return { next: () => this.next() };
    }
}

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: any) => void;
};

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: any) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

// ─── Tool helpers ────────────────────────────────────────────────────────

/** Normalize `AgentTools` (record or array) into entries, keyed by tool id. */
function toolEntries(tools: AgentTools): Array<[string, AgentTool]> {
    const entries: Array<[string, AgentTool]> = [];

    const resolve = (tool: AgentTool, label?: string): [string, AgentTool] => {
        // An MCP tool carries the protocol's `name`; our own tools carry an `id`
        const id = tool?.id ?? tool?.name;
        if (!id) {
            throw new AppError("A tool requires an `id` (`define.Tool({ id, description, execute })`)", {
                status: 500, code: "AGENT_TOOL_INVALID",
            });
        }
        // The record key is a label for the reader — it must agree with the id, since
        // the id is what the model calls
        if (label !== undefined && label !== id) {
            throw new AppError(
                `Tool '${label}' has id '${id}' — the key must match the id`,
                { status: 500, code: "AGENT_TOOL_ID_MISMATCH" },
            );
        }
        return [id, tool];
    };

    if (Array.isArray(tools)) {
        for (const tool of tools) entries.push(resolve(tool));
        return entries;
    }

    for (const [label, tool] of Object.entries(tools)) entries.push(resolve(tool, label));
    return entries;
}

function requireHandler(name: string, tool: AgentTool): void {
    if (typeof tool.execute !== "function" && typeof tool.exec !== "function") {
        throw new AppError(`Tool '${name}' has neither \`execute\` nor \`exec\``, {
            status: 500,
            code: "AGENT_TOOL_INVALID",
        });
    }
}

/** Parse the arguments the model produced (`{}` when it emitted invalid JSON). */
function toToolCall(raw: { id: string; name: string; argsText: string }): AgentToolCall {
    const argsText = raw.argsText ?? "";
    let args: Record<string, any> = {};
    if (argsText.trim()) {
        try {
            const parsed = JSON.parse(argsText);
            args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
        } catch {
            args = {};
        }
    }
    return { id: raw.id, name: raw.name, args, argsText };
}

/** The tool the framework adds when `workingMemory` is declared. */
const WORKING_MEMORY_TOOL = "updateWorkingMemory";

/**
 * The system-prompt block of the working memory — what the model reads, and the
 * rule that keeps it up to date.
 */
function workingMemoryBlock(config: AgentWorkingMemory, value: any): string {
    const head = "## Working memory\n\n";
    const rule = config.tool === false
        ? ""
        : `\n\nKeep it up to date with the \`${WORKING_MEMORY_TOOL}\` tool: record what is durable,\nremove what is no longer true, and never store secrets.`;

    if (config.schema) {
        return `${head}\`\`\`json\n${JSON.stringify(value ?? {}, null, 2)}\n\`\`\`${rule}`;
    }

    const body = typeof value === "string" && value.trim() ? value : (config.template ?? "");
    return `${head}${body}${rule}`;
}

/**
 * A **partial** update of a structured working memory: objects are deep merged,
 * a `null` removes a key, an array replaces the array.
 */
function mergeWorkingMemory(current: any, patch: any): any {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;

    const base: Record<string, any> = current && typeof current === "object" && !Array.isArray(current)
        ? { ...current }
        : {};

    for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete base[key];
        else if (value && typeof value === "object" && !Array.isArray(value)) base[key] = mergeWorkingMemory(base[key], value);
        else base[key] = value;
    }

    return base;
}

/**
 * Run the `load` or `save` processors in order. A processor that returns nothing
 * leaves the conversation as it is; a thrown error stops the pipeline (for
 * `save`, the caller catches it and stores nothing).
 */
async function applyProcessors(
    processors: AgentMemoryProcessor[] | undefined,
    hook: "load" | "save",
    messages: AgentMessage[],
    ctx: AgentMemoryContext,
): Promise<AgentMessage[]> {
    let current = messages;
    for (const processor of processors ?? []) {
        const result = await processor[hook]?.(current, ctx);
        if (Array.isArray(result)) current = result;
    }
    return current;
}

// ─── Usage / structured output ───────────────────────────────────────────

function addUsage(base: AgentUsage, next: Partial<AgentUsage>): AgentUsage {
    const inputTokens = base.inputTokens + (next.inputTokens ?? 0);
    const outputTokens = base.outputTokens + (next.outputTokens ?? 0);
    return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        requests: base.requests + (next.requests ?? 0),
    };
}

function structuredSuffix(schema: any): string {
    return "\n\nRespond with a single JSON object matching this JSON Schema, and nothing else"
        + " — no markdown fence, no commentary:\n"
        + JSON.stringify(schema, null, 2);
}

/**
 * Attach resolved parts to the turn being asked — the **last user message**, like
 * an email with attachments. A missing user turn gets a new one.
 */
function attachToTurn(messages: AgentMessage[], parts: AgentMediaPart[]): void {
    const last = messages[messages.length - 1];

    if (last?.role === "user") {
        const existing = Array.isArray(last.content) ? last.content : [];
        const text = typeof last.content === "string" && last.content ? [{ type: "text" as const, text: last.content }] : [];
        last.content = [...text, ...existing, ...parts];
        return;
    }

    messages.push({ role: "user", content: parts });
}

/**
 * What a run keeps in its memory: the text verbatim, the heavy parts replaced by
 * a note (`[file report.pdf]`) — a conversation is text, not a file store.
 */
function lightenForMemory(messages: AgentMessage[]): AgentMessage[] {
    return messages.map((message) => {
        if (!Array.isArray(message.content)) return message;

        const text = message.content
            .filter((part): part is AgentTextPart => part.type === "text")
            .map((part) => part.text);
        const notes = message.content
            .filter((part) => part.type !== "text")
            .map((part) => forMemory(part).text)
            .filter(Boolean);

        return { ...message, content: [...text, ...notes].join("\n\n") };
    });
}

/** Read the JSON out of a model answer, tolerating a markdown fence. */
function extractJson(text: string): { value?: any; error?: string } {
    const trimmed = (text ?? "").trim();
    if (!trimmed) return { error: "the answer was empty" };
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const candidate = (fenced ? fenced[1] : trimmed) ?? trimmed;
    try {
        return { value: JSON.parse(candidate) };
    } catch (err: any) {
        return { error: err?.message ?? "invalid JSON" };
    }
}

// ─── Default memory ──────────────────────────────────────────────────────
// The stores live in `lib/agentMemory.ts` (`agents.memory.InMemory` / `.Mongo`).

export { InMemoryAgentMemory };

// ─── The agent ───────────────────────────────────────────────────────────

type RunOptions = {
    input: AgentInput;
    call: AgentCallOptions;
    streaming: boolean;
    controller: AbortController;
    emit?: (chunk: AgentStreamChunk) => void;
};

class Agent {
    _isAgent_ = true;
    _tenant_?: string;

    #config: AgentConfig;
    #tools = new Map<string, AgentTool>();
    #rest?: InstanceType<typeof useRest>;

    constructor(config: AgentConfig, options: { rest?: InstanceType<typeof useRest>; tenant?: string } = {}) {
        if (!config || typeof config !== "object") {
            throw new AppError("An agent requires a configuration object", { status: 500, code: "AGENT_INVALID" });
        }
        if (!config.instructions) {
            throw new AppError(`Agent '${config.id ?? "?"}' requires \`instructions\``, { status: 500, code: "AGENT_INVALID" });
        }
        if (!config.id) {
            throw new AppError("An agent requires an `id`", { status: 500, code: "AGENT_INVALID" });
        }
        if (!config.description) {
            throw new AppError(`Agent '${config.id}' requires a \`description\``, { status: 500, code: "AGENT_INVALID" });
        }
        if (!config.provider?.model) {
            throw new AppError(`Agent '${config.id}' requires \`provider.model\``, { status: 500, code: "AGENT_INVALID" });
        }
        if (config.workingMemory && !!config.workingMemory.template === !!config.workingMemory.schema) {
            throw new AppError(
                `Agent '${config.id}': \`workingMemory\` needs a \`template\` **or** a \`schema\` — not both, not neither`,
                { status: 500, code: "AGENT_WORKING_MEMORY_INVALID" },
            );
        }

        this.#config = config;
        this._tenant_ = config._tenant_ ?? options.tenant;
        this.#rest = options.rest;
        if (config.tools) this.setTools(config.tools);
    }

    static isAgent(value: any): boolean {
        return !!value && value._isAgent_ === true;
    }

    // ── Identity ─────────────────────────────────────────────────────────

    getId(): string | undefined {
        return this.#config.id;
    }

    getName(): string {
        return this.#config.name ?? this.#config.id ?? "agent";
    }

    getDescription(): string | undefined {
        return this.#config.description;
    }

    getTenant(): string | undefined {
        return this._tenant_;
    }

    getConfig(): AgentConfig {
        return this.#config;
    }

    // ── Provider ─────────────────────────────────────────────────────────

    /** The provider as declared — the API key is **not** included. */
    getProvider(): AgentProvider {
        const { apiKey, ...rest } = this.#config.provider;
        return { ...rest, options: { ...this.#config.provider.options } };
    }

    /** Sampling and transport options as declared (`provider.options`). */
    getOptions(): AgentOptions {
        return { ...this.#config.provider.options };
    }

    /** Merge `provider.options` (`{ temperature, maxTokens, topP, timeout, retries }`). */
    setOptions(options: AgentOptions): this {
        this.#config.provider.options = { ...this.#config.provider.options, ...options };
        return this;
    }

    getModel(): string {
        return this.#config.provider.model;
    }

    /** Merge a provider override (a single field is enough — e.g. the model). */
    setProvider(provider: Partial<AgentProvider>): this {
        this.#config.provider = { ...this.#config.provider, ...provider };
        return this;
    }

    setModel(model: string): this {
        return this.setProvider({ model });
    }

    // ── Instructions ─────────────────────────────────────────────────────

    /** The declaration as written (a string, or a function). */
    getInstructions(): AgentInstructions {
        return this.#config.instructions;
    }

    /** The resolved system prompt for this call. */
    async resolveInstructions(ctx: { thread?: string; resource?: string; threadId?: string; resourceId?: string } = {}): Promise<string> {
        const raw = this.#config.instructions;
        if (typeof raw === "function") {
            // Both spellings are handed over: a prompt written against `threadId`
            // keeps working after the renaming.
            const thread = ctx.thread ?? ctx.threadId;
            const resource = ctx.resource ?? ctx.resourceId;
            return (await raw({ agent: this, rest: this.#rest, thread, resource, threadId: thread, resourceId: resource })) ?? "";
        }
        return raw ?? "";
    }

    setInstructions(instructions: AgentInstructions): this {
        this.#config.instructions = instructions;
        return this;
    }

    // ── Tools ────────────────────────────────────────────────────────────

    /** The declared tools, keyed by name. */
    getTools(): Record<string, AgentTool> {
        return Object.fromEntries(this.#tools);
    }

    hasTool(name: string): boolean {
        return this.#tools.has(name);
    }

    /** Replace the tool set. */
    setTools(tools: AgentTools): this {
        const entries = toolEntries(tools);
        for (const [name, tool] of entries) requireHandler(name, tool);
        this.#tools = new Map(entries);
        return this;
    }

    /** Add or replace one tool — its `id` is the name the model sees. */
    addTool(tool: AgentTool): this {
        const entry = toolEntries([tool])[0]!;
        requireHandler(entry[0], entry[1]);
        this.#tools.set(entry[0], entry[1]);
        return this;
    }

    removeTool(name: string): boolean {
        return this.#tools.delete(name);
    }

    // ── Memory ───────────────────────────────────────────────────────────

    getMemory(): AgentMemory | undefined {
        return this.#config.memory;
    }

    // ── Working memory ───────────────────────────────────────────────────

    /**
     * The key the working memory is stored under: the caller (`'resource'`, the
     * default) or the conversation (`'thread'`). `undefined` when the run has
     * nothing to scope it with — the scratchpad is then simply not used.
     */
    #workingMemoryKey(ctx: { thread?: string; resource?: string } = {}): string | undefined {
        const config = this.#config.workingMemory;
        if (!config) return undefined;

        if ((config.scope ?? "resource") === "thread") {
            return ctx.thread ? (ctx.resource ? `thread:${ctx.resource}:${ctx.thread}` : `thread:${ctx.thread}`) : undefined;
        }
        return ctx.resource ? `resource:${ctx.resource}` : undefined;
    }

    /** The store of the scratchpad, when it has one. */
    #stateStore(): AgentMemory & Required<Pick<AgentMemory, "getState" | "setState">> {
        const memory = this.#config.memory;
        if (!memory) {
            throw new AppError(`Agent '${this.getId() ?? "?"}' declares no memory`, {
                status: 400, code: "AGENT_NO_MEMORY",
            });
        }
        if (typeof memory.getState !== "function" || typeof memory.setState !== "function") {
            throw new AppError(
                `The memory of agent '${this.getId() ?? "?"}' does not store a working memory`,
                { status: 400, code: "AGENT_WORKING_MEMORY_UNSUPPORTED" },
            );
        }
        return memory as AgentMemory & Required<Pick<AgentMemory, "getState" | "setState">>;
    }

    /** The scratchpad value must fit the declared schema, whoever wrote it. */
    async #validateWorkingMemory(value: any): Promise<void> {
        const schema = this.#config.workingMemory?.schema;
        if (!schema) return;

        const { error } = await validateWithSchema(schema, value);
        if (error) {
            throw new AppError(`Invalid working memory: ${error}`, {
                status: 400, code: "AGENT_WORKING_MEMORY_VALUE_INVALID",
            });
        }
    }

    /**
     * Read the agent's scratchpad — the profile it keeps about a caller, or the
     * state of a conversation (`workingMemory.scope`).
     */
    async getWorkingMemory(ctx: { thread?: string; resource?: string } = {}): Promise<any> {
        const key = this.#workingMemoryKey(ctx);
        if (!key) return undefined;
        const state = await this.#stateStore().getState(key, this.#memoryCtx(ctx.resource));
        return state?.value;
    }

    /**
     * Write the scratchpad **without calling the model** — seed a profile, or
     * correct it from your own code.
     *
     * ```ts
     * await support.setWorkingMemory('# Profile\n- Name: Sam\n- Timezone: CET', {
     *   resource: 'user-42',
     * });
     * ```
     *
     * With a `schema`, the value is validated and **merged** into what is stored
     * (`null` removes a key); with a `template`, it **replaces** the block.
     */
    async setWorkingMemory(value: any, ctx: { thread?: string; resource?: string } = {}): Promise<any> {
        const memory = this.#stateStore(); // `AGENT_NO_MEMORY` / unsupported first: nothing to write into
        const config = this.#config.workingMemory;
        if (!config) {
            throw new AppError(`Agent '${this.getId() ?? "?"}' declares no \`workingMemory\``, {
                status: 400, code: "AGENT_WORKING_MEMORY_DISABLED",
            });
        }

        const key = this.#workingMemoryKey(ctx);
        if (!key) {
            throw new AppError(
                `A \`${config.scope ?? "resource"}\`-scoped working memory needs \`${(config.scope ?? "resource") === "thread" ? "thread" : "resource"}\``,
                { status: 400, code: "AGENT_WORKING_MEMORY_SCOPE_REQUIRED" },
            );
        }

        const context = this.#memoryCtx(ctx.resource);
        let next = value;

        if (config.schema) {
            const current = (await memory.getState(key, context))?.value;
            next = mergeWorkingMemory(current, value);
            await this.#validateWorkingMemory(next);
        }

        await memory.setState(key, { value: next, updatedAt: new Date() }, context);
        return next;
    }

    /** Forget a scratchpad. */
    async clearWorkingMemory(ctx: { thread?: string; resource?: string } = {}): Promise<void> {
        const key = this.#workingMemoryKey(ctx);
        if (!key) return;
        const memory = this.#stateStore();
        await memory.clearState?.(key, this.#memoryCtx(ctx.resource));
    }

    setMemory(memory?: AgentMemory): this {
        this.#config.memory = memory;
        return this;
    }

    /** What a store needs to know — the client, the tenant, the caller. */
    #memoryCtx(resourceId?: string): AgentMemoryContext {
        return {
            agentId: this.#config.id,
            tenant: this._tenant_,
            rest: this.#rest,
            resourceId,
        };
    }

    /** The stored conversation of a thread (`[]` when there is no memory). */
    async getMessages(thread: string, ctx?: { resource?: string; resourceId?: string }): Promise<AgentMessage[]> {
        if (!this.#config.memory) return [];
        const resource = ctx?.resource ?? ctx?.resourceId;
        return [...(await this.#config.memory.get(thread, this.#memoryCtx(resource)))];
    }

    /**
     * The tool the model uses to keep its scratchpad up to date. Template mode
     * replaces the block; schema mode takes a **partial** object (every field
     * optional) and merges it.
     */
    async #workingMemoryTool(stateKey: string, ctx: AgentMemoryContext): Promise<AgentTool> {
        const config = this.#config.workingMemory!;
        const memory = this.#config.memory!;

        // Schema mode → patch semantics: what the model omits is left as it is
        let inputSchema: any = {
            type: "object",
            properties: {
                content: {
                    type: "string",
                    description: "The complete working memory block, as markdown — what should be kept from now on.",
                },
            },
            required: ["content"],
        };

        if (config.schema) {
            inputSchema = { ...(await toJsonSchema(config.schema)) };
            delete inputSchema.required;
        }

        return {
            id: WORKING_MEMORY_TOOL,
            description: config.schema
                ? "Update the working memory with the fields you learned. Send only the fields to change; send null to remove one."
                : "Save the working memory: the profile and the durable facts worth keeping. Send the whole block, updated.",
            inputSchema,
            execute: async (input: any) => {
                const current = (await memory.getState!(stateKey, ctx))?.value;
                const next = config.schema
                    ? mergeWorkingMemory(current, input)
                    : (input?.content ?? "");

                // A patch that breaks the schema is reported to the model — the run goes on
                if (config.schema) await this.#validateWorkingMemory(next);

                await memory.setState!(stateKey, { value: next, updatedAt: new Date() }, ctx);
                return { ok: true };
            },
        };
    }

    /**
     * Add turns to a stored thread **without calling the model**.
     *
     * A store replaces a thread on `save()`, so this reads it, appends and writes
     * it back — the `maxMessages` cap and the caller namespace still apply, and the
     * heavy payloads of an attachment are stored as a note, exactly like a run
     * does. Use it to seed a conversation, to import a history from elsewhere, or
     * to persist what happened outside the agent.
     *
     * ```ts
     * await agent.remember('chat-1', [
     *   { role: 'user', content: 'Bonjour' },
     *   { role: 'assistant', content: 'Bonjour ! Comment puis-je aider ?' },
     * ]);
     * ```
     *
     * @returns the whole stored thread, as it now is.
     */
    async remember(
        thread: string,
        messages: AgentInput,
        ctx?: { resource?: string; resourceId?: string },
    ): Promise<AgentMessage[]> {
        const memory = this.#config.memory;
        if (!memory) {
            throw new AppError(`Agent '${this.getId() ?? "?"}' declares no memory`, {
                status: 400, code: "AGENT_NO_MEMORY",
            });
        }

        const context = this.#memoryCtx(ctx?.resource ?? ctx?.resourceId);
        const existing = [...(await memory.get(thread, context))];
        const next = [...existing, ...lightenForMemory(await normalizeMessages(messages))];
        await memory.save(thread, next, context);
        return next;
    }

    async clearMessages(thread: string, ctx?: { resource?: string; resourceId?: string }): Promise<void> {
        const resource = ctx?.resource ?? ctx?.resourceId;
        await this.#config.memory?.clear(thread, this.#memoryCtx(resource));
    }

    /**
     * Every thread of a caller — only for a store that supports it
     * (`agents.memory.Mongo().list()`); `[]` otherwise.
     */
    async listThreads(ctx?: { resource?: string; resourceId?: string; limit?: number }): Promise<AgentThread[]> {
        const memory = this.#config.memory;
        if (!memory?.list) return [];
        const resource = ctx?.resource ?? ctx?.resourceId;
        return [...(await memory.list({ ...this.#memoryCtx(resource), limit: ctx?.limit }))];
    }

    /** Forget a thread — or the whole in-process memory when no thread is given. */
    async reset(thread?: string): Promise<void> {
        if (thread) return this.clearMessages(thread);
        this.#config.memory = new InMemoryAgentMemory();
    }

    // ── Runtime wiring (used by the loader) ──────────────────────────────

    setRest(rest: InstanceType<typeof useRest>): this {
        this.#rest = rest;
        return this;
    }

    getRest(): InstanceType<typeof useRest> | undefined {
        return this.#rest;
    }

    /** Serializable view — never exposes the API key. */
    toJSON(): Record<string, any> {
        return {
            id: this.#config.id,
            name: this.getName(),
            description: this.#config.description,
            tenant: this._tenant_,
            provider: { ...this.getProvider(), compatible: this.#config.provider.compatible ?? "openai" },
            instructions: typeof this.#config.instructions === "string" ? this.#config.instructions : "[dynamic]",
            tools: [...this.#tools.keys()],
            maxSteps: this.#config.maxSteps ?? DEFAULT_MAX_STEPS,
            toolChoice: this.#config.toolChoice ?? "auto",
            thinking: this.#config.thinking ?? false,
            memory: !!this.#config.memory,
        };
    }

    // ── Run ──────────────────────────────────────────────────────────────

    /**
     * Run the agent to completion and return the final answer.
     * Tool calls are executed in between, until the model answers without
     * asking for a tool (or `maxSteps` is reached).
     */
    async generate<T = any>(input: AgentInput, options: AgentCallOptions = {}): Promise<AgentGenerateResult<T>> {
        return this.#run<T>({ input, call: options, streaming: false, controller: new AbortController() });
    }

    /**
     * Same as `generate()`, but the answer is forced into a typed object and
     * validated with the schema (`AGENT_OUTPUT_INVALID` when it stays invalid).
     */
    async generateObject<T = any>(input: AgentInput, options: AgentCallOptions = {}): Promise<T> {
        if (!options.schema && !options.structuredOutput) {
            throw new AppError("`generateObject` requires a `schema` (or `structuredOutput`)", {
                status: 500,
                code: "AGENT_SCHEMA_REQUIRED",
            });
        }
        const result = await this.generate<T>(input, options);
        if (result.object === undefined) {
            throw new AppError(`Agent '${this.getId() ?? "?"}' did not return a valid object`, {
                status: 502,
                code: "AGENT_OUTPUT_INVALID",
                reason: result.text,
            });
        }
        return result.object;
    }

    /**
     * Run the agent and stream the answer token by token.
     * The promises of the returned object resolve when the **run** is over
     * (tool rounds included) — `await stream.text` is not the last token.
     */
    stream<T = any>(input: AgentInput, options: AgentCallOptions = {}): AgentStreamResult<T> {
        const textQueue = new AsyncQueue<string>();
        const fullQueue = new AsyncQueue<AgentStreamChunk>();
        const controller = new AbortController();

        const emit = (chunk: AgentStreamChunk) => {
            fullQueue.push(chunk);
            if (chunk.type === "text") textQueue.push(chunk.text);
        };

        const text = deferred<string>();
        const reasoning = deferred<string | undefined>();
        const object = deferred<T | undefined>();
        const toolCalls = deferred<AgentToolCall[]>();
        const toolResults = deferred<AgentToolResultEntry[]>();
        const steps = deferred<AgentStep[]>();
        const usage = deferred<AgentUsage>();
        const finishReason = deferred<string>();
        const messages = deferred<AgentMessage[]>();

        const deferreds = [text, reasoning, object, toolCalls, toolResults, steps, usage, finishReason, messages];

        // The caller may only consume `textStream` — a rejected promise nobody
        // awaits must not become an unhandled rejection.
        for (const pending of deferreds) {
            pending.promise.catch(() => {});
        }

        void (async () => {
            try {
                const result = await this.#run<T>({ input, call: options, streaming: true, controller, emit });
                text.resolve(result.text);
                reasoning.resolve(result.reasoning);
                object.resolve(result.object);
                toolCalls.resolve(result.toolCalls);
                toolResults.resolve(result.toolResults);
                steps.resolve(result.steps);
                usage.resolve(result.usage);
                finishReason.resolve(result.finishReason);
                messages.resolve(result.messages);
                emit({ type: "finish", finishReason: result.finishReason, usage: result.usage });
                textQueue.close();
                fullQueue.close();
            } catch (err) {
                for (const pending of deferreds) pending.reject(err);
                textQueue.fail(err);
                fullQueue.fail(err);
            }
        })();

        return {
            textStream: textQueue,
            fullStream: fullQueue,
            text: text.promise,
            /** Everything the model thought, when `thinking` was on — like `generate()`. */
            reasoning: reasoning.promise,
            object: object.promise,
            toolCalls: toolCalls.promise,
            toolResults: toolResults.promise,
            steps: steps.promise,
            usage: usage.promise,
            finishReason: finishReason.promise,
            messages: messages.promise,
            abort: (reason?: string) => controller.abort(reason),
        };
    }

    // ── Internals ────────────────────────────────────────────────────────

    /** Provider merged with the call-level override — `options` merged too, not replaced. */
    #provider(override?: Partial<AgentProvider>): AgentProvider {
        const base = this.#config.provider;
        if (!override) return base;
        return {
            ...base,
            ...override,
            options: { ...base.options, ...override.options },
        };
    }

    /**
     * The tools of one run — `true` (all), `false` (none), an array of **names**
     * (an allow-list) or extra tools to merge in.
     */
    #collectTools(requested?: boolean | string[] | AgentTools): Map<string, AgentTool> {
        // `tools: false` — the run answers directly
        if (requested === false) return new Map();

        const tools = new Map(this.#tools);

        // `tools: ['forecast', 'echo']` — only these (an unknown name is ignored:
        // tool availability may legitimately vary between callers)
        if (Array.isArray(requested) && requested.every((entry) => typeof entry === "string")) {
            const wanted = new Set(requested as string[]);
            for (const name of [...tools.keys()]) {
                if (!wanted.has(name)) tools.delete(name);
            }
            return tools;
        }

        // `tools: true` — everything the agent declares; a record/array of tools merges in
        if (requested && requested !== true) {
            for (const [name, tool] of toolEntries(requested as AgentTools)) {
                requireHandler(name, tool);
                tools.set(name, tool);
            }
        }

        return tools;
    }

    async #toolSpecs(tools: Map<string, AgentTool>): Promise<AgentToolSpec[]> {
        const specs: AgentToolSpec[] = [];
        for (const [name, tool] of tools) {
            if (tool.enabled === false) continue;
            specs.push({
                name,
                description: tool.description,
                parameters: await toJsonSchema(tool.inputSchema),
            });
        }
        return specs;
    }

    /** One model call, without streaming. */
    async #chat(adapter: ModelAdapter, request: ModelChatRequest): Promise<{
        text: string;
        reasoning?: string;
        thinking?: AgentThinkingBlock[];
        toolCalls: AgentToolCall[];
        finishReason: string;
        usage: AgentUsage;
    }> {
        const response = await adapter.chat(request);
        return {
            text: response.text,
            ...(response.reasoning ? { reasoning: response.reasoning } : {}),
            ...(response.thinking?.length ? { thinking: response.thinking } : {}),
            toolCalls: response.toolCalls.map(toToolCall),
            finishReason: response.finishReason,
            usage: response.usage,
        };
    }

    /** One model call, streaming — the deltas are reassembled into a full turn. */
    async #chatStream(adapter: ModelAdapter, request: ModelChatRequest, emit: (chunk: AgentStreamChunk) => void): Promise<{
        text: string;
        reasoning?: string;
        thinking?: AgentThinkingBlock[];
        toolCalls: AgentToolCall[];
        finishReason: string;
        usage: AgentUsage;
    }> {
        const partial = new Map<number, { id?: string; name?: string; argsText?: string }>();
        let text = "";
        let reasoning = "";
        let thinking: AgentThinkingBlock[] | undefined;
        let finishReason = "stop";
        let usage: Partial<AgentUsage> = {};

        for await (const event of adapter.chatStream(request)) {
            switch (event.type) {
                case "text":
                    text += event.text;
                    emit({ type: "text", text: event.text });
                    break;
                case "reasoning":
                    reasoning += event.text;
                    emit({ type: "reasoning", text: event.text });
                    break;
                case "thinking_blocks":
                    thinking = [...(thinking ?? []), ...event.blocks];
                    break;
                case "tool_call": {
                    const current = partial.get(event.index) ?? {};
                    if (event.id) current.id = event.id;
                    if (event.name) current.name = event.name;
                    if (event.argsText) current.argsText = (current.argsText ?? "") + event.argsText;
                    partial.set(event.index, current);
                    break;
                }
                case "usage":
                    usage = {
                        inputTokens: event.usage.inputTokens ?? usage.inputTokens,
                        outputTokens: event.usage.outputTokens ?? usage.outputTokens,
                    };
                    break;
                case "finish":
                    finishReason = event.finishReason;
                    break;
            }
        }

        const toolCalls = [...partial.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([index, call]) => toToolCall({
                id: call.id ?? `call_${index}`,
                name: call.name ?? "unknown",
                argsText: call.argsText ?? "{}",
            }));

        return {
            text,
            ...(reasoning ? { reasoning } : {}),
            ...(thinking?.length ? { thinking } : {}),
            toolCalls,
            finishReason,
            usage: {
                inputTokens: usage.inputTokens ?? 0,
                outputTokens: usage.outputTokens ?? 0,
                totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
                requests: 1,
            },
        };
    }

    async #executeTool(
        call: AgentToolCall,
        tools: Map<string, AgentTool>,
        step: number,
        signal: AbortSignal,
    ): Promise<AgentToolResultEntry> {
        const started = performance.now();
        const entry: AgentToolResultEntry = { id: call.id, name: call.name, args: call.args, durationMs: 0 };
        const done = (): AgentToolResultEntry => {
            entry.durationMs = Math.round((performance.now() - started) * 100) / 100;
            return entry;
        };

        const tool = tools.get(call.name);
        if (!tool) {
            entry.error = `Unknown tool '${call.name}'`;
            return done();
        }

        const { value, error } = await validateWithSchema(tool.inputSchema, call.args);
        if (error) {
            entry.error = `Invalid arguments for tool '${call.name}': ${error}`;
            return done();
        }

        const ctx: AgentToolContext = {
            rest: this.#rest,
            agent: this,
            tenant: this._tenant_,
            toolCallId: call.id,
            step,
            signal,
            error: fn.error,
        };

        try {
            entry.result = tool.execute
                ? await tool.execute(value, ctx)
                // MCP tools take the framework's own context shape
                : await tool.exec!({ ...ctx, args: value, c: (this.#rest as any)?.c });
            return done();
        } catch (err: any) {
            entry.error = err?.message ?? String(err);
            return done();
        }
    }

    async #run<T>(run: RunOptions): Promise<AgentGenerateResult<T>> {
        const { input, call, streaming, controller } = run;
        const emit = run.emit;

        const tools = this.#collectTools(call.tools);
        const provider = this.#provider(call.provider);
        const adapter = resolveProvider(provider);

        const structured = call.structuredOutput ?? (call.schema ? { schema: call.schema } : undefined);
        const schema = structured?.schema;
        const jsonSchema = schema ? await toJsonSchema(schema) : undefined;

        // `memory: { thread, resource }` (the Mastra-style shorthand) wins over the
        // flat `thread` / `resource` options — both name the same thing, and the
        // `…Id` spellings are still read as aliases.
        const thread = call.memory?.thread ?? call.memory?.threadId ?? call.thread ?? call.threadId;
        const resource = call.memory?.resource ?? call.memory?.resourceId ?? call.resource ?? call.resourceId;
        const signal = call.signal ? AbortSignal.any([call.signal, controller.signal]) : controller.signal;

        const history = thread && this.#config.memory
            ? [...(await this.#config.memory.get(thread, this.#memoryCtx(resource)))]
            : [];

        // What the caller wants the run to **know**: injected after the thread
        // history and before the question, and saved with the rest of the
        // conversation. A trailing assistant turn is legitimate ("continue from
        // here"), so the block is not forced to end on a user turn.
        const injected = call.messages ? await normalizeMessages(call.messages) : [];

        // What this run **adds to the thread** — the injected turns and the input,
        // with the attachments on the turn being asked. The history window and the
        // `load` processors only shape the prompt: neither reaches the store.
        const additions: AgentMessage[] = [...injected, ...(await normalizeMessages(input))];

        // Attachments of this run — read now, attached to the turn being asked
        if (call.files) {
            const parts = await resolveAttachments(call.files, { baseDir: call.filesBaseDir });
            if (parts.length) attachToTurn(additions, parts);
        }

        // The history window: the thread is what the store keeps, the window is what
        // the prompt replays (a cheap bound on the prompt)
        const window = call.lastMessages ?? this.#config.lastMessages;
        const replay = window && window > 0 ? trimMessages(history, window) : history;

        const memoryCtx = this.#memoryCtx(resource);
        let messages: AgentMessage[] = [...replay, ...additions];

        // Memory processors, `load` side: they see exactly what the model will see
        // (history, injected turns, input and attachments included)
        messages = await applyProcessors(this.#config.processors, "load", messages, memoryCtx);

        let system = call.instructions ?? await this.resolveInstructions({ thread, resource });

        // The scratchpad is part of the prompt, right after the instructions
        const stateKey = this.#workingMemoryKey({ thread, resource });
        const working = this.#config.workingMemory;
        if (working && stateKey && typeof this.#config.memory?.getState === "function") {
            const state = await this.#config.memory.getState(stateKey, memoryCtx);
            system += `\n\n${workingMemoryBlock(working, state?.value)}`;
        }

        if (jsonSchema) system += structuredSuffix(jsonSchema);

        const maxSteps = call.maxSteps ?? this.#config.maxSteps ?? DEFAULT_MAX_STEPS;
        // Reasoning defaults to the declaration, like `toolChoice` — a per-call
        // `thinking` wins, and `false` turns it off for one run
        const thinking = call.thinking ?? this.#config.thinking;
        const steps: AgentStep[] = [];
        const allToolCalls: AgentToolCall[] = [];
        const allToolResults: AgentToolResultEntry[] = [];
        let usage: AgentUsage = { ...EMPTY_USAGE };
        let text = "";
        let reasoning = "";
        let finishReason = "stop";

        // What the model may use, and how — the framework picks no tool itself
        const toolChoice = call.toolChoice ?? this.#config.toolChoice ?? "auto";

        // The working-memory tool is part of the run's toolbox: it disappears with
        // `tools: false` and with an allow-list, and a tool the tenant declared under
        // the same id wins (nothing is overridden behind their back)
        const narrowed = Array.isArray(call.tools) || call.tools === false;
        if (working && stateKey && working.tool !== false && !call.memory?.readOnly && !narrowed && !tools.has(WORKING_MEMORY_TOOL)) {
            tools.set(WORKING_MEMORY_TOOL, await this.#workingMemoryTool(stateKey, memoryCtx));
        }

        const specs = await this.#toolSpecs(tools);
        const offeredIds = [...tools.keys()];

        try {
            for (let step = 0; step < maxSteps; step++) {
                if (signal.aborted) {
                    finishReason = "aborted";
                    break;
                }

                const request: ModelChatRequest = {
                    system,
                    messages,
                    tools: specs.length ? specs : undefined,
                    toolChoice,
                    thinking,
                    signal,
                    json: !!schema,
                };

                const turn = streaming && emit
                    ? await this.#chatStream(adapter, request, emit)
                    : await this.#chat(adapter, request);

                usage = addUsage(usage, turn.usage);
                text = turn.text;
                if (turn.reasoning) reasoning = [reasoning, turn.reasoning].filter(Boolean).join("\n\n");

                const current: AgentStep = {
                    step,
                    text: turn.text,
                    ...(turn.reasoning ? { reasoning: turn.reasoning } : {}),
                    ...(offeredIds.length ? { tools: offeredIds } : {}),
                    toolCalls: turn.toolCalls,
                    toolResults: [],
                    finishReason: turn.finishReason,
                };

                // The assistant turn is always echoed into the conversation — it
                // carries the tool call ids the results are attached to, and it is
                // what a memory replays on the next call.
                const assistantTurn: AgentMessage = {
                    role: "assistant",
                    content: turn.text || null,
                    ...(turn.toolCalls.length ? { toolCalls: turn.toolCalls } : {}),
                    ...(turn.thinking?.length ? { thinking: turn.thinking } : {}),
                };
                messages.push(assistantTurn);
                additions.push({ ...assistantTurn });
                allToolCalls.push(...turn.toolCalls);

                if (!turn.toolCalls.length) {
                    finishReason = turn.finishReason;
                    steps.push(current);
                    await call.onStepFinish?.(current);
                    break;
                }

                for (const toolCall of turn.toolCalls) {
                    const result = await this.#executeTool(toolCall, tools, step, signal);
                    current.toolResults.push(result);
                    allToolResults.push(result);
                    const toolTurn: AgentMessage = {
                        role: "tool",
                        toolCallId: toolCall.id,
                        name: toolCall.name,
                        content: serializeToolResult(result),
                        isError: !!result.error,
                    };
                    messages.push(toolTurn);
                    additions.push({ ...toolTurn });
                    emit?.({ type: "tool_result", toolResult: result });
                }

                steps.push(current);
                await call.onStepFinish?.(current);
                emit?.({ type: "step", step: current });
                finishReason = turn.finishReason;
                if (step === maxSteps - 1) finishReason = "max_steps";
            }
        } catch (err: any) {
            if (signal.aborted) {
                finishReason = "aborted";
            } else {
                throw err;
            }
        }

        // Structured output — one repair turn, then give up with a stable code.
        let object: T | undefined;
        if (schema) {
            const attempt = extractJson(text);
            let candidate: any = attempt.value;
            let failure = attempt.error;
            if (!failure) {
                const validated = await validateWithSchema(schema, candidate);
                if (validated.error) failure = validated.error;
                else candidate = validated.value;
            }

            if (failure && text.trim()) {
                // One repair turn — `messages` already ends with the rejected answer.
                const repair = [...messages, {
                    role: "user" as const,
                    content: `That answer was rejected: ${failure}. Reply with a single valid JSON object matching the schema — no markdown, no commentary.`,
                }];
                const turn = await this.#chat(adapter, {
                    system,
                    messages: repair,
                    temperature: 0,
                    signal,
                    json: true,
                });

                usage = addUsage(usage, turn.usage);
                text = turn.text;
                messages.push({ role: "assistant", content: text });
                additions.push({ role: "assistant", content: text });

                const retry = extractJson(text);
                failure = retry.error;
                if (!failure) {
                    const validated = await validateWithSchema(schema, retry.value);
                    if (validated.error) failure = validated.error;
                    else candidate = validated.value;
                }
            }

            if (failure) {
                throw new AppError(`Agent '${this.#config.id ?? "?"}' did not return valid structured output: ${failure}`, {
                    status: 502,
                    code: "AGENT_OUTPUT_INVALID",
                    reason: text,
                });
            }
            object = candidate as T;
        }

        if (thread && this.#config.memory && !call.memory?.readOnly) {
            try {
                // `save` processors run last: they see what the run produced, and a
                // throw keeps the whole conversation out of the store (a guardrail)
                const stored = await applyProcessors(
                    this.#config.processors,
                    "save",
                    [...history, ...additions], // the whole thread — never the window
                    memoryCtx,
                );
                await this.#config.memory.save(thread, lightenForMemory(stored), memoryCtx);
            } catch (err: any) {
                console.error(`The conversation of thread '${thread}' was not saved: ${err?.message}`);
            }
        }

        return {
            text,
            ...(object !== undefined ? { object } : {}),
            ...(reasoning ? { reasoning } : {}),
            toolCalls: allToolCalls,
            toolResults: allToolResults,
            steps,
            usage,
            finishReason,
            messages: [...history, ...additions],
        };
    }
}

/**
 * Declares an agent — the object is the config; the loader instantiates it.
 * (Also available as `define.Agent`.)
 */
function agent(config: AgentConfig): AgentConfig & { _isAgent_: true } {
    return { ...config, enabled: config.enabled ?? true, _isAgent_: true };
}

export { Agent, agent };
