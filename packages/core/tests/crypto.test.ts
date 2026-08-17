import { describe, it, expect, afterAll } from "bun:test";
import { useSymCrypt, useAsymCrypt, resolve } from "../utils/crypto";
import { cfg, formatConfig } from "../server/config";
import utils from "../utils";

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

    it("decrypt(cipher, true, fields) decrypts the listed sub-fields inside the JSON", async () => {
        const c = useSymCrypt({ secret: "s" });
        // json contenant des sous-champs chiffrés (convention field-level : JSON.stringify)
        const encZip = await c.encrypt(JSON.stringify("75000"));
        const encPhone = await c.encrypt(JSON.stringify("0600000000"));
        const container = await c.encrypt({ city: "Paris", zip: encZip, contact: { phone: encPhone } });

        const dec = await c.decrypt<any>(container, true, ["zip", "contact.phone"]);
        expect(dec.city).toBe("Paris");
        expect(dec.zip).toBe("75000");
        expect(dec.contact.phone).toBe("0600000000");

        // sans les champs → sous-champs toujours chiffrés
        const raw = await c.decrypt<any>(container, true);
        expect(raw.zip).toMatch(/^[A-Za-z0-9+/=]+$/);
        expect(raw.city).toBe("Paris");
    });

    it("decrypt(jsonObject, true, fields) decrypts sub-fields of a plaintext json container", async () => {
        const c = useSymCrypt({ secret: "s" });
        const encZip = await c.encrypt(JSON.stringify("69001"));
        const json = { street: "Rue X", zip: encZip, tags: [{ code: encZip }] };

        const dec = await c.decrypt<any>(json, true, ["zip", "tags.0.code"]);
        expect(dec.street).toBe("Rue X");
        expect(dec.zip).toBe("69001");
        expect(dec.tags[0].code).toBe("69001");
    });

    it("decrypt(..., fields) keeps non-ciphertext values as-is", async () => {
        const c = useSymCrypt({ secret: "s" });
        const json = { city: "Paris", note: "plain text", zip: await c.encrypt(JSON.stringify("75000")) };
        const dec = await c.decrypt<any>(json, true, ["zip", "note", "missing"]);
        expect(dec.city).toBe("Paris");
        expect(dec.note).toBe("plain text"); // pas un ciphertext → inchangé
        expect(dec.zip).toBe("75000");
    });

    it("decrypt handles an ARRAY of json objects with encrypted fields", async () => {
        const c = useSymCrypt({ secret: "s" });
        const encZip = await c.encrypt(JSON.stringify("69001"));
        const encOther = await c.encrypt(JSON.stringify("69002"));

        // array conteneur direct (ex: doc.addresses renvoyé par une requête)
        const arr = [
            { city: "Lyon", zip: encZip },
            { city: "Villeurbanne", zip: encOther },
        ];
        const dec = await c.decrypt<any>(arr, true, ["zip"]);
        expect(dec[0].zip).toBe("69001");
        expect(dec[1].zip).toBe("69002");
        expect(dec[0].city).toBe("Lyon"); // non-chiffré conservé
        expect(dec).not.toBe(arr); // copie, pas de mutation
        expect(arr[0]!.zip).toMatch(/^[A-Za-z0-9+/=]+$/); // input intact

        // ciphertext dont le plaintext est un array de json
        const encContainer = await c.encrypt([{ zip: encZip }, { zip: encOther }]);
        const dec2 = await c.decrypt<any>(encContainer, true, ["zip"]);
        expect(dec2[0].zip).toBe("69001");
        expect(dec2[1].zip).toBe("69002");
    });
});

describe("crypto — key rotation (versioned secrets)", () => {
    it("decrypts old ciphertexts after rotating the secret", async () => {
        const old = useSymCrypt({ secret: "v1-secret" }); // version 1 par défaut
        const enc = await old.encrypt({ apiKey: "sk-rot" });

        // Rotation : nouvelle clé active v2, l'ancienne conservée en decrypt-only
        const rotated = useSymCrypt({ secret: "v2-secret", version: 2, previousSecrets: { 1: "v1-secret" } });
        const dec = await rotated.decrypt<{ apiKey: string }>(enc, true);
        expect(dec.apiKey).toBe("sk-rot");
    });

    it("tags new ciphertexts with the active version", async () => {
        const c = useSymCrypt({ secret: "s", version: 2 });
        const enc = await c.encrypt("data");
        const buf = Buffer.from(enc, "base64");
        expect(buf[0]).toBe(2);
        // round-trip avec la même instance
        const dec = await c.decrypt(enc);
        expect(dec).toBe("data");
    });

    it("still decrypts legacy ciphertexts (no version byte)", async () => {
        const c = useSymCrypt({ secret: "s" });
        const enc = await c.encrypt("legacy");
        // Simule un ciphertext produit AVANT la rotation (format sans octet de version)
        const legacy = Buffer.from(Buffer.from(enc, "base64").subarray(1)).toString("base64");
        const dec = await c.decrypt(legacy);
        expect(dec).toBe("legacy");
    });

    it("the old secret cannot decrypt data encrypted with the new key", async () => {
        const c = useSymCrypt({ secret: "v2", version: 2, previousSecrets: { 1: "v1" } });
        const enc = await c.encrypt("new-data");
        const old = useSymCrypt({ secret: "v1" });
        await expect(old.decrypt(enc)).rejects.toThrow();
    });

    it("binds ciphertexts to the config default AAD when none is passed", async () => {
        const c = useSymCrypt({ secret: "s", aad: "myapp:prod" });
        const enc = await c.encrypt({ apiKey: "sk-aad" });

        // même instance → OK (défaut appliqué au decrypt aussi)
        const dec = await c.decrypt<{ apiKey: string }>(enc, true);
        expect(dec.apiKey).toBe("sk-aad");

        // sans l'AAD config → échec (tag invalide)
        const other = useSymCrypt({ secret: "s" });
        await expect(other.decrypt(enc, true)).rejects.toThrow();
    });

    it("explicit AAD wins over the config default", async () => {
        const c = useSymCrypt({ secret: "s", aad: "default:ctx" });
        const enc = await c.encrypt("x", "explicit:ctx");
        const dec = await c.decrypt(enc, false, "explicit:ctx");
        expect(dec).toBe("x");
        // le défaut ne déchiffre pas le chiffré lié à l'explicite
        await expect(c.decrypt(enc, false, "default:ctx")).rejects.toThrow();
    });

    it("legacy ciphertexts (no AAD) still decrypt after a default AAD is configured", async () => {
        const legacy = useSymCrypt({ secret: "s" }); // chiffré SANS AAD (ancien comportement)
        const enc = await legacy.encrypt("old-data");

        const c = useSymCrypt({ secret: "s", aad: "myapp:prod" }); // config avec AAD par défaut
        const dec = await c.decrypt(enc);
        expect(dec).toBe("old-data");
    });
});

describe("crypto — encryption mode (server.encryption.mode)", () => {
    afterAll(() => {
        delete (cfg.server as any).encryption;
        formatConfig({ server: { port: 4000 }, tenants: [] });
    });

    it("boot validation: symmetric mode requires a secret", () => {
        delete (cfg.server as any).encryption;
        expect(() => formatConfig({
            server: { port: 4000, encryption: { mode: "symmetric" } },
            tenants: [],
        })).toThrow(/symmetric.*requires a secret/);
    });

    it("boot validation: asymmetric mode requires a privateKey", () => {
        delete (cfg.server as any).encryption;
        expect(() => formatConfig({
            server: { port: 4000, encryption: { mode: "asymmetric" } },
            tenants: [],
        })).toThrow(/asymmetric.*requires a privateKey/);
    });

    it("useSymCrypt() without explicit secret rejects an asymmetric mode", () => {
        delete (cfg.server as any).encryption;
        formatConfig({ server: { port: 4000, encryption: { mode: "asymmetric", privateKey: {} as any } }, tenants: [] });
        expect(() => useSymCrypt()).toThrow(/mode is 'asymmetric'/);
    });

    it("resolve() returns the instance matching the configured mode", async () => {
        delete (cfg.server as any).encryption;
        formatConfig({ server: { port: 4000 }, tenants: [] });
        const priv = await useAsymCrypt().exportPrivateKey(); // pair fraîche, pas de mode config

        delete (cfg.server as any).encryption;
        formatConfig({ server: { port: 4000, encryption: { mode: "symmetric", secret: "cfg" } }, tenants: [] });
        const sym = resolve();
        const enc = await sym.encrypt({ a: 1 });
        expect((await sym.decrypt<{ a: number }>(enc, true)).a).toBe(1);

        delete (cfg.server as any).encryption;
        formatConfig({ server: { port: 4000, encryption: { mode: "asymmetric", privateKey: priv } }, tenants: [] });
        const asym = resolve();
        const enc2 = await asym.encrypt("hi");
        const dec2 = await asym.decrypt(enc2);
        expect(dec2).toBe("hi");
    });

    it("resolve() throws when mode is missing", () => {
        delete (cfg.server as any).encryption;
        formatConfig({ server: { port: 4000 }, tenants: [] });
        expect(() => resolve()).toThrow(/mode is required/);
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

    it("decrypt(cipher, true, fields) decrypts listed sub-fields (asym)", async () => {
        const a = useAsymCrypt();
        const encZip = await a.encrypt(JSON.stringify("75000"));
        const container = await a.encrypt({ city: "Paris", zip: encZip });

        const dec = await a.decrypt<any>(container, true, ["zip"]);
        expect(dec.city).toBe("Paris");
        expect(dec.zip).toBe("75000");
    });
});

describe("crypto — public surface", () => {
    it("is exposed via utils.crypt (not a top-level crypto export)", async () => {
        expect(typeof utils.crypt.useSymCrypt).toBe("function");
        expect(typeof utils.crypt.useAsymCrypt).toBe("function");
        expect(typeof utils.crypt.resolve).toBe("function");
        const top: any = await import("../index");
        expect(top.crypto).toBeUndefined();
    });
});

describe("crypto — server config defaults (server.encryption)", () => {
    afterAll(() => {
        delete (cfg.server as any).encryption;
        formatConfig({ server: { port: 4000 }, tenants: [] });
    });

    it("useSymCrypt() without args uses server.encryption.secret", async () => {
        formatConfig({
            server: { port: 4000, encryption: { mode: "symmetric", secret: "cfg-secret" } },
            tenants: [],
        });
        const c = useSymCrypt();
        const enc = await c.encrypt({ apiKey: "sk-x" });
        const dec = await c.decrypt<{ apiKey: string }>(enc, true);
        expect(dec.apiKey).toBe("sk-x");
    });

    it("useSymCrypt() throws a clear error when no secret is available", () => {
        delete (cfg.server as any).encryption; // formatConfig merges — reset explicit
        formatConfig({ server: { port: 4000 }, tenants: [] });
        delete Bun.env.APP_SECRET;
        expect(() => useSymCrypt()).toThrow(/missing secret/);
    });

    it("useAsymCrypt() without args uses server.encryption.privateKey (JWK)", async () => {
        const gen = useAsymCrypt();
        const priv = await gen.exportPrivateKey();

        formatConfig({
            server: { port: 4000, encryption: { mode: "asymmetric", privateKey: priv } },
            tenants: [],
        });
        const enc = await gen.encrypt("cfg-asym");
        const c = useAsymCrypt(); // pas de privateKey → prend cfg
        const dec = await c.decrypt(enc);
        expect(dec).toBe("cfg-asym");
    });

    it("useAsymCrypt() accepts privateKey as a JSON string", async () => {
        const gen = useAsymCrypt();
        const priv = await gen.exportPrivateKey();

        formatConfig({
            server: { port: 4000, encryption: { mode: "asymmetric", privateKey: JSON.stringify(priv) } },
            tenants: [],
        });
        const enc = await gen.encrypt("json-key");
        const c = useAsymCrypt();
        const dec = await c.decrypt(enc);
        expect(dec).toBe("json-key");
    });
});
