import { AppError, fn } from "./error";
import { DEFAULT_REDACT_KEYS, isSensitiveKey, redactKeys } from "./redact";
import { toJsonSchema, validateWithSchema } from "./jsonSchema";
import { InMemoryAgentMemory, trimMessages } from "./agentMemory";
import { forMemory, resolveAttachments } from "./attachment";
import { normalizeMessages, serializeToolResult, toolResultMedia } from "./messages";
import { mcpToolsFor } from "./mcpClient";
import { parsePartialJson } from "./partialJson";
import { skillsBlock } from "./skills";
import { trace } from "./tracing";
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
    AgentPendingApproval,
    AgentRunState,
    AgentRunStore,
    AgentSkill,
    AgentTextPart,
    AgentThinkingBlock,
    AgentThread,
    AgentProvider,
    AgentStreamChunk,
    AgentStreamObjectResult,
    AgentStreamResult,
    AgentStep,
    AgentStructuredOutput,
    AgentTool,
    AgentToolCall,
    AgentToolContext,
    AgentToolMessage,
    AgentToolResultEntry,
    AgentGuardrail,
    AgentGuardrailContext,
    AgentPricing,
    AgentToolStats,
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
 * The provider is declared inline — `{ model, apiKey, protocol }` — with no
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
    const cost = (base.cost ?? 0) + (next.cost ?? 0);
    return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        requests: base.requests + (next.requests ?? 0),
        ...(cost ? { cost } : {}),
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

/**
 * The object of a running answer — `undefined` until the text parses, a partial
 * parse after that. It **drains** the run's text: a caller picks
 * `partialObjectStream` **or** `textStream`, never both.
 */
async function* partialObjects<T>(text: AsyncIterable<string>): AsyncIterable<T | undefined> {
    let buffer = "";
    for await (const token of text) {
        buffer += token;
        yield parsePartialJson(buffer) as T | undefined;
    }
}

// ─── Default memory ──────────────────────────────────────────────────────
// The stores live in `lib/agentMemory.ts` (`agents.memory.InMemory` / `.Mongo`).

export { InMemoryAgentMemory };

// ─── The agent ───────────────────────────────────────────────────────────

/**
 * Give up on a tool after `ms` — the promise is abandoned, not cancelled: a tool
 * that must really stop has to watch `ctx.signal` (which carries the same deadline).
 */
async function withTimeout<T>(work: Promise<T>, ms: number, name: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new AppError(
                        `Tool '${name}' timed out after ${ms}ms`,
                        { status: 504, code: "AGENT_TOOL_TIMEOUT" },
                    )),
                    ms,
                );
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Run `work` over `items` with at most `limit` in flight, preserving order. */
async function mapLimited<T, R>(items: T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            const index = next++;
            if (index >= items.length) return;
            out[index] = await work(items[index]!, index);
        }
    });
    await Promise.all(workers);
    return out;
}

/** A prompt budget is an order of magnitude: 4 chars ≈ 1 token, no tokenizer dependency. */
function estimateTokens(message: AgentMessage): number {
    const content = (message as any).content;
    const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
    return Math.ceil((text?.length ?? 0) / 4) + 4;
}

/** Drop the oldest turns until the prompt fits `budget`; the last turn always stays. */
function trimToTokens(messages: AgentMessage[], budget: number): AgentMessage[] {
    let total = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
    let start = 0;
    while (total > budget && start < messages.length - 1) {
        total -= estimateTokens(messages[start]!);
        start += 1;
    }
    return start ? messages.slice(start) : messages;
}

/** The text a guardrail reads — a message's text parts joined. */
function messageText(message: AgentMessage | undefined): string {
    if (!message) return "";
    const content = (message as any).content;
    if (typeof content === "string") return content;
    return (content ?? [])
        .filter((part: any) => part?.type === "text")
        .map((part: any) => part.text)
        .join("\n");
}

/**
 * Run one side of the guardrails. A check that throws **blocks the run** with
 * `AGENT_GUARDRAIL_BLOCKED`, naming the guardrail and carrying its own code.
 */
async function runGuardrails(
    list: AgentGuardrail[] | undefined,
    value: string,
    ctx: AgentGuardrailContext,
    kind: "prompt" | "answer",
): Promise<void> {
    for (const guardrail of list ?? []) {
        try {
            await guardrail.check(value, ctx);
        } catch (err: any) {
            throw new AppError(
                `Guardrail '${guardrail.name}' blocked the ${kind}: ${err?.message ?? err}`,
                { status: 400, code: "AGENT_GUARDRAIL_BLOCKED", reason: err?.code ? String(err.code) : undefined },
            );
        }
    }
}

/**
 * Check a **successful** tool result before the model reads it. A guardrail that
 * throws blocks **that result only**: it becomes an error the model sees
 * (`AGENT_GUARDRAIL_BLOCKED`), and the run goes on — a tool result is a turn of
 * the conversation, not the answer. A failed result is not checked.
 */
async function guardToolResult(
    entry: AgentToolResultEntry,
    list: AgentGuardrail[],
    ctx: AgentGuardrailContext,
): Promise<void> {
    if (entry.error || !list.length) return;

    const value = serializeToolResult(entry);
    const toolCtx: AgentGuardrailContext = { ...ctx, tool: entry.name, toolCallId: entry.id };

    for (const guardrail of list) {
        try {
            await guardrail.check(value, toolCtx);
        } catch (err: any) {
            entry.error = `Guardrail '${guardrail.name}' blocked the tool result: ${err?.message ?? err}`;
            entry.errorCode = "AGENT_GUARDRAIL_BLOCKED";
            delete entry.result;
            return;
        }
    }
}

/** What a model call cost, in USD, from its token usage. */
function costOf(usage: AgentUsage, pricing: AgentPricing): number {
    return (usage.inputTokens / 1_000_000) * pricing.input + (usage.outputTokens / 1_000_000) * pricing.output;
}

/** Whether another endpoint may answer — 429, 5xx, network, timeout; never a 4xx. */
function worthFallback(err: any): boolean {
    // The adapter reports the provider's own status under `reason.status`: a 400 from
    // the upstream endpoint is the request's fault, and another model would fail too.
    const providerStatus = Number(err?.reason?.status ?? 0);
    if (providerStatus) return providerStatus === 429 || providerStatus >= 500;

    const status = Number(err?.status ?? 0);
    if (status === 429 || status === 504 || status >= 500) return true;
    if (status) return false;

    const text = String(err?.message ?? err);
    return /network|fetch failed|timed out|timeout|ECONN|socket|ENOTFOUND|EAI_AGAIN/i.test(text);
}

/** Fold one tool result into the run's aggregate (`result.toolStats`). */
function recordToolStats(stats: AgentToolStats, entry: AgentToolResultEntry): void {
    stats.calls += 1;
    stats.durationMs += entry.durationMs;
    if (!entry.error) return;
    stats.errors += 1;
    const code = entry.errorCode ?? "AGENT_TOOL_FAILED";
    stats.byCode[code] = (stats.byCode[code] ?? 0) + 1;
    if (code === "AGENT_TOOL_TIMEOUT") stats.timeouts += 1;
}

/** Fold a delegated run's stats into its parent's — the calls are the caller's too. */
function mergeToolStats(base: AgentToolStats, next: AgentToolStats): void {
    base.calls += next.calls;
    base.errors += next.errors;
    base.timeouts += next.timeouts;
    base.durationMs += next.durationMs;
    for (const [code, count] of Object.entries(next.byCode)) {
        base.byCode[code] = (base.byCode[code] ?? 0) + count;
    }
}

/**
 * The tool calls the conversation has not answered yet — the ones of its last
 * assistant turn that carries calls, minus the `tool` turns that follow. That is
 * exactly what a paused run left behind, and what a resume has to resolve.
 */
function unansweredToolCalls(messages: AgentMessage[]): AgentToolCall[] {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]!;
        if (message.role !== "assistant" || !message.toolCalls?.length) continue;
        const answered = new Set(
            messages.slice(index + 1)
                .filter((turn): turn is AgentToolMessage => turn.role === "tool" && !!turn.toolCallId)
                .map((turn) => turn.toolCallId),
        );
        return message.toolCalls.filter((call) => !answered.has(call.id));
    }
    return [];
}

/** The `tool` turn a result becomes in the conversation — one shape, one place. */
function toolTurnFor(result: AgentToolResultEntry): AgentMessage {
    const media = toolResultMedia(result);
    if (!media.length) {
        return {
            role: "tool",
            toolCallId: result.id,
            name: result.name,
            content: serializeToolResult(result),
            isError: !!result.error,
        };
    }
    // Media travels **beside** the text: Anthropic accepts image/document blocks in a
    // `tool_result`; a text-only protocol gets the marker `serializeToolResult` built.
    const text = serializeToolResult(result);
    const content: any[] = text ? [{ type: "text", text }] : [];
    content.push(...media);
    return {
        role: "tool",
        toolCallId: result.id,
        name: result.name,
        content,
        isError: !!result.error,
    };
}

/**
 * The agents another agent may call, **exposed as tools** — the model decides when
 * to delegate, exactly like any other tool.
 *
 * The sub-agent is built per call, bound to the **calling** `rest`: its own tools then
 * run with the right tenant, session and transaction.
 */
/** What a delegated run must inherit from its parent. */
type Delegation = {
    signal?: AbortSignal;
    maxSteps?: number;
    /**
     * The parent's `emit`, set when the parent **streams**: the child then streams
     * too, and every one of its chunks is re-emitted wrapped as `subagent`.
     */
    emit?: (chunk: AgentStreamChunk) => void;
    /** Folds the child's usage and tool stats into the parent's. */
    onResult?: (result: { usage: AgentUsage; toolStats: AgentToolStats }) => void;
};

function subAgentTools(
    declared: AgentConfig | AgentConfig[] | undefined,
    rest: InstanceType<typeof useRest> | undefined,
    tenant: string | undefined,
    delegation?: Delegation,
): Array<[string, AgentTool]> {
    const definitions = !declared ? [] : Array.isArray(declared) ? declared : [declared];
    const out: Array<[string, AgentTool]> = [];

    for (const definition of definitions) {
        const id = definition?.id;
        if (!id || out.some(([name]) => name === id)) continue;

        out.push([id, {
            id,
            description: definition.description ?? `Delegate to the '${id}' agent.`,
            inputSchema: {
                type: "object",
                properties: {
                    input: { type: "string", description: "What to ask the agent." },
                    thread: { type: "string", description: "Its memory thread, when the agent has a memory." },
                    resource: { type: "string", description: "Its caller identity, when the agent has a memory." },
                },
                required: ["input"],
                additionalProperties: false,
            },
            execute: async ({ input, thread, resource }: any, ctx) => {
                if (!definition.description) {
                    throw ctx.error(`Agent '${id}' has no description — it cannot be delegated to`, {
                        status: 500, code: "AGENT_DELEGATION_INVALID",
                    });
                }
                const sub = new Agent(definition, { rest, tenant });
                // The parent's lifetime is the child's: an aborted run must not
                // leave a delegated model call running in the background
                const inherited = {
                    thread,
                    resource,
                    ...(delegation?.signal ? { signal: delegation.signal } : {}),
                    ...(delegation?.maxSteps ? { maxSteps: delegation.maxSteps } : {}),
                };

                // A streaming parent gets a streaming child: the answer is still the
                // tool result, it simply arrives as it is produced too
                if (delegation?.emit) {
                    const run = sub.stream(input, inherited);
                    for await (const chunk of run.fullStream) {
                        delegation.emit({ type: "subagent", name: id, chunk });
                    }
                    const [text, finishReason, usage, stats] = await Promise.all([
                        run.text,
                        run.finishReason,
                        run.usage,
                        run.toolStats,
                    ]);
                    delegation.onResult?.({ usage, toolStats: stats });
                    // A step is all-or-nothing: a child that paused for a decision
                    // cannot be resumed through a tool result
                    if (finishReason === "approval_required") {
                        throw ctx.error(
                            `Sub-agent '${id}' paused for approval — delegation cannot carry a decision; call it directly`,
                            { status: 409, code: "AGENT_APPROVAL_IN_DELEGATION" },
                        );
                    }
                    return text;
                }

                const answer = await sub.generate(input, inherited);
                delegation?.onResult?.({ usage: answer.usage, toolStats: answer.toolStats });
                // A step is all-or-nothing: a child that paused for a decision cannot
                // be resumed through a tool result — say so instead of losing the call
                if (answer.pendingApprovals?.length) {
                    throw ctx.error(
                        `Sub-agent '${id}' paused for approval (${answer.pendingApprovals.map((approval) => approval.name).join(", ")}) — delegation cannot carry a decision; call it directly`,
                        { status: 409, code: "AGENT_APPROVAL_IN_DELEGATION" },
                    );
                }
                return answer.text;
            },
        }]);
    }

    return out;
}

type RunOptions = {
    input: AgentInput;
    call: AgentCallOptions;
    streaming: boolean;
    controller: AbortController;
    emit?: (chunk: AgentStreamChunk) => void;
    /** The stored state a `resumeRun()` continues — its conversation and counters. */
    resumeState?: AgentRunState;
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

    /** The provider as declared — the API key **and sensitive headers** are not included. */
    getProvider(): AgentProvider {
        const { apiKey, headers, ...rest } = this.#config.provider;
        const keys = redactKeys() ?? new Set(DEFAULT_REDACT_KEYS.map((key) => key.toLowerCase()));
        const safeHeaders = headers
            ? Object.fromEntries(Object.entries(headers).filter(([name]) => !isSensitiveKey(name, keys)))
            : undefined;
        return {
            ...rest,
            ...(safeHeaders && Object.keys(safeHeaders).length ? { headers: safeHeaders } : {}),
            options: { ...this.#config.provider.options },
        };
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

    // ── Skills ───────────────────────────────────────────────────────────

    /**
     * The resolved skills, in prompt order (by name). Read-only: they are resolved
     * once at load, from the files `skills` points at — a run reads no file.
     */
    getSkills(): AgentSkill[] {
        return this.#config._skills_ ?? [];
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
    #memoryCtx(resourceId?: string, threadId?: string): AgentMemoryContext {
        return {
            agentId: this.#config.id,
            tenant: this._tenant_,
            rest: this.#rest,
            resourceId,
            // The store and the thread are on the **run** context only: that is what a
            // processor needs to cache something per thread
            ...(threadId ? { thread: threadId } : {}),
            ...(this.#config.memory ? { memory: this.#config.memory } : {}),
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
        // `protocol` is canonical: the deprecated `compatible` alias is normalized
        // away here, so the API, the SDK and the audit only ever see one field.
        const { compatible, ...provider } = this.getProvider();
        return {
            id: this.#config.id,
            name: this.getName(),
            /** What this prompt is — the version an audit entry carries. */
            version: this.#config.version,
            description: this.#config.description,
            tenant: this._tenant_,
            provider: { ...provider, protocol: this.#config.provider.protocol ?? compatible ?? "openai" },
            instructions: typeof this.#config.instructions === "string" ? this.#config.instructions : "[dynamic]",
            tools: [...this.#tools.keys()],
            skills: this.getSkills().map((skill) => ({ name: skill.name, description: skill.description })),
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
     * Continue a run that a crash, a restart or a provider failure interrupted —
     * from its **last completed step**, without paying for the conversation again.
     *
     * ```ts
     * const answer = await agent.resumeRun('run-42'); // 1 model call, not the whole loop
     * ```
     *
     * The store is the call's `checkpoint`, then the agent's. The resumed run keeps
     * the same `runId` and store, so its next steps are saved too and its success
     * clears the state. Completed steps are never replayed through the model: a
     * checkpoint sits on a step boundary, and the tool results of the last completed
     * step are already part of the stored conversation — the model is asked for the
     * **next** step only.
     */
    async resumeRun<T = any>(runId: string, options: AgentCallOptions = {}): Promise<AgentGenerateResult<T>> {
        const store = options.checkpoint ?? this.#config.checkpoint;
        if (!store) {
            throw new AppError(
                `Agent '${this.getId() ?? "?"}' cannot resume run '${runId}': no \`checkpoint\` store`,
                { status: 400, code: "AGENT_CHECKPOINT_REQUIRED" },
            );
        }

        const state = await store.load(runId);
        if (!state) {
            throw new AppError(`No checkpoint is stored for run '${runId}'`, {
                status: 404,
                code: "AGENT_CHECKPOINT_NOT_FOUND",
            });
        }

        // The conversation comes from the state — the input is inert, and so are the
        // injected turns, the attachments and a paused-run resume of the call
        const call: AgentCallOptions = { ...options, runId, checkpoint: store };
        delete call.resume;
        delete call.messages;
        delete call.files;

        return this.#run<T>({
            input: "",
            call,
            streaming: false,
            controller: new AbortController(),
            resumeState: state,
        });
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
        const toolStats = deferred<AgentToolStats>();
        const modelUsed = deferred<string | undefined>();
        const budgetHit = deferred<{ limit: "tokens" | "cost" | "duration"; value: number } | undefined>();
        const steps = deferred<AgentStep[]>();
        const usage = deferred<AgentUsage>();
        const finishReason = deferred<string>();
        const messages = deferred<AgentMessage[]>();

        const deferreds = [text, reasoning, object, toolCalls, toolResults, toolStats, modelUsed, budgetHit, steps, usage, finishReason, messages];

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
                toolStats.resolve(result.toolStats);
                modelUsed.resolve(result.model);
                budgetHit.resolve(result.budget);
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
            toolStats: toolStats.promise,
            model: modelUsed.promise,
            budget: budgetHit.promise,
            steps: steps.promise,
            usage: usage.promise,
            finishReason: finishReason.promise,
            messages: messages.promise,
            abort: (reason?: string) => controller.abort(reason),
        };
    }

    /**
     * Stream the answer into a typed object — `stream()` bounded to a schema.
     *
     * Every member of `stream()` is there (`text`, `object`, `usage`,
     * `fullStream`, `abort`…), plus `partialObjectStream`, which yields a
     * **best-effort** parse of the answer so far (`undefined` until the partial
     * JSON parses). The final object is still parsed and validated at the end:
     * `await result.object` is the one to trust.
     *
     * ```ts
     * const run = agent.streamObject('List 3 cities', { schema });
     * for await (const partial of run.partialObjectStream) {
     *   if (partial) render(partial);
     * }
     * ```
     *
     * `partialObjectStream` consumes the run's text: choose it **or**
     * `textStream`, not both.
     */
    streamObject<T = any>(input: AgentInput, options: AgentCallOptions = {}): AgentStreamObjectResult<T> {
        if (!options.schema && !options.structuredOutput) {
            throw new AppError("`streamObject` requires a `schema` (or `structuredOutput`)", {
                status: 500,
                code: "AGENT_SCHEMA_REQUIRED",
            });
        }
        const run = this.stream<T>(input, options);
        return { ...run, partialObjectStream: partialObjects<T>(run.textStream) };
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

    /** The primary provider, then its fallbacks, each with its options merged in. */
    #providerChain(override?: Partial<AgentProvider>): AgentProvider[] {
        const primary = this.#provider(override);
        const fallbacks = primary.fallbacks ?? [];
        return [
            primary,
            ...fallbacks.map((fallback) => ({
                ...primary,
                ...fallback,
                options: { ...primary.options, ...fallback.options },
                headers: { ...primary.headers, ...fallback.headers },
                fallbacks: undefined,
            })),
        ];
    }

    /**
     * The tools of one run — `true` (all), `false` (none), an array of **names**
     * (an allow-list) or extra tools to merge in.
     *
     * The declared agents and the **remote MCP servers** are resolved here, before the
     * allow-list is applied, so every rule below treats them like any other tool.
     */
    async #collectTools(requested?: boolean | string[] | AgentTools, delegation?: Delegation): Promise<Map<string, AgentTool>> {
        // `tools: false` — the run answers directly (and no remote is even contacted)
        if (requested === false) return new Map();

        const tools = new Map(this.#tools);

        // The other agents this one may delegate to
        for (const [name, tool] of subAgentTools(this.#config.agents, this.#rest, this._tenant_, delegation)) {
            if (!tools.has(name)) tools.set(name, tool);
        }

        // The remote MCP servers — connected on the first run that needs them, and
        // memoized per server. A tool the agent declares itself wins over a remote one.
        for (const tool of await mcpToolsFor(this.#config.mcp)) {
            const name = tool.id ?? tool.name;
            if (name && !tools.has(name)) tools.set(name, tool);
        }

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
        timeoutMs?: number,
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
            entry.errorCode = "AGENT_TOOL_UNKNOWN";
            return done();
        }

        const { value, error } = await validateWithSchema(tool.inputSchema, call.args);
        if (error) {
            entry.error = `Invalid arguments for tool '${call.name}': ${error}`;
            entry.errorCode = "AGENT_TOOL_ARGS_INVALID";
            return done();
        }

        // The deadline an outbound call must respect: the run's signal **and** the
        // tool's own, so a cooperative tool can abort itself instead of being abandoned
        const timeout = tool.timeoutMs ?? timeoutMs;
        const toolSignal = timeout && timeout > 0
            ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
            : signal;

        const ctx: AgentToolContext = {
            rest: this.#rest,
            agent: this,
            tenant: this._tenant_,
            toolCallId: call.id,
            step,
            signal: toolSignal,
            error: fn.error,
        };

        try {
            const work: Promise<any> = tool.execute
                ? tool.execute(value, ctx)
                // MCP tools take the framework's own context shape
                : tool.exec!({ ...ctx, args: value, c: (this.#rest as any)?.c });

            entry.result = timeout && timeout > 0
                ? await withTimeout(work, timeout, call.name)
                : await work;
            return done();
        } catch (err: any) {
            entry.error = err?.message ?? String(err);
            entry.errorCode = err?.code ? String(err.code) : "AGENT_TOOL_FAILED";
            return done();
        }
    }

    async #run<T>(run: RunOptions): Promise<AgentGenerateResult<T>> {
        const { input, call, streaming, controller } = run;
        const emit = run.emit;
        // A `resumeRun()` continues a stored state: its conversation and counters are
        // the starting point, not the caller's input
        const resumeState = run.resumeState;

        // The run's signal comes first: the delegated agents inherit it, and the
        // tools are collected before the first model call
        const signal = call.signal ? AbortSignal.any([call.signal, controller.signal]) : controller.signal;

        // What delegated runs consume — folded into the parent's usage and stats at
        // the end. A streaming parent hands its `emit` down, so the child streams too.
        let delegatedUsage: AgentUsage = { ...EMPTY_USAGE };
        const delegatedToolStats: AgentToolStats = { calls: 0, errors: 0, byCode: {}, timeouts: 0, durationMs: 0 };
        const tools = await this.#collectTools(call.tools, {
            signal,
            maxSteps: call.maxSteps ?? this.#config.maxSteps,
            ...(emit ? { emit } : {}),
            onResult: ({ usage, toolStats: stats }) => {
                delegatedUsage = addUsage(delegatedUsage, usage);
                mergeToolStats(delegatedToolStats, stats);
            },
        });
        const chain = this.#providerChain(call.provider);
        const provider = chain[0]!;
        // A resumed segment starts from the model that answered before the restart
        let model = resumeState?.model ?? provider.model;

        const structured: AgentStructuredOutput | undefined = call.structuredOutput ?? (call.schema ? { schema: call.schema } : undefined);
        const schema = structured?.schema;
        const jsonSchema = schema ? await toJsonSchema(schema) : undefined;
        // The name a provider accepts is `[a-zA-Z0-9_-]{1,64}` — an agent id is not
        // always that (`support.billing` is not)
        const schemaName = (structured?.name ?? this.#config.id ?? "response")
            .replace(/[^a-zA-Z0-9_-]+/g, "_")
            .slice(0, 64) || "response";

        // `memory: { thread, resource }` (the Mastra-style shorthand) wins over the
        // flat `thread` / `resource` options — both name the same thing, and the
        // `…Id` spellings are still read as aliases.
        const thread = call.memory?.thread ?? call.memory?.threadId ?? call.thread ?? call.threadId;
        const resource = call.memory?.resource ?? call.memory?.resourceId ?? call.resource ?? call.resourceId;

        // Per-tool deadline and tool parallelism: the call wins over the declaration
        const toolTimeout = call.toolTimeoutMs ?? this.#config.toolTimeoutMs;
        const parallel = call.parallelTools ?? this.#config.parallelTools ?? false;
        const maxParallelToolCalls = Math.max(
            1,
            Math.trunc(call.maxParallelToolCalls ?? this.#config.maxParallelToolCalls ?? 8),
        );
        const savePartial = call.savePartial ?? this.#config.savePartial ?? false;

        // Durable checkpoint: the call's store wins over the declaration's, and both
        // the store and a run id are required — a run without identity cannot be
        // resumed, so it is not saved either
        const checkpointStore = call.checkpoint ?? this.#config.checkpoint;
        const runId = call.runId;
        const checkpointing = !!checkpointStore && !!runId;

        // Run budget — a run that reaches it stops **cleanly**, it does not throw
        const maxTokens = call.maxTokens ?? this.#config.maxTokens;
        const maxDurationMs = call.maxDurationMs ?? this.#config.maxDurationMs;
        const maxCost = call.maxCost ?? this.#config.maxCost;
        const contextTokens = call.contextTokens ?? this.#config.contextTokens;
        const startedAt = Date.now();
        let budget: { limit: "tokens" | "cost" | "duration"; value: number } | undefined;

        // Guardrails of this run: the declaration's, then the call's
        const inputGuardrails = [...(this.#config.guardrails?.input ?? []), ...(call.guardrails?.input ?? [])];
        const outputGuardrails = [...(this.#config.guardrails?.output ?? []), ...(call.guardrails?.output ?? [])];
        const toolGuardrails = [...(this.#config.guardrails?.tool ?? []), ...(call.guardrails?.tool ?? [])];

        // Resuming a paused run: the conversation is the caller's — the paused step is
        // resolved from it instead of being asked of the model again. A checkpoint
        // resume has the same shape, with the stored conversation as the whole
        // history (already shaped by the processors of the interrupted run).
        const carried = resumeState?.messages;
        const resuming = !carried && call.resume ? await normalizeMessages(call.resume.messages) : undefined;

        const history = carried ?? resuming ?? (thread && this.#config.memory
            ? [...(await this.#config.memory.get(thread, this.#memoryCtx(resource)))]
            : []);

        // What the caller wants the run to **know**: injected after the thread
        // history and before the question, and saved with the rest of the
        // conversation. A trailing assistant turn is legitimate ("continue from
        // here"), so the block is not forced to end on a user turn.
        const injected = !carried && !resuming && call.messages ? await normalizeMessages(call.messages) : [];

        // What this run **adds to the thread** — the injected turns and the input,
        // with the attachments on the turn being asked. The history window and the
        // `load` processors only shape the prompt: neither reaches the store.
        // A resumed run adds nothing: its input **is** the conversation it was given.
        const additions: AgentMessage[] = carried || resuming ? [] : [...injected, ...(await normalizeMessages(input))];

        // Attachments of this run — read now, attached to the turn being asked
        if (!carried && !resuming && call.files) {
            const parts = await resolveAttachments(call.files, { baseDir: call.filesBaseDir });
            if (parts.length) attachToTurn(additions, parts);
        }

        // The history window: the thread is what the store keeps, the window is what
        // the prompt replays (a cheap bound on the prompt). A carried conversation is
        // continued as-is — the interrupted run already applied both bounds to it.
        const window = call.lastMessages ?? this.#config.lastMessages;
        const replay = carried ?? (window && window > 0 ? trimMessages(history, window) : history);

        const memoryCtx = this.#memoryCtx(resource, thread);
        let messages: AgentMessage[] = [...replay, ...additions];

        if (!carried) {
            // Memory processors, `load` side: they see exactly what the model will
            // see (history, injected turns, input and attachments included)
            messages = await applyProcessors(this.#config.processors, "load", messages, memoryCtx);

            // The prompt budget, in tokens: the oldest turns are dropped first. It runs
            // after the processors (they may have shortened the thread) and before the
            // guardrails (which read the caller's prompt, not the window).
            if (contextTokens && contextTokens > 0) messages = trimToTokens(messages, contextTokens);
        }

        // Input guardrails — the caller's prompt, before any model call
        const guardrailCtx: AgentGuardrailContext = { agent: this, tenant: this._tenant_, thread, resource, signal };
        const lastUser = [...messages].reverse().find((message) => message.role === "user");
        await runGuardrails(inputGuardrails, messageText(lastUser), guardrailCtx, "prompt");

        // Tracing — the caller's hook (the call's wins over the declaration's). It
        // sees plain events; turning them into spans is its job, not the run's.
        const traceHook = call.onTrace ?? this.#config.onTrace;
        trace(traceHook, {
            type: "run.start",
            at: Date.now(),
            ...(this.#config.id ? { agentId: this.#config.id } : {}),
            ...(call.runId ? { runId: call.runId } : {}),
            ...(thread ? { thread } : {}),
            ...(resource ? { resource } : {}),
        });

        let system = call.instructions ?? await this.resolveInstructions({ thread, resource });

        // The skills are part of the instructions, and they never change: injected
        // **before** the working memory (which a run rewrites) so the prefix of the
        // prompt stays stable — and cacheable — across calls
        const skills = this.#config._skills_;
        if (skills?.length) system += `\n\n${skillsBlock(skills)}`;

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
        // A resumed segment carries what the run already spent — a budget sees the
        // whole run, not just the part after the restart
        const toolStats: AgentToolStats = resumeState
            ? { ...resumeState.toolStats, byCode: { ...resumeState.toolStats.byCode } }
            : { calls: 0, errors: 0, byCode: {}, timeouts: 0, durationMs: 0 };
        let usage: AgentUsage = resumeState ? { ...resumeState.usage } : { ...EMPTY_USAGE };
        let text = "";
        let reasoning = "";
        let finishReason = "stop";

        // The durable checkpoint — written at a **step boundary** only: the assistant
        // turn and every tool turn it asked for are in, so the stored conversation is
        // always valid to replay. Best-effort: a store that fails is logged, never
        // fatal — the run is worth more than its checkpoint.
        const saveCheckpoint = async (completed: number): Promise<void> => {
            if (!checkpointing) return;
            const state: AgentRunState = {
                runId: runId!,
                ...(this.#config.id ? { agentId: this.#config.id } : {}),
                step: completed,
                messages: messages.map((message) => ({ ...message })),
                usage: { ...usage },
                toolStats: { ...toolStats, byCode: { ...toolStats.byCode } },
                ...(model ? { model } : {}),
                finishReason,
                at: new Date().toISOString(),
            };
            try {
                await checkpointStore!.save(runId!, state);
            } catch (err: any) {
                console.error(`The checkpoint of run '${runId}' was not saved: ${err?.message ?? err}`);
            }
        };

        // The end of the run — traced once, on the answer or on the way out. The
        // delegated work is folded in first: it is part of what the caller pays for.
        const endRun = (reason: string, error?: unknown): void => {
            usage = addUsage(usage, delegatedUsage);
            mergeToolStats(toolStats, delegatedToolStats);
            trace(traceHook, {
                type: "run.end",
                at: Date.now(),
                finishReason: reason,
                durationMs: Date.now() - startedAt,
                usage,
                toolStats,
                ...(error !== undefined
                    ? { error: String((error as any)?.message ?? error).split("\n")[0] }
                    : {}),
            });
        };

        // One tool call, traced — the start before it runs, the end after, whichever
        // path executes it (sequential, parallel, or a resumed step)
        const runTool = async (toolCall: AgentToolCall, step: number): Promise<AgentToolResultEntry> => {
            const toolStartedAt = Date.now();
            trace(traceHook, {
                type: "tool.start",
                at: toolStartedAt,
                step,
                tool: toolCall.name,
                toolCallId: toolCall.id,
            });
            let result: AgentToolResultEntry | undefined;
            try {
                result = await this.#executeTool(toolCall, tools, step, signal, toolTimeout);
                return result;
            } finally {
                const endedAt = Date.now();
                trace(traceHook, {
                    type: "tool.end",
                    at: endedAt,
                    step,
                    tool: toolCall.name,
                    toolCallId: toolCall.id,
                    durationMs: endedAt - toolStartedAt,
                    ...(result?.errorCode ? { errorCode: result.errorCode } : {}),
                });
            }
        };

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

        // A paused run left tool calls unanswered: they are resolved here, from the
        // caller's decisions, and the loop then continues from the completed step —
        // the model is never asked again for the step it already produced
        const pending: AgentPendingApproval[] = [];
        if (resuming) {
            for (const toolCall of unansweredToolCalls(messages)) {
                const tool = tools.get(toolCall.name);
                const decision = call.resume!.decisions?.[toolCall.id];
                // Undecided: the run pauses again, and nothing runs
                if (tool?.approval && decision === undefined) {
                    pending.push({ toolCallId: toolCall.id, name: toolCall.name, args: toolCall.args });
                    continue;
                }
                const result: AgentToolResultEntry = decision === false
                    ? { id: toolCall.id, name: toolCall.name, args: toolCall.args, durationMs: 0, error: "Refused by the caller" }
                    : await runTool(toolCall, 0);
                // Checked before it enters the conversation — a blocked result is an
                // error the model reads, and the run goes on
                if (decision !== false) await guardToolResult(result, toolGuardrails, guardrailCtx);
                const turn = toolTurnFor(result);
                messages.push(turn);
                additions.push({ ...turn });
                allToolCalls.push(toolCall);
                allToolResults.push(result);
                emit?.({ type: "tool_result", toolResult: result });
            }
        }

        // One model call, with the fallbacks: an endpoint that is rate-limited, down or
        // unreachable hands over to the next one — as long as nothing was streamed yet
        let streamed = false;
        const guardedEmit = emit
            ? (chunk: AgentStreamChunk) => { streamed = true; emit(chunk); }
            : undefined;
        const chat = async (request: ModelChatRequest, step: number) => {
            const callStartedAt = Date.now();
            let lastError: any;
            for (const candidate of chain) {
                const adapter = resolveProvider(candidate);
                try {
                    const turn = streaming && guardedEmit
                        ? await this.#chatStream(adapter, request, guardedEmit)
                        : await this.#chat(adapter, request);
                    model = candidate.model;
                    if (candidate.pricing) {
                        turn.usage = { ...turn.usage, cost: costOf(turn.usage, candidate.pricing) };
                    }
                    const endedAt = Date.now();
                    trace(traceHook, {
                        type: "model.end",
                        at: endedAt,
                        step,
                        durationMs: endedAt - callStartedAt,
                        // What answered, not what was tried: a fallback is the model
                        model: candidate.model,
                        usage: turn.usage,
                        finishReason: turn.finishReason,
                    });
                    return turn;
                } catch (err: any) {
                    lastError = err;
                    // A stream that already reached the caller cannot be restarted
                    if (signal.aborted || streamed || !worthFallback(err)) throw err;
                }
            }
            throw lastError;
        };

        try {
            // Nothing to ask the model while a decision is pending. A resumed run
            // starts at the **next** step: the completed ones are never replayed through
            // the model, they are simply already in the conversation.
            for (let step = resumeState?.step ?? 0; !pending.length && step < maxSteps; step++) {
                trace(traceHook, { type: "step.start", at: Date.now(), step });
                if (signal.aborted) {
                    finishReason = "aborted";
                    break;
                }
                // The wall-clock budget is checked between steps: a model call already
                // started is bounded by its own `provider.options.timeout`
                if (maxDurationMs !== undefined && Date.now() - startedAt >= maxDurationMs) {
                    finishReason = "budget";
                    budget = { limit: "duration", value: maxDurationMs };
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
                    // What the provider can really enforce: `json_schema` on
                    // OpenAI-compatible gateways, a forced tool on Anthropic
                    ...(jsonSchema
                        ? { jsonSchema: { name: schemaName, ...(structured?.description ? { description: structured.description } : {}), schema: jsonSchema } }
                        : {}),
                };

                const turn = await chat(request, step);

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

                // The token/cost budget is checked **after** the assistant turn is in
                // the conversation: the paid answer is kept, and the calls it asked for
                // are answered with a refusal so the thread stays valid for a replay
                const overTokens = maxTokens !== undefined && usage.totalTokens > maxTokens;
                const overCost = maxCost !== undefined && (usage.cost ?? 0) > maxCost;
                if (overTokens || overCost) {
                    for (const toolCall of turn.toolCalls) {
                        const skipped: AgentToolResultEntry = {
                            id: toolCall.id,
                            name: toolCall.name,
                            args: toolCall.args,
                            durationMs: 0,
                            error: "Skipped: the run budget was exhausted",
                            errorCode: "AGENT_BUDGET_EXHAUSTED",
                        };
                        current.toolResults.push(skipped);
                        allToolResults.push(skipped);
                        recordToolStats(toolStats, skipped);
                        const toolTurn = toolTurnFor(skipped);
                        messages.push(toolTurn);
                        additions.push({ ...toolTurn });
                        emit?.({ type: "tool_result", toolResult: skipped });
                    }
                    budget = overTokens
                        ? { limit: "tokens", value: maxTokens! }
                        : { limit: "cost", value: maxCost! };
                    finishReason = "budget";
                    steps.push(current);
                    await call.onStepFinish?.(current);
                    emit?.({ type: "step", step: current });
                    await saveCheckpoint(step + 1);
                    break;
                }

                if (!turn.toolCalls.length) {
                    finishReason = turn.finishReason;
                    steps.push(current);
                    await call.onStepFinish?.(current);
                    await saveCheckpoint(step + 1);
                    break;
                }

                // A tool that needs a decision stops the run **before anything runs**: a
                // step is all-or-nothing, because every call of an assistant turn must be
                // answered before the conversation can go back to the model
                const waiting = turn.toolCalls.filter(
                    (toolCall) => tools.get(toolCall.name)?.approval && call.resume?.decisions?.[toolCall.id] === undefined,
                );
                if (waiting.length) {
                    pending.push(...waiting.map((toolCall) => ({
                        toolCallId: toolCall.id,
                        name: toolCall.name,
                        args: toolCall.args,
                    })));
                    break;
                }

                // The tools of one step: sequential by default (two writes must not
                // interleave), together when the caller asks for it **or** when every
                // call is read-only. The results are attached in the model's order
                // either way, and at most `maxParallelToolCalls` run at once.
                const entries: AgentToolResultEntry[] = [];
                const readOnlyStep = turn.toolCalls.length > 1
                    && turn.toolCalls.every((toolCall) => tools.get(toolCall.name)?.readOnly === true);
                if ((parallel || readOnlyStep) && turn.toolCalls.length > 1) {
                    entries.push(...await mapLimited(
                        turn.toolCalls,
                        maxParallelToolCalls,
                        (toolCall) => runTool(toolCall, step),
                    ));
                } else {
                    for (const toolCall of turn.toolCalls) {
                        entries.push(await runTool(toolCall, step));
                    }
                }

                // Tool guardrails: a **successful** result is checked before the model
                // reads it — a blocked one becomes an error and the run goes on
                for (const result of entries) await guardToolResult(result, toolGuardrails, guardrailCtx);

                turn.toolCalls.forEach((toolCall, index) => {
                    const result = entries[index]!;
                    current.toolResults.push(result);
                    allToolResults.push(result);
                    recordToolStats(toolStats, result);
                    const toolTurn = toolTurnFor(result);
                    messages.push(toolTurn);
                    additions.push({ ...toolTurn });
                    emit?.({ type: "tool_result", toolResult: result });
                });

                steps.push(current);
                await call.onStepFinish?.(current);
                emit?.({ type: "step", step: current });
                finishReason = turn.finishReason;
                if (step === maxSteps - 1) finishReason = "max_steps";
                await saveCheckpoint(step + 1);
            }
        } catch (err: any) {
            if (signal.aborted) {
                finishReason = "aborted";
            } else {
                // Keep what the run produced before it died: the tokens are paid, and a
                // run that leaves no trace makes the caller pay them twice
                if (savePartial && thread && this.#config.memory && !call.memory?.readOnly) {
                    await this.#persist(thread, [...history, ...additions], memoryCtx).catch(() => {});
                }
                endRun("error", err);
                throw err;
            }
        }

        // A run that paused for a decision has no answer to validate
        if (pending.length) finishReason = "approval_required";

        // Structured output — one repair turn, then give up with a stable code.
        let object: T | undefined;
        try {
            if (schema && !pending.length) {
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
                    const turn = await chat({
                        system,
                        messages: repair,
                        temperature: 0,
                        signal,
                        json: true,
                        ...(jsonSchema ? { jsonSchema: { name: schemaName, schema: jsonSchema } } : {}),
                    }, Math.max(0, steps.length - 1));

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

            // Output guardrails — the answer is checked **before** it is stored or
            // returned: a blocked answer is not persisted, and the caller gets the reason
            await runGuardrails(outputGuardrails, text, guardrailCtx, "answer");
        } catch (err) {
            endRun("error", err);
            throw err;
        }

        // A paused run stores **nothing**: the caller resumes with the conversation it
        // was handed back, and an assistant turn with unanswered calls would poison the
        // thread for the protocol
        if (thread && this.#config.memory && !call.memory?.readOnly && !pending.length) {
            try {
                await this.#persist(thread, [...history, ...additions], memoryCtx);
            } catch (err: any) {
                console.error(`The conversation of thread '${thread}' was not saved: ${err?.message}`);
            }
        }

        // A run that came back with an answer has nothing to resume: its state is
        // cleared. A paused or aborted run keeps it — that is what the next call
        // continues from. Best-effort: a store that fails is logged, never fatal.
        if (checkpointing && !pending.length && finishReason !== "aborted" && finishReason !== "error") {
            try {
                await checkpointStore!.clear(runId!);
            } catch (err: any) {
                console.error(`The checkpoint of run '${runId}' was not cleared: ${err?.message ?? err}`);
            }
        }

        // A delegated run's tokens and cost are the parent's: they are what the caller
        // pays for, and what a budget must see — `endRun` folds them in before
        // emitting the final event.
        endRun(finishReason);

        return {
            text,
            model,
            ...(budget ? { budget } : {}),
            ...(object !== undefined ? { object } : {}),
            ...(reasoning ? { reasoning } : {}),
            toolCalls: allToolCalls,
            toolResults: allToolResults,
            toolStats,
            steps,
            usage,
            finishReason,
            messages: [...history, ...additions],
            ...(pending.length ? { pendingApprovals: pending } : {}),
        };
    }

    /**
     * Store the thread. The `save` processors run last — they see what the run
     * produced, and a throw keeps the whole conversation out of the store (that is
     * the documented guardrail).
     */
    async #persist(thread: string, messages: AgentMessage[], ctx: AgentMemoryContext): Promise<void> {
        const stored = await applyProcessors(this.#config.processors, "save", messages, ctx);
        await this.#config.memory!.save(thread, lightenForMemory(stored), ctx);
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
