import { describe, it, expect, beforeEach } from "bun:test";
import { type Cache, useMemoryCache, useFilesystemCache } from "../utils/cache";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Cache (memory)", () => {
    let c: Cache;

    beforeEach(() => {
        c = useMemoryCache();
    });

    it("set + get round-trip", async () => {
        await c.set({ key: "k", value: { id: 1 }, ttl: "5m" });
        const v = await c.get({ key: "k" });
        expect(v).toEqual({ id: 1 });
    });

    it("setForever never expires", async () => {
        await c.setForever({ key: "cfg", value: { theme: "dark" } });
        const v = await c.get({ key: "cfg" });
        expect(v).toEqual({ theme: "dark" });
    });

    it("get returns undefined on miss", async () => {
        const v = await c.get({ key: "nope" });
        expect(v).toBeUndefined();
    });

    it("has / missing", async () => {
        await c.set({ key: "a", value: 1 });
        expect(await c.has({ key: "a" })).toBe(true);
        expect(await c.missing({ key: "a" })).toBe(false);
        expect(await c.missing({ key: "b" })).toBe(true);
    });

    it("ttl expiry (ms)", async () => {
        await c.set({ key: "x", value: 1, ttl: 50 });
        const v1 = await c.get({ key: "x" });
        expect(v1).toBe(1);
        await sleep(80);
        const v2 = await c.get({ key: "x" });
        expect(v2).toBeUndefined();
    });

    it("getOrSet uses factory and caches", async () => {
        let calls = 0;
        const factory = async () => {
            calls++;
            return { n: calls };
        };
        const a = await c.getOrSet({ key: "g", factory });
        expect(a).toEqual({ n: 1 });
        const b = await c.getOrSet({ key: "g", factory });
        expect(b).toEqual({ n: 1 });
        expect(calls).toBe(1);
    });

    it("getOrSetForever", async () => {
        const value = await c.getOrSetForever({ key: "f", factory: () => 42 });
        expect(value).toBe(42);
        const v = await c.get({ key: "f" });
        expect(v).toBe(42);
    });

    it("delete removes entry", async () => {
        await c.set({ key: "d", value: 1 });
        await c.delete({ key: "d" });
        const v = await c.get({ key: "d" });
        expect(v).toBeUndefined();
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
        const p = await c.pull("p");
        expect(p).toBe(7);
        const v = await c.get({ key: "p" });
        expect(v).toBeUndefined();
    });

    it("clear empties everything", async () => {
        await c.set({ key: "a", value: 1 });
        await c.set({ key: "b", value: 2 });
        await c.clear();
        const va = await c.get({ key: "a" });
        const vb = await c.get({ key: "b" });
        expect(va).toBeUndefined();
        expect(vb).toBeUndefined();
    });

    it("getOrSet recovers after ttl expiry (grace accepted)", async () => {
        // miss → factory
        const v1 = await c.getOrSet({ key: "e", factory: () => "fresh", ttl: 30, grace: 500 });
        expect(v1).toBe("fresh");

        await sleep(60); // past ttl
        const v2 = await c.get({ key: "e" });
        expect(v2).toBeUndefined(); // expired

        // getOrSet re-runs the factory after expiry
        const v3 = await c.getOrSet({ key: "e", factory: () => "fresh2" });
        expect(v3).toBe("fresh2");
    });

    it("namespace groups keys", async () => {
        const users = c.namespace("users");
        await users.set({ key: "1", value: { name: "John" }, ttl: "5m" });
        await users.set({ key: "2", value: { name: "Jane" } });
        const u1 = await users.get({ key: "1" });
        expect(u1).toEqual({ name: "John" });
        const root = await c.get({ key: "1" });
        expect(root).toBeUndefined(); // not in root
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
        const v = await b.get({ key: "persist" });
        expect(v).toEqual({ ok: true });
        await b.delete({ key: "persist" });
        const gone = await b.get({ key: "persist" });
        expect(gone).toBeUndefined();
        await b.disconnect();
    });
});
