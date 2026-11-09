import { afterEach, expect, test } from "bun:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { proxyRequest } from "../lib/proxy";
import type { RouteMatch } from "../lib/router";

const microservice = { name: "pharmacie", upstream: "http://127.0.0.1:1", cors: null };
let server: ReturnType<typeof Bun.serve> | undefined;
let received: { method: string; headers: Headers; body: string } | undefined;

function start(fetch: (req: Request) => Response | Promise<Response>): string {
    server = Bun.serve({ port: 0, fetch });
    return server.url.origin;
}

function match(upstream: string): RouteMatch {
    return { microservice: { ...microservice, upstream }, path: "/api/pharmacie/echo" };
}

afterEach(() => {
    server?.stop(true);
    server = undefined;
    received = undefined;
});

test("forwards method, body, authorization and tracing headers", async () => {
    const upstream = start(async (req) => {
        received = { method: req.method, headers: req.headers, body: await req.text() };
        return Response.json({ ok: true });
    });

    const request = new Request("http://gateway/api/pharmacie/echo?x=1", {
        method: "POST",
        headers: {
            authorization: "Bearer token",
            "content-type": "application/json",
            "te": "trailers",
            "upgrade": "h2c",
        },
        body: JSON.stringify({ hello: "world" }),
    });

    const response = await proxyRequest(request, match(upstream), {
        timeoutMs: 1000,
        requestId: "req-1",
        clientIp: "127.0.0.1",
    });

    expect(response.status).toBe(200);
    expect(received?.method).toBe("POST");
    expect(received?.body).toBe('{"hello":"world"}');
    expect(received?.headers.get("authorization")).toBe("Bearer token");
    expect(received?.headers.get("te")).toBeNull();
    expect(received?.headers.get("upgrade")).toBeNull();
    expect(received?.headers.get("x-request-id")).toBe("req-1");
    expect(received?.headers.get("x-forwarded-for")).toContain("127.0.0.1");
});

test("keeps a compressed upstream body and its content-encoding", async () => {
    const upstream = start(
        () =>
            new Response(gzipSync("hello"), {
                headers: { "content-encoding": "gzip", "content-type": "text/plain" },
            }),
    );

    const response = await proxyRequest(new Request("http://gateway/api/pharmacie/echo"), match(upstream), {
        timeoutMs: 1000,
        requestId: "req-2",
    });

    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(await response.bytes()).toString()).toBe("hello");
});

test("preserves multiple Set-Cookie headers", async () => {
    const upstream = start(() => {
        const headers = new Headers();
        headers.append("set-cookie", "a=1; Path=/");
        headers.append("set-cookie", "b=2; Path=/");
        return new Response("ok", { headers });
    });

    const response = await proxyRequest(new Request("http://gateway/api/pharmacie/echo"), match(upstream), {
        timeoutMs: 1000,
        requestId: "req-3",
    });

    expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
});

test("streams the request body without buffering", async () => {
    const upstream = start(async (req) => {
        received = { method: req.method, headers: req.headers, body: await req.text() };
        return new Response("ok");
    });

    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode("part1"));
            controller.enqueue(new TextEncoder().encode("part2"));
            controller.close();
        },
    });
    const request = new Request("http://gateway/api/pharmacie/echo", {
        method: "POST",
        body,
        duplex: "half",
    } as RequestInit);

    await proxyRequest(request, match(upstream), { timeoutMs: 1000, requestId: "req-4" });
    expect(received?.body).toBe("part1part2");
});

test("does not touch an event-stream body", async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const upstream = start(
        () =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode("data: one\n\n"));
                        timer = setTimeout(() => {
                            try {
                                controller.enqueue(new TextEncoder().encode("data: two\n\n"));
                                controller.close();
                            } catch {
                                // The client went away; the stream is already closed.
                            }
                        }, 100);
                    },
                    cancel() {
                        if (timer) clearTimeout(timer);
                    },
                }),
                { headers: { "content-type": "text/event-stream" } },
            ),
    );

    const response = await proxyRequest(new Request("http://gateway/api/pharmacie/events"), match(upstream), {
        timeoutMs: 5000,
        requestId: "req-5",
    });
    const reader = response.body!.getReader();
    const first = await reader.read();

    expect(new TextDecoder().decode(first.value)).toBe("data: one\n\n");
    await reader.cancel();
});

test("forwards 204 with a null body", async () => {
    const upstream = start(() => new Response(null, { status: 204 }));
    const response = await proxyRequest(new Request("http://gateway/api/pharmacie/echo"), match(upstream), {
        timeoutMs: 1000,
        requestId: "req-6",
    });

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
});

test("maps connection failures to 502 and header timeouts to 504", async () => {
    const unreachable = await proxyRequest(
        new Request("http://gateway/api/pharmacie/echo"),
        match("http://127.0.0.1:1"),
        { timeoutMs: 1000, requestId: "req-7" },
    );
    expect(unreachable.status).toBe(502);

    const slow = start(async () => {
        await Bun.sleep(200);
        return new Response("late");
    });
    const timedOut = await proxyRequest(new Request("http://gateway/api/pharmacie/echo"), match(slow), {
        timeoutMs: 50,
        requestId: "req-8",
    });
    expect(timedOut.status).toBe(504);
});
