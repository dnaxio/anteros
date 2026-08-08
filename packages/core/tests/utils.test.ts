import { describe, it, expect, afterEach } from "bun:test";
import * as func from "../utils/func";
import utils from "../utils";
import { cfg } from "../server/config";

afterEach(() => {
    cfg.server.jwt = undefined;
});

describe("omit", () => {
    it("removes keys and regex patterns", () => {
        const out = func.omit({ a: 1, b: 2, password: "x", secret_key: "y" }, ["a", /^secret_/]);
        expect(out).toEqual({ b: 2, password: "x" });
    });
});

describe("pick", () => {
    it("picks simple keys", () => {
        expect(func.pick({ a: 1, b: 2, c: 3 }, ["a", "c"])).toEqual({ a: 1, c: 3 });
    });
});

describe("cleanDeep", () => {
    it("removes null / undefined / empty recursively", () => {
        expect(func.cleanDeep({ a: 1, b: null, c: undefined, d: [], e: {}, f: { g: null } })).toEqual({ a: 1 });
    });
});

describe("clone / deepCopy", () => {
    it("clone deep-copies plain objects", () => {
        const src = { a: { b: [1, 2] } };
        const copy = func.clone(src);
        expect(copy).toEqual(src);
        expect(copy).not.toBe(src);
        copy.a!.b.push(3);
        expect(src.a!.b).toEqual([1, 2]);
    });

    it("deepCopy preserves Date / Map / Set", () => {
        const src = { d: new Date("2024-01-01"), m: new Map([["k", { v: 1 }]]), s: new Set([1, 2]) };
        const copy = func.deepCopy(src);
        expect(copy.d).toBeInstanceOf(Date);
        expect(copy.m).toBeInstanceOf(Map);
        expect(copy.s).toBeInstanceOf(Set);
        expect((copy.m as Map<string, any>).get("k")).toEqual({ v: 1 });
    });
});

describe("deepEquals", () => {
    it("compares deeply", () => {
        expect(utils.deepEquals({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2] } })).toBe(true);
        expect(utils.deepEquals({ a: 1 }, { a: 2 })).toBe(false);
    });
});

describe("isSlug / slugify", () => {
    it("isSlug validates the slug pattern", () => {
        expect(func.isSlug("my-product")).toBe(true);
        expect(func.isSlug("My-Product")).toBe(false);
        expect(func.isSlug("")).toBe(false);
    });

    it("slugify converts text", () => {
        expect(func.slugify("Hello World!")).toBe("hello-world");
    });
});

describe("jwt", () => {
    it("signs and verifies", async () => {
        cfg.server.jwt = { secret: "test-secret" };
        const token = await func.jwt.sign({ sub: "u1", role: "admin" });
        const { value, error } = await func.jwt.verify(token);
        expect(error).toBeNull();
        expect(value).not.toBeNull();
        expect(value?.role).toBe("admin");
        expect(value?.sub).toBe("u1");
    });

    it("detects expired tokens", async () => {
        cfg.server.jwt = { secret: "s" };
        const token = await func.jwt.sign({ sub: "u1" }, { expiresIn: "1s" });
        await Bun.sleep(1100);
        const { value, expired } = await func.jwt.verify(token);
        expect(value).toBeNull();
        expect(expired).toBe(true);
    }, 5000);

    it("rejects invalid tokens", async () => {
        cfg.server.jwt = { secret: "s" };
        const { value, error, expired } = await func.jwt.verify("not-a-jwt");
        expect(value).toBeNull();
        expect(error).not.toBeNull();
        expect(expired).toBe(false);
    });

    it("rejects a token signed with a different secret", async () => {
        cfg.server.jwt = { secret: "secret-a" };
        const token = await func.jwt.sign({ sub: "u1" });
        cfg.server.jwt = { secret: "secret-b" };
        const { value, error } = await func.jwt.verify(token);
        expect(value).toBeNull();
        expect(error).not.toBeNull();
    });
});

describe("password", () => {
    it("hashes and verifies", () => {
        const hash = utils.password.hashSync("hunter2");
        expect(hash).not.toBe("hunter2");
        expect(utils.password.verifySync("hunter2", hash)).toBe(true);
        expect(utils.password.verifySync("wrong", hash)).toBe(false);
    });
});
