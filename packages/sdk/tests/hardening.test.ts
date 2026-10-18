import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Anteros, Rest } from "../index";
import { MAX_UPLOAD_BYTES } from "../utils";
import { AsyncQueue, sseData } from "../lib/stream";

/** Regression tests for the SDK hardening: token scope, URL encoding, transport options. */

const originalFetch = globalThis.fetch;
let lastUrl = "";
let lastInit: RequestInit | undefined;

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    lastUrl = "";
    lastInit = undefined;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
        lastUrl = String(input);
        lastInit = init;
        return handler(lastUrl, init);
    }) as unknown as typeof fetch;
}

beforeEach(() => {
    stubFetch(() => Response.json({ ok: true }));
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    delete (globalThis as any).localStorage;
});

describe("token storage is scoped to server + tenant (#A)", () => {
    it("does not leak a token between tenants or servers", () => {
        const store = new Map<string, string>();
        (globalThis as any).localStorage = {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => void store.set(key, value),
            removeItem: (key: string) => void store.delete(key),
        };

        const a = new Anteros({ server: "https://api.test", tenant: "t1" });
        a.setToken("token-a");

        expect(new Anteros({ server: "https://api.test", tenant: "t2" }).getToken()).toBeUndefined();
        expect(new Anteros({ server: "https://other.test", tenant: "t1" }).getToken()).toBeUndefined();
        expect(new Anteros({ server: "https://api.test", tenant: "t1" }).getToken()).toBe("token-a");

        // Clearing removes only that tenant's entry
        a.clearToken();
        expect(new Anteros({ server: "https://api.test", tenant: "t1" }).getToken()).toBeUndefined();
    });

    it("does not throw when storage is denied (private mode / quota)", () => {
        (globalThis as any).localStorage = {
            getItem: () => { throw new Error("denied"); },
            setItem: () => { throw new Error("denied"); },
            removeItem: () => { throw new Error("denied"); },
        };

        const client = new Anteros({ server: "https://api.test", tenant: "t1" });
        expect(() => client.setToken("token")).not.toThrow();
        expect(() => client.clearToken()).not.toThrow();
        expect(client.getToken()).toBeUndefined();
    });
});

describe("URL segments are encoded (#B)", () => {
    it("encodes collection, agent, service and action segments", async () => {
        const api = new Anteros({ server: "https://api.test", tenant: "a b", token: { persist: false } });

        await api.collection("a b/c?d#e").find({});
        expect(lastUrl).toContain("/api/a%20b/collections/a%20b%2Fc%3Fd%23e/find");

        await api.agent("a/b").info();
        expect(lastUrl).toContain("/agents/a%2Fb/info");

        await api.service("pay/ments").run("ch arge");
        expect(lastUrl).toContain("/services/pay%2Fments/ch%20arge");
    });

    it("encodes file names, without double-encoding the server URL", () => {
        const files = new Anteros({ server: "https://api.test", tenant: "v1", token: { persist: false } }).files;
        expect(files.url("photos", "a b#c.png")).toBe("https://api.test/api/v1/files/photos/a%20b%23c.png");
        expect(files.url("photos", "a b.png", { width: 100 })).toBe("https://api.test/api/v1/files/photos/a%20b.png?w=100");
    });
});

describe("upload metadata is serialized, not stringified blindly (#C)", () => {
    it("sends JSON for objects/arrays and ISO for dates", async () => {
        const api = new Anteros({ server: "https://api.test", tenant: "v1", token: { persist: false } });

        await api.files.upload("photos", new File(["PNG"], "x.png", { type: "image/png" }), {
            tags: ["a", "b"],
            meta: { a: 1 },
            when: new Date("2026-01-01T00:00:00.000Z"),
            count: 2,
            active: true,
        });

        const form = lastInit!.body as FormData;
        expect(form.get("tags")).toBe('["a","b"]');
        expect(form.get("meta")).toBe('{"a":1}');
        expect(form.get("when")).toBe("2026-01-01T00:00:00.000Z");
        expect(form.get("count")).toBe("2");
        expect(form.get("active")).toBe("true");
    });

    it("refuses an upload over the 100MB allowance before sending it", async () => {
        const api = new Anteros({ server: "https://api.test", tenant: "v1", token: { persist: false } });

        // A Blob-like size is enough: the guard runs before the FormData is built.
        const error: any = await api.files.upload("photos", { size: MAX_UPLOAD_BYTES + 1 } as any).catch((err) => err);
        expect(error.code).toBe("SDK_UPLOAD_TOO_LARGE");
        expect(lastUrl).toBe(""); // nothing was sent
    });
});

describe("transport options (#D, #E, #G)", () => {
    it("forwards `credentials` to fetch", async () => {
        const api = new Anteros({ server: "https://api.test", tenant: "v1", credentials: "include", token: { persist: false } });
        await api.collection("orders").find({});
        expect(lastInit!.credentials).toBe("include");
    });

    it("applies a timeout and reports SDK_TIMEOUT", async () => {
        globalThis.fetch = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => {
                const error = new Error("timeout");
                error.name = "TimeoutError";
                reject(error);
            });
        })) as unknown as typeof fetch;

        const api = new Anteros({ server: "https://api.test", tenant: "v1", timeoutMs: 10, token: { persist: false } });
        const error: any = await api.collection("orders").find({}).catch((err) => err);
        expect(error.code).toBe("SDK_TIMEOUT");
    });

    it("never lets a global Content-Type break a multipart upload", async () => {
        const api = new Anteros({ server: "https://api.test", tenant: "v1", token: { persist: false } });
        api.setHeader("Content-Type", "application/json");
        await api.files.upload("photos", new File(["PNG"], "x.png", { type: "image/png" }));

        const headers = lastInit!.headers as Record<string, string>;
        expect(Object.keys(headers).some((key) => key.toLowerCase() === "content-type")).toBe(false);
        expect(lastInit!.body).toBeInstanceOf(FormData);
    });
});

describe("client-side guards (#3)", () => {
    it("refuses a non-operator update before sending it", async () => {
        const api = new Anteros({ server: "https://api.test", tenant: "v1", token: { persist: false } });
        const users = api.collection("users");

        for (const update of [{ name: "x" }, {}, [], { $rename: { name: "role" } }]) {
            const error: any = await users.updateOne("id1", update as any).catch((err) => err);
            expect({ update, code: error.code }).toEqual({ update, code: "SDK_INVALID_UPDATE" });
        }
        expect(lastUrl).toBe("");

        await users.updateOne("id1", { $set: { name: "x" } });
        expect(lastUrl).toContain("/collections/users/updateOne");
    });

    it("refuses a non-string login token", async () => {
        stubFetch(() => Response.json({ token: 42, data: {} }));

        const api = new Anteros({ server: "https://api.test", tenant: "v1", token: { persist: false } });
        const error: any = await api.collection("users").login({ email: "a@b.c" }).catch((err) => err);
        expect(error.code).toBe("SDK_INVALID_LOGIN");

        const flat = new Rest({ server: "https://api.test", tenant: "v1", token: { persist: false } });
        const flatError: any = await flat.login("users", { email: "a@b.c" }).catch((err) => err);
        expect(flatError.code).toBe("SDK_INVALID_LOGIN");
    });

    it("surfaces an oversized response instead of buffering it", async () => {
        stubFetch(() => new Response("x", {
            headers: { "content-type": "application/json", "content-length": String(6 * 1024 * 1024) },
        }));

        const api = new Anteros({ server: "https://api.test", tenant: "v1", token: { persist: false } });
        const error: any = await api.collection("orders").find({}).catch((err) => err);
        expect(error.code).toBe("SDK_RESPONSE_TOO_LARGE");
    });

    it("does not throw a SyntaxError on an invalid JSON response", async () => {
        stubFetch(() => new Response("not json", { headers: { "content-type": "application/json" } }));

        const api = new Anteros({ server: "https://api.test", tenant: "v1", token: { persist: false } });
        const result: any = await api.collection("orders").find({});
        expect(result).toBe("not json");
    });
});

describe("stream bounds (#3)", () => {
    it("fails an AsyncQueue that grows past its limit", async () => {
        const queue = new AsyncQueue<number>(2);
        queue.push(1);
        queue.push(2);
        queue.push(3);

        expect(await queue.next()).toEqual({ value: 1, done: false });
        expect(await queue.next()).toEqual({ value: 2, done: false });
        const error: any = await queue.next().catch((err) => err);
        expect(error.code).toBe("SDK_STREAM_OVERFLOW");
    });

    it("refuses an SSE event larger than 1MB", async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("x".repeat(1_000_001)));
                controller.close();
            },
        });

        const error: any = await (async () => {
            for await (const _ of sseData(stream)) { /* consume */ }
        })().catch((err) => err);
        expect(error.code).toBe("SDK_STREAM_INVALID");
    });
});
