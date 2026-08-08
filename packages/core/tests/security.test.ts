import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createMemoryStore, createRedisStore, rateLimit } from "../server/security";

// ─── createMemoryStore ───────────────────────────────────────────────────

describe("createMemoryStore", () => {
    it("increments within a window", async () => {
        const store = createMemoryStore();
        expect((await store.increment("k", 60_000)).count).toBe(1);
        expect((await store.increment("k", 60_000)).count).toBe(2);
        store.dispose();
    });

    it("resets after the window expires", async () => {
        const store = createMemoryStore();
        await store.increment("k", 1);
        expect((await store.increment("k", 1)).count).toBe(2);
        // window (1ms) expired → resets to 1
        await Bun.sleep(5);
        const r = await store.increment("k", 1);
        expect(r.count).toBe(1);
        store.dispose();
    });
});

// ─── createRedisStore (mocked RedisClient) ───────────────────────────────

describe("createRedisStore", () => {
    it("uses incr / pexpire / pttl", async () => {
        const calls: string[] = [];
        const mock: any = {
            incr: async (k: string) => { calls.push(`incr:${k}`); return 1; },
            pexpire: async (k: string, ms: number) => { calls.push(`pexpire:${k}:${ms}`); return 1; },
            pttl: async (k: string) => { calls.push(`pttl:${k}`); return 4000; },
        };
        const store = createRedisStore(mock);
        const r = await store.increment("key", 60_000);
        expect(r.count).toBe(1);
        expect(r.resetAt).toBeGreaterThan(Date.now());
        expect(calls).toContain("incr:key");
        expect(calls).toContain("pexpire:key:60000");
        expect(calls).toContain("pttl:key");
    });

    it("only sets expiry on the first increment of a window", async () => {
        let incrCount = 0;
        let pexpireCalls = 0;
        const mock: any = {
            incr: async () => ++incrCount,
            pexpire: async () => { pexpireCalls++; return 1; },
            pttl: async () => 5000,
        };
        const store = createRedisStore(mock);
        await store.increment("k", 1000); // count=1 → pexpire
        await store.increment("k", 1000); // count=2 → no pexpire
        expect(pexpireCalls).toBe(1);
    });
});

// ─── rateLimit middleware ────────────────────────────────────────────────

describe("rateLimit middleware", () => {
    it("adds headers and blocks with 429 + Retry-After", async () => {
        const app = new Hono();
        app.use(rateLimit({ windowMs: 60_000, max: 2 }));
        app.get("/", (c) => c.text("ok"));

        const r1 = await app.request("/");
        expect(r1.headers.get("X-RateLimit-Limit")).toBe("2");
        expect(r1.headers.get("X-RateLimit-Remaining")).toBe("1");

        await app.request("/");
        const r3 = await app.request("/");
        expect(r3.status).toBe(429);
        expect(r3.headers.get("Retry-After")).toBeTruthy();
        const body: any = await r3.json();
        expect(body.code).toBe("RATE_LIMIT_EXCEEDED");
    });

    it("respects a custom keyGenerator", async () => {
        const app = new Hono();
        app.use(rateLimit({ windowMs: 60_000, max: 1, keyGenerator: () => "fixed-key" }));
        app.get("/", (c) => c.text("ok"));
        await app.request("/");
        expect((await app.request("/")).status).toBe(429);
    });

    it("uses a shared Redis store when provided", async () => {
        const calls: string[] = [];
        const store = createRedisStore({
            incr: async (k: string) => { calls.push(`incr:${k}`); return 5; },
            pexpire: async () => 1,
            pttl: async () => 3000,
        } as any);
        const app = new Hono();
        app.use(rateLimit({ windowMs: 60_000, max: 2, store }));
        app.get("/", (c) => c.text("ok"));
        await app.request("/");
        expect(calls.some((c) => c.startsWith("incr:"))).toBe(true);
    });
});
