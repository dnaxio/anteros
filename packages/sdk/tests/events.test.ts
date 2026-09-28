/**
 * What a client **reports** — `api.on('error')` / `api.on('unauthorized')`.
 *
 * The point of these listeners is that no call site has to remember to catch: a dead
 * token is noticed once, wherever it happens, and the same error object still reaches
 * the `await` that triggered it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Anteros, Rest } from "../index";
import type { AnterosError } from "../types/rest";

let server: any;
let base = "";
let hits: string[] = [];

beforeAll(() => {
    server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: async (req) => {
            const url = new URL(req.url);
            hits.push(url.pathname);

            if (url.pathname.includes("/collections/secret/") || url.pathname.includes("/vars/") || url.pathname.includes("/services/")) {
                return Response.json(
                    { message: "The token has expired", code: "INVALID_TOKEN", meta: { expired: true } },
                    { status: 401 },
                );
            }
            if (url.pathname.includes("/collections/boom/")) {
                return Response.json({ message: "Server exploded", code: "INTERNAL_SERVER_ERROR" }, { status: 500 });
            }
            if (url.pathname.includes("/collections/slow/")) {
                await Bun.sleep(200);
                return Response.json({ ok: true });
            }
            if (url.pathname.includes("/agents/support/generate")) {
                return Response.json(
                    { message: "The token has expired", code: "INVALID_TOKEN", meta: { expired: true } },
                    { status: 401 },
                );
            }
            if (url.pathname.includes("/agents/support/stream")) {
                // A failure that only exists **after** the headers: an SSE event
                return new Response(
                    'data: {"type":"error","message":"The agent stream failed","code":"AGENT_STREAM_FAILED"}\n\n',
                    { headers: { "Content-Type": "text/event-stream" } },
                );
            }
            return Response.json({ ok: true });
        },
    });
    base = server.url.href.replace(/\/$/, "");
});

afterAll(() => {
    try { server.stop(true); } catch (_) { /* already stopped */ }
});

beforeEach(() => {
    hits = [];
});

const api = () => new Anteros({ server: base, tenant: "v1", token: { persist: false } });

/** Every error / unauthorized event, in order. */
function record(client: Anteros | Rest) {
    const seen: Array<{ event: string; error: AnterosError }> = [];
    client.on("error", (error) => seen.push({ event: "error", error }));
    client.on("unauthorized", (error) => seen.push({ event: "unauthorized", error }));
    return seen;
}

describe("sdk events — errors", () => {
    it("reports the server error, and still throws it", async () => {
        const client = api();
        const seen = record(client);

        const thrown: any = await client.collection("boom").find().catch((err) => err);

        // Same object on both sides: the listener is not a replacement for `catch`
        expect(seen).toHaveLength(1);
        expect(seen[0]!.event).toBe("error");
        expect(seen[0]!.error).toBe(thrown);
        expect(thrown.code).toBe("INTERNAL_SERVER_ERROR");
        expect(thrown.status).toBe(500);
    });

    it("reports a 401 as both `error` and `unauthorized`", async () => {
        const client = api();
        const seen = record(client);

        await client.collection("secret").find().catch(() => {});

        expect(seen.map((entry) => entry.event)).toEqual(["error", "unauthorized"]);
        expect(seen[1]!.error.code).toBe("INVALID_TOKEN");
        expect(seen[1]!.error.status).toBe(401);
        expect(seen[1]!.error.meta).toEqual({ expired: true });
    });

    it("does not call a 500 unauthorized", async () => {
        const client = api();
        const unauthorized: any[] = [];
        client.on("unauthorized", (error) => unauthorized.push(error));

        await client.collection("boom").find().catch(() => {});

        expect(unauthorized).toEqual([]);
    });

    it("covers every surface of the client, namespaced ones included", async () => {
        const client = api();
        const seen = record(client);

        await client.collection("secret").find().catch(() => {});
        await client.vars.get("config", "licence").catch(() => {});
        await client.service("billing").run("report", {}).catch(() => {});
        await client.agent("support").generate("hi").catch(() => {});

        // The listeners live on the client, whatever object the call came from
        expect(seen.filter((entry) => entry.event === "error")).toHaveLength(4);
    });

    it("reports a stream that fails after its headers", async () => {
        const client = api();
        const seen = record(client);

        const stream = await client.agent("support").stream("hi");
        const thrown: any = await (async () => {
            try {
                for await (const _chunk of stream.textStream) { /* nothing */ }
            } catch (err) {
                return err;
            }
        })();

        expect(thrown.code).toBe("AGENT_STREAM_FAILED");
        expect(seen.map((entry) => entry.error.code)).toContain("AGENT_STREAM_FAILED");
    });

    it("gives a network failure a stable code, with the cause", async () => {
        const client = new Anteros({ server: "http://127.0.0.1:9", tenant: "v1", token: { persist: false } });
        const seen = record(client);

        const thrown: any = await client.collection("orders").find().catch((err) => err);

        expect(thrown.code).toBe("SDK_NETWORK_ERROR");
        expect(thrown.cause).toBeDefined();
        expect(seen[0]!.error.code).toBe("SDK_NETWORK_ERROR");
    }, 20_000);

    it("says nothing when the caller aborts — cancelling is not a failure", async () => {
        const client = api();
        const seen = record(client);
        const controller = new AbortController();

        const pending = client.collection("slow").find({}, { signal: controller.signal }).catch((err) => err);
        setTimeout(() => controller.abort(), 10);
        const thrown: any = await pending;

        expect(thrown.name).toBe("AbortError");
        expect(seen).toEqual([]);
    });

    it("survives a listener that throws", async () => {
        const client = api();
        client.on("error", () => {
            throw new Error("this listener is broken");
        });
        const seen = record(client);

        const thrown: any = await client.collection("boom").find().catch((err) => err);

        expect(thrown.code).toBe("INTERNAL_SERVER_ERROR");
        expect(seen).toHaveLength(1); // the broken one did not stop the others
    });
});

describe("sdk events — registering", () => {
    it("removes a listener with `off`, and them all without one", async () => {
        const client = api();
        const first: any[] = [];
        const second: any[] = [];
        const onFirst = (error: AnterosError) => first.push(error);
        client.on("error", onFirst).on("error", (error) => second.push(error));

        expect(client.listenerCount("error")).toBe(2);

        client.off("error", onFirst);
        await client.collection("boom").find().catch(() => {});
        expect(first).toHaveLength(0);
        expect(second).toHaveLength(1);

        client.off("error");
        await client.collection("boom").find().catch(() => {});
        expect(second).toHaveLength(1);
        expect(client.listenerCount("error")).toBe(0);
        // …and removing them all left the other event alone
        expect(client.listenerCount("unauthorized")).toBe(0);
    });

    it("runs a `once` listener a single time", async () => {
        const client = api();
        const seen: any[] = [];
        client.once("error", (error) => seen.push(error));

        await client.collection("boom").find().catch(() => {});
        await client.collection("boom").find().catch(() => {});

        expect(seen).toHaveLength(1);
    });

    it("refuses an unknown event rather than registering a listener that never fires", () => {
        const client = api();
        expect(() => (client as any).on("errr", () => {})).toThrow(/Unknown SDK event 'errr'/);
    });

    it("works the same on the original flat client", async () => {
        const client = new Rest({ server: base, tenant: "v1", token: { persist: false } });
        const seen = record(client);

        await client.find("secret", {}).catch(() => {});

        expect(seen.map((entry) => entry.event)).toEqual(["error", "unauthorized"]);
    });
});
