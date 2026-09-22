import { AppError } from "./error";
import type {
    AgentCompatible,
    AgentContentPart,
    AgentMessage,
    AgentProvider,
    AgentUsage,
} from "../types/agent";

/**
 * Model provider adapters.
 *
 * Two wire protocols cover the whole field:
 *
 * - `openai`    — `POST {baseUrl}/chat/completions`, `Authorization: Bearer …`.
 *                 Every OpenAI-compatible gateway (Groq, Mistral, OpenRouter,
 *                 Ollama, LM Studio, vLLM…) speaks it too, only `baseUrl` changes.
 * - `anthropic` — `POST {baseUrl}/v1/messages`, `x-api-key: …`.
 *
 * Both are called with `fetch` — no SDK, no transitive dependency, and the
 * streaming path is plain SSE in both cases. The agent runtime only ever sees
 * the normalized shapes below.
 */

/** A tool advertised to the model (already a JSON Schema). */
export type AgentToolSpec = {
    name: string;
    description?: string;
    parameters: any;
};

export type ModelChatRequest = {
    /** System prompt (kept separate from `messages` — Anthropic wants it out of band). */
    system?: string;
    messages: AgentMessage[];
    tools?: AgentToolSpec[];
    /** Per-request override of the adapter's `options.temperature`. */
    temperature?: number;
    /** Per-request override of the adapter's `options.maxTokens`. */
    maxTokens?: number;
    signal?: AbortSignal;
    /** Ask for a JSON object (OpenAI-compatible providers: `response_format`). */
    json?: boolean;
};

export type ModelChatResponse = {
    text: string;
    toolCalls: Array<{ id: string; name: string; argsText: string }>;
    finishReason: string;
    usage: AgentUsage;
    raw?: any;
};

export type ModelStreamEvent =
    | { type: "text"; text: string }
    | { type: "tool_call"; index: number; id?: string; name?: string; argsText?: string }
    | { type: "usage"; usage: Partial<AgentUsage> }
    | { type: "finish"; finishReason: string };

export type ModelAdapter = {
    compatible: AgentCompatible;
    model: string;
    chat(req: ModelChatRequest): Promise<ModelChatResponse>;
    chatStream(req: ModelChatRequest): AsyncGenerator<ModelStreamEvent, void, unknown>;
};

const DEFAULT_BASE_URL: Record<AgentCompatible, string> = {
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com",
};

const ENV_API_KEY: Record<AgentCompatible, string[]> = {
    openai: ["ANTEROS_AI_API_KEY", "OPENAI_API_KEY"],
    anthropic: ["ANTEROS_AI_API_KEY", "ANTHROPIC_API_KEY"],
};

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_RETRIES = 2;

const EMPTY_USAGE: AgentUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 };

// ─── Configuration resolution ────────────────────────────────────────────

function resolveCompatible(provider: AgentProvider): AgentCompatible {
    const compatible = provider.compatible ?? "openai";
    if (compatible !== "openai" && compatible !== "anthropic") {
        throw new AppError(`Unknown provider 'compatible': '${compatible}' — expected 'openai' or 'anthropic'`, {
            status: 500,
            code: "AGENT_PROVIDER_INVALID",
        });
    }
    return compatible;
}

function resolveApiKey(provider: AgentProvider, compatible: AgentCompatible): string {
    if (provider.apiKey) return provider.apiKey;
    for (const name of ENV_API_KEY[compatible]) {
        const value = Bun.env?.[name] ?? process.env?.[name];
        if (value) return value;
    }
    throw new AppError(
        `No API key for provider '${provider.model}' (compatible: ${compatible}) — pass \`provider.apiKey\` or set ${ENV_API_KEY[compatible].join(" / ")}`,
        { status: 500, code: "AGENT_PROVIDER_NO_API_KEY" },
    );
}

/**
 * API root. A bare host gets the conventional prefix appended
 * (`http://localhost:11434` → `http://localhost:11434/v1` for OpenAI-compatible
 * servers), an explicit path is used verbatim.
 */
function resolveBaseUrl(provider: AgentProvider, compatible: AgentCompatible): string {
    const raw = provider.baseUrl ?? DEFAULT_BASE_URL[compatible];
    const trimmed = raw.replace(/\/+$/, "");
    if (compatible !== "openai") return trimmed;
    try {
        const url = new URL(trimmed);
        if (url.pathname === "" || url.pathname === "/") url.pathname = "/v1";
        return url.toString().replace(/\/+$/, "");
    } catch {
        return trimmed;
    }
}

// ─── Message conversion ──────────────────────────────────────────────────

function openaiContent(content: string | AgentContentPart[]): any {
    if (typeof content === "string") return content;
    return content.map((part) =>
        part.type === "text"
            ? { type: "text", text: part.text }
            : { type: "image_url", image_url: { url: `data:${part.mimeType ?? "image/png"};base64,${part.data}` } },
    );
}

/** `AgentMessage[]` → OpenAI `messages[]`. */
function openaiMessages(system: string | undefined, messages: AgentMessage[]): any[] {
    const out: any[] = [];
    if (system) out.push({ role: "system", content: system });
    for (const message of messages) {
        switch (message.role) {
            case "system":
                out.push({ role: "system", content: message.content });
                break;
            case "user":
                out.push({ role: "user", content: openaiContent(message.content) });
                break;
            case "assistant": {
                const msg: any = { role: "assistant", content: message.content ?? null };
                if (message.toolCalls?.length) {
                    msg.tool_calls = message.toolCalls.map((call) => ({
                        id: call.id,
                        type: "function",
                        function: { name: call.name, arguments: call.argsText ?? JSON.stringify(call.args ?? {}) },
                    }));
                }
                out.push(msg);
                break;
            }
            case "tool":
                out.push({ role: "tool", tool_call_id: message.toolCallId, content: message.content });
                break;
        }
    }
    return out;
}

function anthropicContent(content: string | AgentContentPart[]): any {
    if (typeof content === "string") return [{ type: "text", text: content }];
    return content.map((part) =>
        part.type === "text"
            ? { type: "text", text: part.text }
            : {
                type: "image",
                source: { type: "base64", media_type: part.mimeType ?? "image/png", data: part.data },
            },
    );
}

/**
 * `AgentMessage[]` → Anthropic `messages[]`.
 *
 * Two structural differences with OpenAI: `system` is out of band (returned
 * separately) and a tool result is a **user** message holding `tool_result`
 * blocks — consecutive results are merged into a single turn.
 */
function anthropicMessages(messages: AgentMessage[]): { system: string | undefined; messages: any[] } {
    const out: any[] = [];
    const systems: string[] = [];

    for (const message of messages) {
        switch (message.role) {
            case "system":
                systems.push(message.content);
                break;
            case "user":
                out.push({ role: "user", content: anthropicContent(message.content) });
                break;
            case "assistant": {
                const blocks: any[] = [];
                if (message.content) blocks.push({ type: "text", text: message.content });
                for (const call of message.toolCalls ?? []) {
                    blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.args ?? {} });
                }
                out.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "" }] });
                break;
            }
            case "tool": {
                const block: any = { type: "tool_result", tool_use_id: message.toolCallId, content: message.content };
                if (message.isError) block.is_error = true;
                const last = out[out.length - 1];
                if (last?.role === "user" && Array.isArray(last.content)
                    && last.content.every((b: any) => b.type === "tool_result")) {
                    last.content.push(block);
                } else {
                    out.push({ role: "user", content: [block] });
                }
                break;
            }
        }
    }

    return { system: systems.length ? systems.join("\n\n") : undefined, messages: out };
}

function openaiToolSpecs(tools: AgentToolSpec[]): any[] {
    return tools.map((tool) => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    }));
}

function anthropicToolSpecs(tools: AgentToolSpec[]): any[] {
    return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
    }));
}

/** Provider-specific finish reasons → the normalized vocabulary. */
function normalizeFinishReason(reason: string | null | undefined): string {
    switch (reason) {
        case "tool_calls":
        case "tool_use":
            return "tool_use";
        case "end_turn":
        case "stop_sequence":
        case "stop":
            return "stop";
        case "max_tokens":
        case "length":
            return "length";
        case "content_filter":
            return "content_filter";
        case null:
        case undefined:
            return "stop";
        default:
            return reason;
    }
}

function mapUsage(raw: any, compatible: AgentCompatible): AgentUsage {
    if (!raw) return { ...EMPTY_USAGE };
    const input = compatible === "anthropic" ? raw.input_tokens : raw.prompt_tokens;
    const output = compatible === "anthropic" ? raw.output_tokens : raw.completion_tokens;
    const inputTokens = Number(input ?? 0);
    const outputTokens = Number(output ?? 0);
    return {
        inputTokens,
        outputTokens,
        totalTokens: Number(raw.total_tokens ?? inputTokens + outputTokens),
        requests: 1,
    };
}

// ─── HTTP + SSE ──────────────────────────────────────────────────────────

function providerErrorMessage(body: string, status: number): string {
    try {
        const parsed = JSON.parse(body);
        const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
        if (typeof message === "string" && message) return message;
    } catch {
        // not JSON — fall through to the raw body
    }
    return body.slice(0, 500) || `HTTP ${status}`;
}

/**
 * Fetch with retries on network failures, 429 and 5xx.
 * HTTP-specific (it inspects the status code), unlike the replication retry.
 */
async function fetchWithRetry(
    url: string,
    init: RequestInit,
    provider: AgentProvider,
    compatible: AgentCompatible,
): Promise<Response> {
    const options = provider.options ?? {};
    const retries = options.retries ?? DEFAULT_RETRIES;
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const callerSignal = init.signal ?? undefined;
    let lastError: any;

    for (let attempt = 0; attempt <= retries; attempt++) {
        if (callerSignal?.aborted) throw abortedError();
        const signal = AbortSignal.any([AbortSignal.timeout(timeout), ...(callerSignal ? [callerSignal] : [])]);
        try {
            const response = await fetch(url, { ...init, signal });
            if (response.status === 429 || response.status >= 500) {
                const body = await response.text().catch(() => "");
                lastError = new AppError(`Provider error (${response.status}): ${providerErrorMessage(body, response.status)}`, {
                    status: 502,
                    code: "AGENT_PROVIDER_ERROR",
                    reason: { provider: compatible, status: response.status },
                });
            } else {
                return response;
            }
        } catch (err: any) {
            if (callerSignal?.aborted) throw abortedError();
            if (err instanceof AppError) lastError = err;
            if (err?.name === "TimeoutError" || err?.name === "AbortError") {
                throw new AppError(`Provider '${provider.model}' timed out after ${timeout}ms`, {
                    status: 504,
                    code: "AGENT_PROVIDER_TIMEOUT",
                });
            } else {
                lastError = new AppError(`Provider request failed: ${err?.message ?? err}`, {
                    status: 502,
                    code: "AGENT_PROVIDER_ERROR",
                });
            }
        }

        if (attempt < retries) await Bun.sleep(250 * Math.pow(2, attempt));
    }

    throw lastError;
}

function abortedError(): AppError {
    return new AppError("Agent run aborted", { status: 499, code: "AGENT_ABORTED" });
}

/** Read a `text/event-stream` body and yield the `data:` payloads. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    const separator = /\r?\n\r?\n/;
    let buffer = "";

    for await (const chunk of body as any) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let match: RegExpMatchArray | null;
        while ((match = separator.exec(buffer)) !== null) {
            const start = match.index ?? 0;
            const block = buffer.slice(0, start);
            buffer = buffer.slice(start + match[0].length);
            const data = block
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trim())
                .join("\n");
            if (data) yield data;
        }
    }

    const tail = buffer
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
    if (tail) yield tail;
}

/** An error event sent by the provider in the middle of a stream. */
function streamError(payload: any, compatible: AgentCompatible): AppError | null {
    const message = payload?.error?.message ?? (typeof payload?.error === "string" ? payload.error : null);
    if (!message) return null;
    return new AppError(`Provider stream error: ${message}`, {
        status: 502,
        code: "AGENT_PROVIDER_ERROR",
        reason: { provider: compatible },
    });
}

// ─── OpenAI-compatible adapter ───────────────────────────────────────────

function openaiAdapter(provider: AgentProvider, compatible: AgentCompatible): ModelAdapter {
    const baseUrl = resolveBaseUrl(provider, compatible);
    const url = `${baseUrl}/chat/completions`;
    const options = provider.options ?? {};

    const headers = (): Record<string, string> => ({
        "Content-Type": "application/json",
        Authorization: `Bearer ${resolveApiKey(provider, compatible)}`,
        ...(provider.headers ?? {}),
    });

    const body = (req: ModelChatRequest, stream: boolean): any => {
        const payload: any = {
            model: provider.model,
            messages: openaiMessages(req.system, req.messages),
            max_tokens: req.maxTokens ?? options.maxTokens ?? DEFAULT_MAX_TOKENS,
        };
        if (req.tools?.length) {
            payload.tools = openaiToolSpecs(req.tools);
            payload.tool_choice = "auto";
        }
        const temperature = req.temperature ?? options.temperature;
        if (temperature !== undefined) payload.temperature = temperature;
        if (options.topP !== undefined) payload.top_p = options.topP;
        if (req.json) payload.response_format = { type: "json_object" };
        if (stream) {
            payload.stream = true;
            payload.stream_options = { include_usage: true };
        }
        return payload;
    };

    return {
        compatible,
        model: provider.model,

        async chat(req) {
            const response = await fetchWithRetry(url, {
                method: "POST",
                headers: headers(),
                body: JSON.stringify(body(req, false)),
                signal: req.signal,
            }, provider, compatible);

            if (!response.ok) {
                const text = await response.text().catch(() => "");
                throw new AppError(`Provider error (${response.status}): ${providerErrorMessage(text, response.status)}`, {
                    status: 502,
                    code: "AGENT_PROVIDER_ERROR",
                    reason: { provider: compatible, status: response.status },
                });
            }

            const raw: any = await response.json();
            const choice = raw?.choices?.[0];
            const toolCalls = (choice?.message?.tool_calls ?? []).map((call: any, index: number) => ({
                id: call?.id ?? `call_${index}`,
                name: call?.function?.name ?? "unknown",
                argsText: call?.function?.arguments ?? "{}",
            }));

            return {
                text: typeof choice?.message?.content === "string" ? choice.message.content : "",
                toolCalls,
                finishReason: normalizeFinishReason(choice?.finish_reason),
                usage: mapUsage(raw?.usage, compatible),
                raw,
            };
        },

        async *chatStream(req) {
            const response = await fetchWithRetry(url, {
                method: "POST",
                headers: headers(),
                body: JSON.stringify(body(req, true)),
                signal: req.signal,
            }, provider, compatible);

            if (!response.ok || !response.body) {
                const text = await response.text().catch(() => "");
                throw new AppError(`Provider error (${response.status}): ${providerErrorMessage(text, response.status)}`, {
                    status: 502,
                    code: "AGENT_PROVIDER_ERROR",
                    reason: { provider: compatible, status: response.status },
                });
            }

            for await (const data of sseData(response.body)) {
                if (data === "[DONE]") return;
                let payload: any;
                try {
                    payload = JSON.parse(data);
                } catch {
                    continue;
                }
                const error = streamError(payload, compatible);
                if (error) throw error;

                const choice = payload?.choices?.[0];
                const delta = choice?.delta;
                if (typeof delta?.content === "string" && delta.content) {
                    yield { type: "text", text: delta.content };
                }
                for (const call of delta?.tool_calls ?? []) {
                    const index = call?.index ?? 0;
                    const argsText = call?.function?.arguments;
                    if (call?.id || call?.function?.name || argsText) {
                        yield {
                            type: "tool_call",
                            index,
                            ...(call?.id ? { id: call.id } : {}),
                            ...(call?.function?.name ? { name: call.function.name } : {}),
                            ...(argsText ? { argsText } : {}),
                        };
                    }
                }
                if (payload?.usage) yield { type: "usage", usage: mapUsage(payload.usage, compatible) };
                if (choice?.finish_reason) yield { type: "finish", finishReason: normalizeFinishReason(choice.finish_reason) };
            }
        },
    };
}

// ─── Anthropic adapter ───────────────────────────────────────────────────

function anthropicAdapter(provider: AgentProvider, compatible: AgentCompatible): ModelAdapter {
    const baseUrl = resolveBaseUrl(provider, compatible);
    const url = `${baseUrl}/v1/messages`;
    const options = provider.options ?? {};

    const headers = (): Record<string, string> => ({
        "Content-Type": "application/json",
        "x-api-key": resolveApiKey(provider, compatible),
        "anthropic-version": "2023-06-01",
        ...(provider.headers ?? {}),
    });

    const body = (req: ModelChatRequest, stream: boolean): any => {
        const converted = anthropicMessages(req.messages);
        const system = [req.system, converted.system].filter(Boolean).join("\n\n");
        const payload: any = {
            model: provider.model,
            messages: converted.messages,
            // `max_tokens` is REQUIRED by the Messages API
            max_tokens: req.maxTokens ?? options.maxTokens ?? DEFAULT_MAX_TOKENS,
        };
        if (system) payload.system = system;
        if (req.tools?.length) payload.tools = anthropicToolSpecs(req.tools);
        const temperature = req.temperature ?? options.temperature;
        if (temperature !== undefined) payload.temperature = temperature;
        if (options.topP !== undefined) payload.top_p = options.topP;
        if (stream) payload.stream = true;
        return payload;
    };

    return {
        compatible,
        model: provider.model,

        async chat(req) {
            const response = await fetchWithRetry(url, {
                method: "POST",
                headers: headers(),
                body: JSON.stringify(body(req, false)),
                signal: req.signal,
            }, provider, compatible);

            if (!response.ok) {
                const text = await response.text().catch(() => "");
                throw new AppError(`Provider error (${response.status}): ${providerErrorMessage(text, response.status)}`, {
                    status: 502,
                    code: "AGENT_PROVIDER_ERROR",
                    reason: { provider: compatible, status: response.status },
                });
            }

            const raw: any = await response.json();
            const blocks: any[] = Array.isArray(raw?.content) ? raw.content : [];
            const toolCalls = blocks
                .filter((block) => block?.type === "tool_use")
                .map((block: any, index: number) => ({
                    id: block?.id ?? `toolu_${index}`,
                    name: block?.name ?? "unknown",
                    argsText: JSON.stringify(block?.input ?? {}),
                }));

            return {
                text: blocks.filter((block) => block?.type === "text").map((block) => block.text).join(""),
                toolCalls,
                finishReason: normalizeFinishReason(raw?.stop_reason),
                usage: mapUsage(raw?.usage, compatible),
                raw,
            };
        },

        async *chatStream(req) {
            const response = await fetchWithRetry(url, {
                method: "POST",
                headers: headers(),
                body: JSON.stringify(body(req, true)),
                signal: req.signal,
            }, provider, compatible);

            if (!response.ok || !response.body) {
                const text = await response.text().catch(() => "");
                throw new AppError(`Provider error (${response.status}): ${providerErrorMessage(text, response.status)}`, {
                    status: 502,
                    code: "AGENT_PROVIDER_ERROR",
                    reason: { provider: compatible, status: response.status },
                });
            }

            for await (const data of sseData(response.body)) {
                let payload: any;
                try {
                    payload = JSON.parse(data);
                } catch {
                    continue;
                }
                const error = streamError(payload, compatible);
                if (error) throw error;

                switch (payload?.type) {
                    case "message_start": {
                        const usage = payload?.message?.usage;
                        // Only the keys actually reported: the agent merges the partials
                        // (input at the start, output at the end) instead of overwriting.
                        if (usage) yield { type: "usage", usage: { inputTokens: Number(usage.input_tokens ?? 0) } };
                        break;
                    }
                    case "content_block_start": {
                        const block = payload?.content_block;
                        if (block?.type === "tool_use") {
                            yield {
                                type: "tool_call",
                                index: payload.index ?? 0,
                                ...(block.id ? { id: block.id } : {}),
                                ...(block.name ? { name: block.name } : {}),
                            };
                        }
                        break;
                    }
                    case "content_block_delta": {
                        const delta = payload?.delta;
                        if (delta?.type === "text_delta" && delta.text) {
                            yield { type: "text", text: delta.text };
                        } else if (delta?.type === "input_json_delta" && delta.partial_json) {
                            yield { type: "tool_call", index: payload.index ?? 0, argsText: delta.partial_json };
                        }
                        break;
                    }
                    case "message_delta": {
                        if (payload?.usage) {
                            yield { type: "usage", usage: { outputTokens: Number(payload.usage.output_tokens ?? 0) } };
                        }
                        if (payload?.delta?.stop_reason) {
                            yield { type: "finish", finishReason: normalizeFinishReason(payload.delta.stop_reason) };
                        }
                        break;
                    }
                    case "error":
                        throw new AppError(`Provider stream error: ${payload?.error?.message ?? "unknown"}`, {
                            status: 502,
                            code: "AGENT_PROVIDER_ERROR",
                            reason: { provider: compatible },
                        });
                }
            }
        },
    };
}

// ─── Entry point ─────────────────────────────────────────────────────────

/**
 * Build the adapter for a provider — resolves the key, the base URL and the
 * defaults once, so a run never re-reads the environment.
 */
function resolveProvider(provider: AgentProvider): ModelAdapter {
    if (!provider?.model) {
        throw new AppError("`provider.model` is required", { status: 500, code: "AGENT_PROVIDER_INVALID" });
    }
    const compatible = resolveCompatible(provider);
    return compatible === "anthropic"
        ? anthropicAdapter(provider, compatible)
        : openaiAdapter(provider, compatible);
}

export {
    EMPTY_USAGE,
    DEFAULT_MAX_TOKENS,
    resolveCompatible,
    resolveApiKey,
    resolveBaseUrl,
    resolveProvider,
    openaiContent,
    openaiMessages,
    anthropicContent,
    anthropicMessages,
    openaiToolSpecs,
    anthropicToolSpecs,
    normalizeFinishReason,
    mapUsage,
    sseData,
};
