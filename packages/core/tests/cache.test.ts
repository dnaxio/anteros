import { describe, it, expect, beforeEach } from "bun:test";
import { Cache, useMemoryCache, useFilesystemCache } from "../utils/cache";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Cache (memory)", () => {
    let c: Cache;

    beforeEach(() => {
        c = useMemoryCache();
    });

    it("set + get round-trip", async () => {
        await c.set({ key: "k", value: { id: 1 }, ttl: "5m" });
        expect(await c.get({ key: "k" })).toEqual({ id: 1 });
    });

    it("setForever never expires", async () => {
        await c.setForever({ key: "cfg", value: { theme: "dark" } });
        expect(await c.get({ key: "cfg" })).toEqual({ theme: "dark" });
    });

    it("get returns null on miss", async () => {
        expect(await c.get({ key: "nope" })).toBeNull();
    });

    it("has / missing", async () => {
        await c.set({ key: "a", value: 1 });
        expect(await c.has({ key: "a" })).toBe(true);
        expect(await c.missing({ key: "a" })).toBe(false);
        expect(await c.missing({ key: "b" })).toBe(true);
    });

    it("ttl expiry (ms)", async () => {
        await c.set({ key: "x", value: 1, ttl: 50 });
        expect(await c.get({ key: "x" })).toBe(1);
        await sleep(80);
        expect(await c.get({ key: "x" })).toBeNull();
    });

    it("getOrSet uses factory and caches", async () => {
        let calls = 0;
        const factory = async () => {
            calls++;
            return { n: calls };
        };
        expect(await c.getOrSet({ key: "g", factory })).toEqual({ n: 1 });
        expect(await c.getOrSet({ key: "g", factory })).toEqual({ n: 1 });
        expect(calls).toBe(1);
    });

    it("getOrSetForever", async () => {
        const value = await c.getOrSetForever({ key: "f", factory: () => 42 });
        expect(value).toBe(42);
        expect(await c.get({ key: "f" })).toBe(42);
    });

    it("delete removes entry", async () => {
        await c.set({ key: "d", value: 1 });
        await c.delete({ key: "d" });
        expect(await c.get({ key: "d" })).toBeNull();
    });

    it("deleteMany removes several keys", async () => {
        await c.set({ key: "d1", value: 1 });
        await c.set({ key: "d2", value: 2 });
        await c.deleteMany({ keys: ["d1", "d2"] });
        expect(await c.missing({ key: "d1" })).toBe(true);
        expect(await c.missing({ key: "d2" })).toBe(true);
    });

    it("pull returns and removes", async () => {
        await c.set({ key: "p", value: 7 });
        expect(await c.pull({ key: "p" })).toBe(7);
        expect(await c.get({ key: "p" })).toBeNull();
    });

    it("clear empties everything", async () => {
        await c.set({ key: "a", value: 1 });
        await c.set({ key: "b", value: 2 });
        await c.clear();
        expect(await c.get({ key: "a" })).toBeNull();
        expect(await c.get({ key: "b" })).toBeNull();
    });

    it("getOrSet serves stale value during grace period", async () => {
        // miss → factory
        const v1 = await c.getOrSet({ key: "e", factory: () => "fresh", ttl: 30, grace: 500 });
        expect(v1).toBe("fresh");

        await sleep(60); // past ttl, within grace
        expect(await c.get({ key: "e" })).toBeNull(); // get returns null when expired

        // stale served while refreshing in the background
        const v2 = await c.getOrSet({ key: "e", factory: () => "fresh2" });
        expect(v2).toBe("fresh");

        await sleep(50); // background refresh completed
        expect(await c.getOrSet({ key: "e", factory: () => "fresh2" })).toBe("fresh2");
    });

    it("namespace groups keys", async () => {
        const users = c.namespace("users");
        await users.set({ key: "1", value: { name: "John" }, ttl: "5m" });
        await users.set({ key: "2", value: { name: "Jane" } });
        expect(await users.get({ key: "1" })).toEqual({ name: "John" });
        expect(await c.get({ key: "1" })).toBeNull(); // not in root
        await users.clear();
        expect(await users.missing({ key: "1" })).toBe(true);
        expect(await users.missing({ key: "2" })).toBe(true);
    });
});

describe("Cache (filesystem)", () => {
    it("persists across instances", async () => {
        const dir = "/tmp/anteros-cache-test";
        const a = useFilesystemCache({ directory: dir });
        await a.set({ key: "persist", value: { ok: true }, ttl: "10m" });
        await a.disconnect();

        const b = useFilesystemCache({ directory: dir });
        expect(await b.get({ key: "persist" })).toEqual({ ok: true });
        await b.delete({ key: "persist" });
        expect(await b.get({ key: "persist" })).toBeNull();
        await b.disconnect();
    });
});
