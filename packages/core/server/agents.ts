import type { Hono } from "hono";
import { cfg } from "./config";
import { AppError } from "../lib/error";
import { useRest } from "../database/rest";
import { createAgents } from "../lib/agents";
import { getTenant } from "../database/tenant";
import { requestCtxStorage } from "../lib/asyncContextStorage";
import { evaluateAccess, errorResponse } from "./access";
import { patterns } from "../lib/endpoints";
import type { HonoVariables } from "./env";
import type { Agent } from "../lib/agent";
import type {
    AgentCallOptions,
    AgentGenerateResult,
    AgentInput,
    AgentMessageInput,
} from "../types/agent";

/**
 * Agents HTTP API — `POST /api/:tenant_id/agents/:agent/:action`.
 *
 * Same shape as the services API (`/api/:tenant_id/services/:service/:action`) and
 * the same access model (`api.access`, **no rules = denied**).
 *
 * ```ts
 * // define.Agent({ api: { access: { generate: (ctx) => !!ctx.token.value } } })
 * POST /api/v1/agents/support/generate  { "input": "Where is my order?" }
 * POST /api/v1/agents/support/stream    { "input": "…", "thread": "user-42" }  → SSE
 * ```
 *
 * A client can only send **what it is allowed to choose**: the input, a memory
 * thread, injected turns and a *lower* `maxSteps` / `lastMessages`. The provider
 * (model, endpoint, key), the options and the structured-output schema stay
 * server-side — changing the model or the endpoint of a declared agent is a
 * deployment decision, not a request one.
 */

const AGENT_PREFIX = patterns.agent;

/** What an HTTP call may carry. Nothing else is read. */
type AgentRequestBody = {
    /** A string (one user turn), one message, or a whole conversation. */
    input?: string | AgentMessageInput | AgentMessageInput[];
    /**
     * Turns **injected** into the run — after the thread, before the `input`. They
     * are sent to the model *and* saved with the rest of the conversation.
     */
    messages?: AgentMessageInput | AgentMessageInput[];
    /** Memory thread. */
    thread?: string;
    /** @deprecated Alias of `thread`. */
    threadId?: string;
    /** Opaque caller identity, forwarded to the instructions function. */
    resource?: string;
    /** @deprecated Alias of `resource`. */
    resourceId?: string;
    /** Lower the run's step ceiling (never raise it). */
    maxSteps?: number;
    /** Lower the replayed-history window (never raise it past the declaration). */
    lastMessages?: number;
    /** `threads` — how many threads to return (default 20). */
    limit?: number;
    /**
     * Files and images sent with the run — base64, a `File`/`Blob` never crosses the
     * wire as such. `{ name: 'invoice.pdf', data: '<base64>' }`.
     */
    files?: Array<{
        /** File name — its extension decides how it is read (`report.pdf`, `data.csv`, `photo.png`). */
        name: string;
        mimeType?: string;
        /** Base64 (default) or UTF-8 text with `encoding: 'utf8'`. */
        data: string;
        encoding?: "base64" | "utf8";
    }>;
    /** Read the thread without writing the run back. */
    readOnly?: boolean;
    /** Mastra-style shorthand — `memory: { thread, resource, readOnly }`. */
    memory?: {
        thread?: string;
        /** @deprecated Alias of `thread`. */
        threadId?: string;
        resource?: string;
        /** @deprecated Alias of `resource`. */
        resourceId?: string;
        readOnly?: boolean;
    };
};

/** `memory.thread` first, then the flat `thread` (and its `threadId` alias). */
function resolveThread(body: AgentRequestBody | undefined): string | undefined {
    const thread = body?.memory?.thread ?? body?.memory?.threadId ?? body?.thread ?? body?.threadId;
    return typeof thread === 'string' && thread.trim() ? thread : undefined;
}

/** `memory.resource` first, then the flat `resource` (and its `resourceId` alias). */
function resolveResource(body: AgentRequestBody | undefined): string | undefined {
    const resource = body?.memory?.resource ?? body?.memory?.resourceId ?? body?.resource ?? body?.resourceId;
    return typeof resource === 'string' && resource.trim() ? resource : undefined;
}

/** Cap on the prompt kept in the audit trail. */
const AUDIT_INPUT_MAX = 2000;

/**
 * The input of a run — a string, **one** message, or a whole conversation. The
 * shape itself (roles, content parts, tool parts) is validated by
 * `normalizeMessages`, shared with the in-process runtime: the two cannot drift.
 */
function normalizeInput(body: AgentRequestBody | undefined): AgentInput {
    const input = body?.input;
    if (typeof input === "string") {
        if (!input.trim()) throw new AppError('`input` is required', { status: 400, code: 'INPUT_REQUIRED' });
        return input;
    }
    if (Array.isArray(input)) {
        if (!input.length) throw new AppError('`input` is required', { status: 400, code: 'INPUT_REQUIRED' });
        return input as AgentInput;
    }
    if (input && typeof input === "object" && typeof (input as any).role === "string") {
        return input as AgentInput;
    }
    throw new AppError('`input` is required (a string, a message or an array of messages)', {
        status: 400, code: 'INPUT_REQUIRED',
    });
}

function requireThread(body: AgentRequestBody | undefined): string {
    const thread = resolveThread(body);
    if (!thread) {
        throw new AppError('`thread` is required (or `memory.thread`)', { status: 400, code: 'THREAD_ID_REQUIRED' });
    }
    return thread;
}

/** A client may lower the step ceiling, never raise it — the cost is the tenant's. */
function resolveMaxSteps(requested: unknown, agent: Agent): number {
    const declared = agent.getConfig().maxSteps ?? 5;
    const asked = Number(requested);
    if (!Number.isFinite(asked) || asked <= 0) return declared;
    return Math.max(1, Math.min(Math.floor(asked), declared));
}

/**
 * The history window of a request: a client may shrink the prompt, never grow it
 * past what the agent declares (with no declaration, the store cap is the only
 * bound that matters — and it is already applied on read).
 */
function resolveLastMessages(requested: unknown, agent: Agent): number | undefined {
    const declared = agent.getConfig().lastMessages;
    const asked = Number(requested);
    if (!Number.isFinite(asked) || asked <= 0) return declared;
    if (!declared) return Math.floor(asked);
    return Math.max(1, Math.min(Math.floor(asked), declared));
}

/** The answer's envelope — the conversation itself is available through `history`. */
function presentResult(result: AgentGenerateResult) {
    return {
        text: result.text,
        // Same envelope as `generate()` in-process: the reasoning travels with the run
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
        toolCalls: result.toolCalls,
        toolResults: result.toolResults,
        steps: result.steps,
        usage: result.usage,
        finishReason: result.finishReason,
    };
}

/** The prompt is a parameter — capped, and redacted like any other payload. */
function auditInput(input: AgentInput | undefined) {
    if (typeof input === 'string') {
        return input.length > AUDIT_INPUT_MAX
            ? { text: input.slice(0, AUDIT_INPUT_MAX), length: input.length, truncated: true }
            : { text: input };
    }
    return { messages: Array.isArray(input) ? input.length : 1 };
}

type AuditOptions = {
    rest: InstanceType<typeof useRest>;
    agentId: string;
    action: string;
    input?: AgentInput;
    thread?: string;
    result?: AgentGenerateResult;
    error?: { message: string; code?: string };
    started: number;
};

/** One audit entry per call, at the same place as `_vars_:<ns>` — `_agents_:<id>`. */
async function auditAgent({
    rest, agentId, action, input, thread, result, error, started,
}: AuditOptions): Promise<void> {
    await rest.audit.log({
        action: `agent.${action}`,
        collection: `_agents_:${agentId}`,
        input: { agent: agentId, thread, ...auditInput(input) },
        // Never the answer, never the tool arguments: the envelope only.
        result: result
            ? {
                finishReason: result.finishReason,
                usage: result.usage,
                toolCalls: result.toolCalls.map((call) => ({ name: call.name })),
                steps: result.steps,
            }
            : undefined,
        error,
        duration: Date.now() - started,
    }).catch(() => {});
}

/** The streamed answer is one SSE event per runtime chunk, then a `done` event. */
function streamResponse(
    c: any,
    agent: Agent,
    input: AgentInput,
    callOptions: AgentCallOptions,
    audit: Omit<AuditOptions, 'input' | 'thread' | 'result' | 'error'>,
): Response {
    const encoder = new TextEncoder();
    const stream = agent.stream(input, callOptions);

    const body = new ReadableStream<Uint8Array>({
        async start(controller) {
            const send = (payload: any) => {
                try {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
                } catch {
                    // The client is gone — the run is already aborted by its signal.
                }
            };

            try {
                for await (const chunk of stream.fullStream) send(chunk);

                const result = {
                    text: await stream.text,
                    object: await stream.object,
                    toolCalls: await stream.toolCalls,
                    toolResults: await stream.toolResults,
                    steps: await stream.steps,
                    usage: await stream.usage,
                    finishReason: await stream.finishReason,
                    messages: [],
                } as AgentGenerateResult;

                send({
                    type: 'done',
                    result: presentResult(result),
                    ...(result.object !== undefined ? { object: result.object } : {}),
                });
                await auditAgent({ ...audit, result });
            } catch (err: any) {
                send({
                    type: 'error',
                    message: err?.message ?? 'Agent stream failed',
                    code: err?.code ?? 'INTERNAL_AGENT_ERROR',
                });
                await auditAgent({
                    ...audit,
                    error: { message: err?.message, code: err?.code || 'INTERNAL_AGENT_ERROR' },
                });
            } finally {
                try { controller.close(); } catch { /* already closed */ }
            }
        },
        cancel() {
            // Client disconnected mid-run: stop paying for tokens.
            stream.abort('client disconnected');
        },
    });

    return new Response(body, {
        headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            // nginx: never buffer an event stream
            'X-Accel-Buffering': 'no',
        },
    });
}

function initializeAgents(app: Hono<{ Variables: HonoVariables }>) {
    app.post(AGENT_PREFIX, async (c) => {
        const started = Date.now();
        let rest: InstanceType<typeof useRest> | undefined;
        let tenant_id = '';
        let agentId = '';
        let action = '';

        try {
            const contentType = c.req.header('Content-Type');
            let body: AgentRequestBody | undefined;
            if (contentType?.includes('application/json')) {
                // `info` legitimately carries no body: an empty one is `{}`, a
                // malformed one is an error (never silently ignored).
                const raw = await c.req.text();
                if (raw.trim()) {
                    try {
                        body = JSON.parse(raw);
                    } catch {
                        throw new AppError('Invalid JSON body', { status: 400, code: 'INVALID_JSON_BODY' });
                    }
                }
            }

            const params = c.req.param() as { tenant_id: string; agent: string; action: string };
            tenant_id = params.tenant_id;
            agentId = params.agent;
            action = params.action;

            if (!tenant_id) throw new AppError('Tenant ID is required', { status: 400, code: 'TENANT_ID_REQUIRED' });
            if (!agentId) throw new AppError('Agent is required', { status: 400, code: 'AGENT_REQUIRED' });
            if (!action) throw new AppError('Action is required', { status: 400, code: 'ACTION_REQUIRED' });
            if (!getTenant(tenant_id)) throw new AppError('Tenant not found', { status: 400, code: 'TENANT_NOT_FOUND' });

            requestCtxStorage.set('tenant_id', tenant_id);

            // Only agents declared with `define.Agent` are reachable, and their
            // `api.access` gates every action (no rules = denied).
            rest = new useRest({ internal: false, tenant_id });
            const agent = createAgents(tenant_id, rest).get(agentId);
            if (!agent) throw new AppError(`Agent '${agentId}' not found`, { status: 400, code: 'AGENT_NOT_FOUND' });

            const api = agent.getConfig().api;
            const needsInput = action === 'generate' || action === 'stream' || action === 'object';
            const input = needsInput ? normalizeInput(body) : undefined;
            // `memory: { thread, resource }` or the flat `thread` / `resource`
            const thread = resolveThread(body);
            const resource = resolveResource(body);
            const readOnly = body?.readOnly ?? body?.memory?.readOnly ?? false;

            await evaluateAccess(api?.access as any, action, rest, `agents:${agentId}`, c, {
                agent,
                action,
                body,
                input,
                thread,
                // The deprecated alias, so a rule written against it keeps working
                threadId: thread,
            });

            const callOptions: AgentCallOptions = {
                thread,
                resource,
                maxSteps: resolveMaxSteps(body?.maxSteps, agent),
                lastMessages: resolveLastMessages(body?.lastMessages, agent),
                // Injected turns: the same normalization as the input, so a client can
                // seed context without building one big `input` array
                ...(body?.messages ? { messages: body.messages as AgentInput } : {}),
                // Stop the run when the client disconnects (no tokens past the wire)
                signal: c.req.raw.signal,
                ...(body?.files?.length ? { files: body.files } : {}),
                ...(readOnly ? { memory: { readOnly: true } } : {}),
            };

            if (action === 'stream') {
                return streamResponse(c, agent, input as AgentInput, callOptions, {
                    rest, agentId, action, started,
                });
            }

            let result: AgentGenerateResult | undefined;
            let response: any;

            switch (action) {
                case 'info':
                    // No model call, no token spent
                    response = { agent: agent.toJSON() };
                    break;

                case 'history': {
                    if (!agent.getMemory()) {
                        throw new AppError(`Agent '${agentId}' declares no memory`, { status: 400, code: 'AGENT_NO_MEMORY' });
                    }
                    // The same `resource` the run used: it namespaces the thread
                    response = {
                        messages: await agent.getMessages(requireThread(body), { resource }),
                    };
                    break;
                }

                case 'threads': {
                    if (!agent.getMemory()) {
                        throw new AppError(`Agent '${agentId}' declares no memory`, { status: 400, code: 'AGENT_NO_MEMORY' });
                    }
                    if (!agent.getMemory()?.list) {
                        throw new AppError(
                            `The memory of agent '${agentId}' does not list threads`,
                            { status: 400, code: 'AGENT_MEMORY_NO_LIST' },
                        );
                    }
                    response = { threads: await agent.listThreads({ resource, limit: body?.limit }) };
                    break;
                }

                case 'clear': {
                    if (!agent.getMemory()) {
                        throw new AppError(`Agent '${agentId}' declares no memory`, { status: 400, code: 'AGENT_NO_MEMORY' });
                    }
                    await agent.clearMessages(requireThread(body), { resource });
                    response = { ok: true };
                    break;
                }

                case 'generate': {
                    const generated = await agent.generate(input as AgentInput, callOptions);
                    result = generated;
                    response = presentResult(generated);
                    break;
                }

                case 'object': {
                    const structuredOutput = api?.object;
                    if (!structuredOutput?.schema) {
                        throw new AppError(
                            `Agent '${agentId}' declares no \`api.object\` schema`,
                            { status: 400, code: 'AGENT_NO_OBJECT_SCHEMA' },
                        );
                    }
                    const generated = await agent.generate(input as AgentInput, { ...callOptions, structuredOutput });
                    result = generated;
                    response = { ...presentResult(generated), object: generated.object };
                    break;
                }

                default:
                    throw new AppError(`Action '${action}' not found`, { status: 400, code: 'ACTION_NOT_FOUND' });
            }

            await auditAgent({ rest, agentId, action, input, thread, result, started });
            return c.json(response);
        } catch (err: any) {
            if (cfg?.debug) console.error(err);
            if (rest && tenant_id && agentId) {
                await rest.audit.log({
                    action: `agent.${action || 'unknown'}`,
                    collection: `_agents_:${agentId}`,
                    input: { agent: agentId },
                    error: { message: err?.message, code: err?.code || 'INTERNAL_AGENT_ERROR' },
                    duration: Date.now() - started,
                }).catch(() => {});
            }
            return errorResponse(c, err);
        }
    });
}

export { initializeAgents, AGENT_PREFIX };
