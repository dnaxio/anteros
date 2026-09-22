import { AppError, fn } from "./error";
import { toJsonSchema, validateWithSchema } from "./jsonSchema";
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
    AgentMemory,
    AgentMessage,
    AgentOptions,
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
 * // anywhere you have `rest`
 * const { text } = await rest.agents.get('weather')!.generate('Weather in Paris?')
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

/** Normalize `AgentTools` (record or array) into entries. */
function toolEntries(tools: AgentTools): Array<[string, AgentTool]> {
    if (Array.isArray(tools)) {
        return tools.map((tool) => {
            const name = tool.name ?? tool.id;
            if (!name) {
                throw new AppError("An agent tool declared as an array must carry a `name`", {
                    status: 500,
                    code: "AGENT_TOOL_INVALID",
                });
            }
            return [name, tool];
        });
    }
    return Object.entries(tools);
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

/**
 * What the model reads back after a tool ran: a string. A raw value is
 * JSON-serialized, an MCP `{ content: [...] }` result is flattened to its text.
 */
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

function normalizeInput(input: AgentInput): AgentMessage[] {
    if (typeof input === "string") return [{ role: "user", content: input }];
    if (Array.isArray(input)) return input;
    return [input];
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

/**
 * In-process conversation store — the default when an agent declares no
 * `memory`. One `Map` per process, so a multi-process deployment (`reusePort`)
 * should provide a shared implementation instead.
 */
export class InMemoryAgentMemory implements AgentMemory {
    #threads = new Map<string, AgentMessage[]>();

    get(threadId: string): AgentMessage[] {
        return (this.#threads.get(threadId) ?? []).map((message) => ({ ...message }));
    }

    save(threadId: string, messages: AgentMessage[]): void {
        this.#threads.set(threadId, messages.map((message) => ({ ...message })));
    }

    clear(threadId: string): void {
        this.#threads.delete(threadId);
    }

    /** Thread ids currently held in memory. */
    threads(): string[] {
        return [...this.#threads.keys()];
    }
}

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
        if (!config.provider?.model) {
            throw new AppError(`Agent '${config.id ?? "?"}' requires \`provider.model\``, { status: 500, code: "AGENT_INVALID" });
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
    async resolveInstructions(ctx: { threadId?: string; resourceId?: string } = {}): Promise<string> {
        const raw = this.#config.instructions;
        if (typeof raw === "function") {
            return (await raw({ agent: this, rest: this.#rest, ...ctx })) ?? "";
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

    /** Add or replace one tool (the key is the name the model sees). */
    addTool(tool: AgentTool, name?: string): this {
        const key = name ?? tool.name ?? tool.id;
        if (!key) {
            throw new AppError("`addTool` requires a name (or `tool.name`)", { status: 500, code: "AGENT_TOOL_INVALID" });
        }
        requireHandler(key, tool);
        this.#tools.set(key, tool);
        return this;
    }

    removeTool(name: string): boolean {
        return this.#tools.delete(name);
    }

    // ── Memory ───────────────────────────────────────────────────────────

    getMemory(): AgentMemory | undefined {
        return this.#config.memory;
    }

    setMemory(memory?: AgentMemory): this {
        this.#config.memory = memory;
        return this;
    }

    /** The stored conversation of a thread (`[]` when there is no memory). */
    async getMessages(threadId: string): Promise<AgentMessage[]> {
        if (!this.#config.memory) return [];
        return [...(await this.#config.memory.get(threadId))];
    }

    async clearMessages(threadId: string): Promise<void> {
        await this.#config.memory?.clear(threadId);
    }

    /** Forget a thread — or the whole in-process memory when no thread is given. */
    async reset(threadId?: string): Promise<void> {
        if (threadId) return this.clearMessages(threadId);
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
        const object = deferred<T | undefined>();
        const toolCalls = deferred<AgentToolCall[]>();
        const toolResults = deferred<AgentToolResultEntry[]>();
        const steps = deferred<AgentStep[]>();
        const usage = deferred<AgentUsage>();
        const finishReason = deferred<string>();
        const messages = deferred<AgentMessage[]>();

        // The caller may only consume `textStream` — a rejected promise nobody
        // awaits must not become an unhandled rejection.
        for (const pending of [text, object, toolCalls, toolResults, steps, usage, finishReason, messages]) {
            pending.promise.catch(() => {});
        }

        void (async () => {
            try {
                const result = await this.#run<T>({ input, call: options, streaming: true, controller, emit });
                text.resolve(result.text);
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
                for (const pending of [text, object, toolCalls, toolResults, steps, usage, finishReason, messages]) {
                    pending.reject(err);
                }
                textQueue.fail(err);
                fullQueue.fail(err);
            }
        })();

        return {
            textStream: textQueue,
            fullStream: fullQueue,
            text: text.promise,
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

    #collectTools(extra?: AgentTools): Map<string, AgentTool> {
        const tools = new Map(this.#tools);
        if (extra) {
            for (const [name, tool] of toolEntries(extra)) {
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
        toolCalls: AgentToolCall[];
        finishReason: string;
        usage: AgentUsage;
    }> {
        const response = await adapter.chat(request);
        return {
            text: response.text,
            toolCalls: response.toolCalls.map(toToolCall),
            finishReason: response.finishReason,
            usage: response.usage,
        };
    }

    /** One model call, streaming — the deltas are reassembled into a full turn. */
    async #chatStream(adapter: ModelAdapter, request: ModelChatRequest, emit: (chunk: AgentStreamChunk) => void): Promise<{
        text: string;
        toolCalls: AgentToolCall[];
        finishReason: string;
        usage: AgentUsage;
    }> {
        const partial = new Map<number, { id?: string; name?: string; argsText?: string }>();
        let text = "";
        let finishReason = "stop";
        let usage: Partial<AgentUsage> = {};

        for await (const event of adapter.chatStream(request)) {
            switch (event.type) {
                case "text":
                    text += event.text;
                    emit({ type: "text", text: event.text });
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
        const specs = await this.#toolSpecs(tools);
        const provider = this.#provider(call.provider);
        const adapter = resolveProvider(provider);

        const structured = call.structuredOutput ?? (call.schema ? { schema: call.schema } : undefined);
        const schema = structured?.schema;
        const jsonSchema = schema ? await toJsonSchema(schema) : undefined;

        const threadId = call.memory?.threadId ?? call.threadId;
        const signal = call.signal ? AbortSignal.any([call.signal, controller.signal]) : controller.signal;

        const history = threadId ? await this.getMessages(threadId) : [];
        const messages: AgentMessage[] = [...history, ...normalizeInput(input)];

        let system = call.instructions ?? await this.resolveInstructions({ threadId, resourceId: call.resourceId });
        if (jsonSchema) system += structuredSuffix(jsonSchema);

        const maxSteps = call.maxSteps ?? this.#config.maxSteps ?? DEFAULT_MAX_STEPS;
        const steps: AgentStep[] = [];
        const allToolCalls: AgentToolCall[] = [];
        const allToolResults: AgentToolResultEntry[] = [];
        let usage: AgentUsage = { ...EMPTY_USAGE };
        let text = "";
        let finishReason = "stop";

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
                    signal,
                    json: !!schema,
                };

                const turn = streaming && emit
                    ? await this.#chatStream(adapter, request, emit)
                    : await this.#chat(adapter, request);

                usage = addUsage(usage, turn.usage);
                text = turn.text;

                const current: AgentStep = {
                    step,
                    text: turn.text,
                    toolCalls: turn.toolCalls,
                    toolResults: [],
                    finishReason: turn.finishReason,
                };

                // The assistant turn is always echoed into the conversation — it
                // carries the tool call ids the results are attached to, and it is
                // what a memory replays on the next call.
                messages.push({
                    role: "assistant",
                    content: turn.text || null,
                    ...(turn.toolCalls.length ? { toolCalls: turn.toolCalls } : {}),
                });
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
                    messages.push({
                        role: "tool",
                        toolCallId: toolCall.id,
                        name: toolCall.name,
                        content: serializeToolResult(result),
                        isError: !!result.error,
                    });
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

        if (threadId && this.#config.memory && !call.memory?.readOnly) {
            try {
                await this.#config.memory.save(threadId, messages);
            } catch (err: any) {
                console.error(`Failed to save the agent memory of thread '${threadId}': ${err?.message}`);
            }
        }

        return {
            text,
            ...(object !== undefined ? { object } : {}),
            toolCalls: allToolCalls,
            toolResults: allToolResults,
            steps,
            usage,
            finishReason,
            messages,
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
