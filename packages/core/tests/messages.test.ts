import { describe, it, expect } from "bun:test";
import { normalizeMessages } from "../lib/messages";
import { MAX_FILE_BYTES } from "../lib/attachment";

/**
 * Remote files (`file: { url }`) are fetched server-side: only **public HTTPS**
 * targets are accepted (issue #30). `fetch` is stubbed — no network in the suite.
 */
function stubFetch(handler: (url: string) => Response | Promise<Response>): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: any) => handler(String(input))) as unknown as typeof fetch;
    return () => { globalThis.fetch = original; };
}

const first = async (input: any) => (await normalizeMessages(input))[0] as any;

describe("normalizeMessages — the shapes it accepts", () => {
    it("turns a string into one user turn", async () => {
        expect(await normalizeMessages("hi")).toEqual([{ role: "user", content: "hi" }]);
    });

    it("accepts a single message — with or without an array", async () => {
        const message = { role: "user", content: "hi" } as const;
        expect(await normalizeMessages(message)).toEqual([{ role: "user", content: "hi" }]);
        expect(await normalizeMessages([message])).toEqual([{ role: "user", content: "hi" }]);
    });

    it("keeps a whole conversation in order", async () => {
        const messages = await normalizeMessages([
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
            { role: "user", content: "and?" },
        ]);
        expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
        expect((messages[1] as any).content).toBe("hello");
    });

    it("keeps only the canonical fields — a stray key never reaches the wire", async () => {
        const [message] = await normalizeMessages([{ role: "user", content: "hi", threadId: "t", bogus: 1 } as any]);
        expect(message).toEqual({ role: "user", content: "hi" });
    });
});

describe("normalizeMessages — content parts", () => {
    it("keeps text, image and file parts, url or base64", async () => {
        const [message] = await normalizeMessages([{
            role: "user",
            content: [
                { type: "text", text: "look" },
                { type: "image", url: "https://example.com/a.png" },
                { type: "image", data: "AAAA", mimeType: "image/png" },
                { type: "file", name: "a.pdf", data: "BBBB", mimeType: "application/pdf" },
            ],
        }] as any);

        expect((message as any).content).toEqual([
            { type: "text", text: "look" },
            { type: "image", url: "https://example.com/a.png" },
            { type: "image", mimeType: "image/png", data: "AAAA" },
            { type: "file", name: "a.pdf", mimeType: "application/pdf", data: "BBBB" },
        ]);
    });

    it("joins a system message written as parts", async () => {
        const [message] = await normalizeMessages([
            { role: "system", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
        ] as any);
        expect(message).toEqual({ role: "system", content: "a\nb" });
    });

    it("downloads a public HTTPS file and inlines it as base64", async () => {
        const restore = stubFetch(() => new Response("%PDF-1.7 payload", {
            headers: { "Content-Type": "application/pdf" },
        }));
        try {
            const [message] = await normalizeMessages([
                { role: "user", content: [{ type: "file", url: "https://8.8.8.8/report.pdf", name: "invoice.pdf" }] },
            ] as any);

            const part: any = (message as any).content[0];
            expect(part.type).toBe("file");
            expect(part.name).toBe("invoice.pdf");
            // The URL is gone — the payload travels as base64, which every provider takes
            expect(part.url).toBeUndefined();
            expect(Buffer.from(part.data, "base64").toString()).toBe("%PDF-1.7 payload");
        } finally {
            restore();
        }
    });

    it("refuses remote files that are not public HTTPS (SSRF)", async () => {
        const cases = [
            "http://8.8.8.8/report.pdf",             // plain HTTP
            "https://127.0.0.1/report.pdf",          // loopback
            "https://10.0.0.1/report.pdf",           // RFC1918
            "https://172.16.0.1/report.pdf",         // RFC1918
            "https://192.168.1.1/report.pdf",        // RFC1918
            "https://169.254.169.254/latest",        // cloud metadata
            "https://[::1]/report.pdf",              // IPv6 loopback
            "https://[fe80::1]/report.pdf",          // IPv6 link-local
            "https://localhost/report.pdf",          // resolves to loopback
            "https://user:pass@8.8.8.8/report.pdf",  // credentials in the URL
        ];
        for (const url of cases) {
            const error: any = await normalizeMessages([
                { role: "user", content: [{ type: "file", url, name: "x.pdf" }] },
            ] as any).catch((err) => err);
            expect({ url, code: error.code }).toEqual({ url, code: "AGENT_FILE_INVALID" });
        }
    });

    it("refuses a redirect that lands on a private address", async () => {
        const restore = stubFetch(() => new Response(null, {
            status: 302,
            headers: { location: "https://127.0.0.1/secret.pdf" },
        }));
        try {
            const error: any = await normalizeMessages([
                { role: "user", content: [{ type: "file", url: "https://8.8.8.8/report.pdf", name: "x.pdf" }] },
            ] as any).catch((err) => err);
            expect(error.code).toBe("AGENT_FILE_INVALID");
        } finally {
            restore();
        }
    });

    it("reports an unreachable remote file without echoing the network error", async () => {
        const restore = stubFetch(() => new Response("nope", { status: 404 }));
        try {
            const error: any = await normalizeMessages([
                { role: "user", content: [{ type: "file", url: "https://8.8.8.8/missing.pdf", name: "x.pdf" }] },
            ] as any).catch((err) => err);
            expect(error.code).toBe("AGENT_FILE_NOT_FOUND");
            expect(error.message).not.toContain("404");
        } finally {
            restore();
        }
    });

    it("leaves a remote image as a URL — the provider fetches it", async () => {
        const message: any = await first([{ role: "user", content: [{ type: "image", url: "https://example.com/a.png" }] }]);
        expect(message.content[0].url).toBe("https://example.com/a.png");
        expect(message.content[0].data).toBeUndefined();
    });

    it("refuses a part without a payload, an unknown address, or an unsupported scheme", async () => {
        const cases = [
            [{ type: "image" }],
            [{ type: "file", name: "a.pdf" }],
            [{ type: "image", url: "ftp://example.com/a.png" }],
            [{ type: "image", url: "./local.png" }],
        ];
        for (const content of cases) {
            const error: any = await normalizeMessages([{ role: "user", content }] as any).catch((err) => err);
            expect(error.code).toBe("INVALID_INPUT");
        }
    });

    it("refuses a streamed remote file that is too large", async () => {
        const body = new Uint8Array(MAX_FILE_BYTES + 1);
        const restore = stubFetch(() => new Response(new ReadableStream({
            start(controller) { controller.enqueue(body); controller.close(); },
        })));
        try {
            const error: any = await normalizeMessages([
                { role: "user", content: [{ type: "file", url: "https://8.8.8.8/huge.pdf", name: "huge.pdf" }] },
            ] as any).catch((err) => err);
            expect(error.code).toBe("AGENT_FILE_TOO_LARGE");
        } finally {
            restore();
        }
    });
});

describe("normalizeMessages — tool parts", () => {
    it("hoists `tool-call` parts onto the assistant message", async () => {
        const [message] = await normalizeMessages([{
            role: "assistant",
            content: [{ type: "tool-call", id: "call_1", name: "forecast", arguments: { city: "Paris" } }],
        }] as any);

        expect(message).toEqual({
            role: "assistant",
            content: null,
            toolCalls: [{ id: "call_1", name: "forecast", args: { city: "Paris" } }],
        });
    });

    it("merges inline calls with the ones declared as `toolCalls`", async () => {
        const [message] = await normalizeMessages([{
            role: "assistant",
            content: [{ type: "text", text: "let me check" }, { type: "tool-call", id: "b", name: "two" }],
            toolCalls: [{ id: "a", name: "one", args: {} }],
        }] as any) as any[];

        expect(message.content).toBe("let me check");
        expect(message.toolCalls.map((call: any) => call.id)).toEqual(["a", "b"]);
    });

    it("keeps a raw `argsText` when the caller had one", async () => {
        const [message] = await normalizeMessages([{
            role: "assistant",
            content: [{ type: "tool-call", id: "c", name: "f", argsText: '{"city":"Lyon"}', arguments: { city: "Lyon" } }],
        }] as any) as any[];
        expect(message.toolCalls[0]).toEqual({ id: "c", name: "f", args: { city: "Lyon" }, argsText: '{"city":"Lyon"}' });
    });

    it("turns a `tool-result` part into the `tool` message it means", async () => {
        const messages = await normalizeMessages([{
            role: "user",
            content: [
                { type: "text", text: "and?" },
                { type: "tool-result", id: "call_1", name: "forecast", result: { celsius: 21 } },
                { type: "tool-result", id: "call_2", name: "boom", error: "timeout" },
            ],
        }] as any) as any[];

        expect(messages.map((message) => message.role)).toEqual(["user", "tool", "tool"]);
        expect(messages[0].content).toEqual([{ type: "text", text: "and?" }]);
        expect(messages[1]).toEqual({
            role: "tool", toolCallId: "call_1", name: "forecast", content: '{"celsius":21}',
        });
        expect(messages[2]).toEqual({
            role: "tool", toolCallId: "call_2", name: "boom", content: "Error: timeout", isError: true,
        });
    });

    it("expands a `tool` message carrying several results", async () => {
        const messages = await normalizeMessages([{
            role: "tool",
            content: [
                { type: "tool-result", id: "a", result: "one" },
                { type: "tool-result", id: "b", result: "two" },
            ],
        }] as any) as any[];

        expect(messages).toEqual([
            { role: "tool", toolCallId: "a", name: "tool", content: "one" },
            { role: "tool", toolCallId: "b", name: "tool", content: "two" },
        ]);
    });

    it("keeps a `tool` message written the classic way", async () => {
        const [message] = await normalizeMessages([
            { role: "tool", toolCallId: "call_1", name: "forecast", content: "21°C" },
        ] as any);
        expect(message).toEqual({ role: "tool", toolCallId: "call_1", name: "forecast", content: "21°C" });
    });
});

describe("normalizeMessages — what it refuses", () => {
    it("refuses an unknown role and a message without one", async () => {
        for (const input of [[{ role: "robot", content: "hi" }], [{ content: "hi" }], [null]]) {
            const error: any = await normalizeMessages(input as any).catch((err) => err);
            expect(error.code).toBe("INVALID_INPUT");
            expect(error.status).toBe(400);
        }
    });

    it("refuses a part the role cannot carry", async () => {
        const cases: any[] = [
            [{ role: "user", content: [{ type: "tool-call", id: "a", name: "f" }] }],
            [{ role: "assistant", content: [{ type: "image", url: "https://example.com/a.png" }] }],
            [{ role: "system", content: [{ type: "image", url: "https://example.com/a.png" }] }],
            [{ role: "tool", content: [{ type: "text", text: "no" }] }],
            [{ role: "tool", content: "orphan" }], // no `toolCallId`
            [{ role: "user", content: [{ type: "tool-result" }] }], // no id
        ];
        for (const input of cases) {
            const error: any = await normalizeMessages(input as any).catch((err) => err);
            expect(error.code).toBe("INVALID_INPUT");
        }
    });

    it("refuses a message without content", async () => {
        for (const role of ["user", "system", "tool"]) {
            const error: any = await normalizeMessages([{ role }] as any).catch((err) => err);
            expect(error.code).toBe("INVALID_INPUT");
        }
    });

    it("refuses an empty content array rather than sending an empty turn", async () => {
        for (const input of [
            [{ role: "user", content: [] }],
            [{ role: "tool", content: [] }],
            [{ role: "developer", content: [] }],
        ]) {
            const error: any = await normalizeMessages(input as any).catch((err) => err);
            expect(error.code).toBe("INVALID_INPUT");
        }

        // An assistant turn with no text is legitimate — a tool call carries the turn
        expect(await normalizeMessages([{ role: "assistant", content: [] }] as any))
            .toEqual([{ role: "assistant", content: null }]);
    });
});

describe("normalizeMessages — developer role and names", () => {
    it("keeps the `developer` role and a message name", async () => {
        const messages = await normalizeMessages([
            { role: "developer", content: "answer concisely", name: "policy" },
            { role: "user", content: "hi", name: "ada" },
        ] as any);

        expect(messages[0]).toEqual({ role: "developer", content: "answer concisely", name: "policy" });
        expect(messages[1]).toEqual({ role: "user", content: "hi", name: "ada" });
    });

    it("keeps the raw thinking blocks of a replayed assistant turn", async () => {
        const thinking = [{ type: "thinking", thinking: "…", signature: "sig" }];
        const [message] = await normalizeMessages([{ role: "assistant", content: "done", thinking }] as any) as any[];
        expect(message.thinking).toEqual(thinking);
    });
});
