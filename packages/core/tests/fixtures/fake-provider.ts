/**
 * Fake model providers for the agent tests — one local HTTP endpoint per
 * protocol, recording what the runtime sent.
 *
 * Shared by `agent.test.ts` (runtime) and `agents-api.test.ts` (HTTP surface),
 * so a change in the wire format is fixed in one place.
 */

export type Recorded = { path: string; body: any; headers: Record<string, string> };

export type Fake = {
    requests: Recorded[];
    url: string;
    hits: () => number;
    stop: () => void;
};

/** A local endpoint that records the requests and answers from `handler`. */
export function fakeProvider(handler: (body: any, req: Request, hits: number) => Response | Promise<Response>): Fake {
    const requests: Recorded[] = [];
    let hits = 0;
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: async (req) => {
            const body = await req.json().catch(() => null);
            requests.push({
                path: new URL(req.url).pathname,
                body,
                headers: Object.fromEntries(req.headers.entries()),
            });
            hits += 1;
            return handler(body, req, hits);
        },
    });
    return {
        requests,
        url: `http://127.0.0.1:${server.port}`,
        hits: () => hits,
        stop: () => server.stop(true),
    };
}

/** Typed element access (`noUncheckedIndexedAccess` is on). */
export function at<T>(list: T[], index = 0): T {
    const item = list[index];
    if (item === undefined) throw new Error(`No element #${index} (length ${list.length})`);
    return item;
}

export function request(provider: Fake, index = 0): Recorded {
    const recorded = provider.requests[index];
    if (!recorded) throw new Error(`No request #${index} was recorded (got ${provider.requests.length})`);
    return recorded;
}

export const USAGE = { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 };
export const A_USAGE = { input_tokens: 13, output_tokens: 6 };

/** An SSE response from a list of already-serialized events. */
export function sse(events: string[]): Response {
    return new Response(events.map((event) => `data: ${event}\n\n`).join(""), {
        headers: { "Content-Type": "text/event-stream" },
    });
}

// ─── OpenAI-compatible ───────────────────────────────────────────────────

export function openaiText(text: string, finishReason = "stop"): Response {
    return Response.json({
        choices: [{ message: { role: "assistant", content: text }, finish_reason: finishReason }],
        usage: USAGE,
    });
}

export function openaiTool(name: string, args: any, id = "call_1"): Response {
    return Response.json({
        choices: [{
            message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
            },
            finish_reason: "tool_calls",
        }],
        usage: USAGE,
    });
}

export function openaiStream(pieces: string[]): Response {
    const events = pieces.map((text) => JSON.stringify({ choices: [{ delta: { content: text } }] }));
    events.push(JSON.stringify({ choices: [], usage: USAGE }));
    events.push(JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }));
    events.push("[DONE]");
    return sse(events);
}

// ─── Anthropic ───────────────────────────────────────────────────────────

export function anthropicText(text: string, stopReason = "end_turn"): Response {
    return Response.json({
        content: [{ type: "text", text }],
        stop_reason: stopReason,
        usage: A_USAGE,
    });
}

export function anthropicTool(name: string, input: any, id = "toolu_1"): Response {
    return Response.json({
        content: [{ type: "tool_use", id, name, input }],
        stop_reason: "tool_use",
        usage: A_USAGE,
    });
}

export function anthropicStream(pieces: string[]): Response {
    const events: string[] = [
        JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 9, output_tokens: 0 } } }),
        JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ];
    for (const text of pieces) {
        events.push(JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }));
    }
    events.push(JSON.stringify({ type: "content_block_stop", index: 0 }));
    events.push(JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }));
    events.push(JSON.stringify({ type: "message_stop" }));
    return sse(events);
}
