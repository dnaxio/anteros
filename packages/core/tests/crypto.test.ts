import { describe, it, expect } from "bun:test";
import { useSymCrypt, useAsymCrypt } from "../utils/crypto";

describe("crypto — symmetric AES-256-GCM", () => {
    it("round-trips a string", async () => {
        const c = useSymCrypt({ secret: "test-secret" });
        const enc = await c.encrypt("hello world");
        const dec = await c.decrypt(enc);
        expect(dec).toBe("hello world");
    });

    it("round-trips an object (parseJson)", async () => {
        const c = useSymCrypt({ secret: "s" });
        const enc = await c.encrypt({ a: 1, b: "x", nested: { ok: true } });
        const dec = await c.decrypt<{ a: number; b: string; nested: { ok: boolean } }>(enc, true);
        expect(dec).toEqual({ a: 1, b: "x", nested: { ok: true } });
    });

    it("produces different ciphertexts each time (random IV)", async () => {
        const c = useSymCrypt({ secret: "s" });
        const a = await c.encrypt("same");
        const b = await c.encrypt("same");
        expect(a).not.toBe(b);
    });

    it("rejects tampered ciphertext (AES-GCM tag)", async () => {
        const c = useSymCrypt({ secret: "s" });
        const enc = await c.encrypt("data");
        const buf = Buffer.from(enc, "base64");
        buf[buf.length - 1]! ^= 0xff; // corrupt the tag
        await expect(c.decrypt(buf.toString("base64"))).rejects.toThrow();
    });

    it("cannot decrypt with a different secret", async () => {
        const c1 = useSymCrypt({ secret: "one" });
        const c2 = useSymCrypt({ secret: "two" });
        const enc = await c1.encrypt("secret");
        await expect(c2.decrypt(enc)).rejects.toThrow();
    });

    it("binds ciphertext to its context via AAD (substitution-proof)", async () => {
        const c = useSymCrypt({ secret: "s" });
        // Alice encrypts with her context
        const enc = await c.encrypt({ apiKey: "sk-alice" }, "users:alice:apiKey");

        // Same context → OK
        const dec = await c.decrypt<{ apiKey: string }>(enc, true, "users:alice:apiKey");
        expect(dec.apiKey).toBe("sk-alice");

        // Swapped into Bob's context (substitution) → rejected
        await expect(c.decrypt(enc, true, "users:bob:apiKey")).rejects.toThrow();
        // Missing context → rejected
        await expect(c.decrypt(enc, true)).rejects.toThrow();
    });

    it("rejects truncated ciphertext with a clear error", async () => {
        const c = useSymCrypt({ secret: "s" });
        await expect(c.decrypt("YWJjZA==")).rejects.toThrow();
    });
});

describe("crypto — asymmetric RSA-OAEP envelope", () => {
    it("round-trips via exportPrivateKey / reuse", async () => {
        const a = useAsymCrypt();
        const enc = await a.encrypt({ secret: 42, list: [1, 2] });
        const priv = await a.exportPrivateKey();
        const b = useAsymCrypt({ privateKey: priv });
        const dec = await b.decrypt<{ secret: number; list: number[] }>(enc, true);
        expect(dec).toEqual({ secret: 42, list: [1, 2] });
    });

    it("encrypts with an external public key and decrypts with the private key", async () => {
        const a = useAsymCrypt();
        const pubJwk = await a.exportPublicKey();
        const pubKey = await a.importPublicKey(pubJwk);
        const enc = await a.encrypt("external-msg", pubKey);
        const dec = await a.decrypt(enc);
        expect(dec).toBe("external-msg");
    });

    it("rejects tampered ciphertext", async () => {
        const a = useAsymCrypt();
        const enc = await a.encrypt("data");
        const buf = Buffer.from(enc, "base64");
        buf[0]! ^= 0xff; // corrupt the wrapped key
        await expect(a.decrypt(buf.toString("base64"))).rejects.toThrow();
    });

    it("binds ciphertext to its context via AAD (asym)", async () => {
        const a = useAsymCrypt();
        const enc = await a.encrypt({ doc: "sensitive" }, undefined, "tenant:acme:record:42");

        const ok = await a.decrypt<{ doc: string }>(enc, true, "tenant:acme:record:42");
        expect(ok.doc).toBe("sensitive");

        // Wrong context → rejected
        await expect(a.decrypt(enc, true, "tenant:acme:record:43")).rejects.toThrow();
        // Missing context → rejected
        await expect(a.decrypt(enc, true)).rejects.toThrow();
    });
});
