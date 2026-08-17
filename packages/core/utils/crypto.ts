import { cfg } from "../server/config";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const RSA_KEY_SIZE = 256;

/** Read a dot-path value ('a.b.c') */
function getPath(obj: any, path: string): any {
    return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Write a dot-path value ('a.b.c') — only if the intermediate chain exists */
function setPath(obj: Record<string, any>, path: string, value: any): void {
    const parts = path.split(".");
    let cur: any = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const next = cur?.[parts[i]!];
        if (!next || typeof next !== "object") return;
        cur = next;
    }
    cur[parts[parts.length - 1]!] = value;
}

/**
 * Decrypt the values at `paths` inside a json value (object or array of json
 * objects). Values are JSON-wrapped (field-level convention) → JSON.parse on decrypt.
 * Non-ciphertext values are kept as-is.
 */
async function decryptJsonPaths(value: any, paths: string[], decryptOne: (ciphertext: string) => Promise<string>): Promise<any> {
    if (Array.isArray(value)) {
        return Promise.all(value.map((item) => decryptJsonPaths(item, paths, decryptOne)));
    }
    if (!value || typeof value !== "object") return value;
    const out: Record<string, any> = { ...value };
    for (const p of paths) {
        const v = getPath(out, p);
        if (typeof v === "string") {
            try {
                setPath(out, p, JSON.parse(await decryptOne(v))); // round-trips any JSON value
            } catch {
                // not a ciphertext (plaintext value) → keep as-is
            }
        }
    }
    return out;
}

/**
 * Build AES-GCM parameters with optional Additional Authenticated Data.
 * AAD binds the ciphertext to its context (field/record/tenant) so a valid
 * ciphertext cannot be swapped into another context (substitution attack).
 */
function gcmParams(iv: Uint8Array, aad?: string) {
    return {
        name: "AES-GCM" as const,
        iv,
        tagLength: TAG_LENGTH * 8,
        ...(aad ? { additionalData: new TextEncoder().encode(aad) } : {}),
    };
}

interface JsonWebKey {
    kty?: string;
    alg?: string;
    key_ops?: string[];
    ext?: boolean;
    // RSA
    n?: string;
    e?: string;
    d?: string;
    p?: string;
    q?: string;
    dp?: string;
    dq?: string;
    qi?: string;
    // EC
    crv?: string;
    x?: string;
    y?: string;
}

class CryptSym {
    #activeSecret: string;
    #version: number;
    #previousSecrets: Record<number, string>;
    #defaultAad?: string;
    #keyCache = new Map<string, CryptoKey>(); // derived key per secret

    constructor(options: { secret: string; version?: number; previousSecrets?: Record<number, string>; aad?: string }) {
        this.#activeSecret = options.secret;
        this.#version = options.version ?? 1;
        this.#previousSecrets = options.previousSecrets ?? {};
        this.#defaultAad = options.aad;
    }

    async #getKey(secret: string): Promise<CryptoKey> {
        let key = this.#keyCache.get(secret);
        if (key) return key;
        const hash = new Bun.CryptoHasher("sha256").update(secret).digest();
        key = await crypto.subtle.importKey(
            "raw",
            new Uint8Array(hash),
            { name: "AES-GCM" },
            false,
            ["encrypt", "decrypt"]
        );
        this.#keyCache.set(secret, key);
        return key;
    }

    /** Secret for a given version — previous keys are decrypt-only */
    #secretFor(version: number): string | null {
        if (version === this.#version) return this.#activeSecret;
        return this.#previousSecrets[version] ?? null;
    }

    async encrypt(data: string | object, aad?: string): Promise<string> {
        const text = typeof data === "object" ? JSON.stringify(data) : data;
        const key = await this.#getKey(this.#activeSecret);
        const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
        const ctx = aad ?? this.#defaultAad; // explicit AAD wins, else config default
        const encrypted = await crypto.subtle.encrypt(
            gcmParams(iv, ctx),
            key,
            new TextEncoder().encode(text)
        );
        // [ version(1) | iv(12) | ciphertext ] — version tags the key used
        const buffer = new Uint8Array(1 + IV_LENGTH + encrypted.byteLength);
        buffer[0] = this.#version & 0xff;
        buffer.set(iv, 1);
        buffer.set(new Uint8Array(encrypted), 1 + IV_LENGTH);
        return Buffer.from(buffer).toString("base64");
    }

    /** Decrypt ciphertext → plaintext string (versioned keyring + AAD candidates + legacy fallback) */
    async #decryptText(cipher: string, aad?: string): Promise<string> {
        const buffer = new Uint8Array(Buffer.from(cipher, "base64"));
        if (buffer.length < IV_LENGTH + TAG_LENGTH) {
            throw new Error("ciphertext too short");
        }

        // AAD candidates: explicit AAD wins → [aad]; otherwise try the config
        // default first, then no-AAD (legacy ciphertexts from before this feature)
        const aads: (string | undefined)[] = aad !== undefined
            ? [aad]
            : this.#defaultAad !== undefined ? [this.#defaultAad, undefined] : [undefined];

        const tryDecrypt = async (version: number, offset: number, ctx?: string): Promise<string | null> => {
            const secret = this.#secretFor(version);
            if (!secret || buffer.length < offset + IV_LENGTH + TAG_LENGTH) return null;
            const iv = buffer.slice(offset, offset + IV_LENGTH);
            const data = buffer.slice(offset + IV_LENGTH);
            try {
                const key = await this.#getKey(secret);
                const decrypted = await crypto.subtle.decrypt(gcmParams(iv, ctx), key, data);
                return new TextDecoder().decode(decrypted);
            } catch {
                return null; // wrong key, wrong AAD, or tampered data — try the next path
            }
        };

        // 1. Versioned format: first byte = key version (0 = legacy, never written)
        const v = buffer[0] ?? 0;
        if (v > 0) {
            for (const ctx of aads) {
                const plain = await tryDecrypt(v, 1, ctx);
                if (plain !== null) return plain;
            }
        }
        // 2. Legacy format (pre-rotation ciphertexts): no version byte, active key
        for (const ctx of aads) {
            const plain = await tryDecrypt(this.#version, 0, ctx);
            if (plain !== null) return plain;
        }
        throw new Error("invalid ciphertext, tampered data, or unknown key version");
    }

    /**
     * Decrypt a ciphertext (string) or a plaintext JSON container (object).
     * - `parseJson: true` → the decrypted text is JSON-parsed.
     * - 3rd param: `string` = AAD context; `string[]` = fields (dot-paths) to decrypt
     *   inside the JSON (encrypted sub-fields, e.g. ['zip', 'contacts.phone']).
     */
    async decrypt<T = string>(cipher: string | object, parseJson?: boolean, fieldsOrAad?: string | string[]): Promise<T> {
        try {
            // Plaintext JSON container (e.g. a json field returned by a query) with
            // encrypted sub-fields → decrypt only the listed paths.
            if (cipher && typeof cipher === "object") {
                const fields = (Array.isArray(fieldsOrAad) ? fieldsOrAad : fieldsOrAad ? [fieldsOrAad] : []) as string[];
                return await decryptJsonPaths(cipher, fields, (c) => this.#decryptText(c)) as T;
            }

            const aad = typeof fieldsOrAad === "string" ? fieldsOrAad : undefined;
            const fields = Array.isArray(fieldsOrAad) ? fieldsOrAad : [];
            const plain = await this.#decryptText(cipher as string, aad);
            let value: any = (parseJson || fields.length > 0) ? JSON.parse(plain) : plain;
            if (fields.length && value && typeof value === "object") {
                value = await decryptJsonPaths(value, fields, (c) => this.#decryptText(c));
            }
            return value as T;
        } catch (err: any) {
            throw new Error(`Decryption failed: ${err?.message || 'invalid ciphertext or tampered data'}`);
        }
    }
}

class CryptAsym {
    #keyPair: CryptoKeyPair | null = null;
    #privateJwk: JsonWebKey | null = null;

    constructor(options?: { privateKey?: JsonWebKey }) {
        if (options?.privateKey) {
            this.#privateJwk = options.privateKey;
        }
    }

    async #getKeyPair(): Promise<CryptoKeyPair> {
      if (this.#keyPair) return this.#keyPair;

        if (this.#privateJwk) {
            const privateKey = await crypto.subtle.importKey(
                "jwk",
                this.#privateJwk,
                { name: "RSA-OAEP", hash: "SHA-256" },
                true,
                ["decrypt"]
            );
            const publicJwk: any = await crypto.subtle.exportKey("jwk", privateKey);
            delete publicJwk.d;
            delete publicJwk.p;
            delete publicJwk.q;
            delete publicJwk.dp;
            delete publicJwk.dq;
            delete publicJwk.qi;
            publicJwk.key_ops = ["encrypt"];
            const publicKey = await crypto.subtle.importKey(
                "jwk",
                publicJwk,
                { name: "RSA-OAEP", hash: "SHA-256" },
                false,
                ["encrypt"]
            );
            this.#keyPair = { privateKey, publicKey };
            return this.#keyPair;
        }

        this.#keyPair = await crypto.subtle.generateKey(
            {
                name: "RSA-OAEP",
                modulusLength: 2048,
                publicExponent: new Uint8Array([1, 0, 1]),
                hash: "SHA-256",
            },
            true,
            ["encrypt", "decrypt"]
        );
        return this.#keyPair;
    }

    async encrypt(data: string | object, publicKey?: CryptoKey, aad?: string): Promise<string> {
        const text = typeof data === "object" ? JSON.stringify(data) : data;
        const rsaKey = publicKey ?? (await this.#getKeyPair()).publicKey;

        const aesKey = await crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            true,
            ["encrypt"]
        );

        const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
        const encrypted = await crypto.subtle.encrypt(
            gcmParams(iv, aad),
            aesKey,
            new TextEncoder().encode(text)
        );

        const rawAesKey = await crypto.subtle.exportKey("raw", aesKey);
        const wrappedKey = await crypto.subtle.encrypt(
            { name: "RSA-OAEP" },
            rsaKey,
            rawAesKey
        );

        const result = new Uint8Array(RSA_KEY_SIZE + IV_LENGTH + encrypted.byteLength);
        result.set(new Uint8Array(wrappedKey), 0);
        result.set(iv, RSA_KEY_SIZE);
        result.set(new Uint8Array(encrypted), RSA_KEY_SIZE + IV_LENGTH);
        return Buffer.from(result).toString("base64");
    }

    /** Decrypt ciphertext → plaintext string */
    async #decryptText(cipher: string, aad?: string): Promise<string> {
        const buffer = new Uint8Array(Buffer.from(cipher, "base64"));
        if (buffer.length < RSA_KEY_SIZE + IV_LENGTH + TAG_LENGTH) {
            throw new Error("ciphertext too short");
        }

        const wrappedKey = buffer.slice(0, RSA_KEY_SIZE);
        const iv = buffer.slice(RSA_KEY_SIZE, RSA_KEY_SIZE + IV_LENGTH);
        const ciphertext = buffer.slice(RSA_KEY_SIZE + IV_LENGTH);

        const { privateKey } = await this.#getKeyPair();
        const rawAesKey = await crypto.subtle.decrypt(
            { name: "RSA-OAEP" },
            privateKey,
            wrappedKey
        );

        const aesKey = await crypto.subtle.importKey(
            "raw",
            rawAesKey,
            { name: "AES-GCM" },
            false,
            ["decrypt"]
        );

        const decrypted = await crypto.subtle.decrypt(
            gcmParams(iv, aad),
            aesKey,
            ciphertext
        );
        return new TextDecoder().decode(decrypted);
    }

    /**
     * Decrypt a ciphertext (string) or a plaintext JSON container (object).
     * - `parseJson: true` → the decrypted text is JSON-parsed.
     * - 3rd param: `string` = AAD context; `string[]` = fields (dot-paths) to decrypt
     *   inside the JSON (encrypted sub-fields).
     */
    async decrypt<T = string>(cipher: string | object, parseJson?: boolean, fieldsOrAad?: string | string[]): Promise<T> {
        try {
            if (cipher && typeof cipher === "object") {
                const fields = (Array.isArray(fieldsOrAad) ? fieldsOrAad : fieldsOrAad ? [fieldsOrAad] : []) as string[];
                return await decryptJsonPaths(cipher, fields, (c) => this.#decryptText(c)) as T;
            }

            const aad = typeof fieldsOrAad === "string" ? fieldsOrAad : undefined;
            const fields = Array.isArray(fieldsOrAad) ? fieldsOrAad : [];
            const plain = await this.#decryptText(cipher as string, aad);
            let value: any = (parseJson || fields.length > 0) ? JSON.parse(plain) : plain;
            if (fields.length && value && typeof value === "object") {
                value = await decryptJsonPaths(value, fields, (c) => this.#decryptText(c));
            }
            return value as T;
        } catch (err: any) {
            throw new Error(`Decryption failed: ${err?.message || 'invalid ciphertext or tampered data'}`);
        }
    }

    async exportPublicKey(): Promise<JsonWebKey> {
        return await crypto.subtle.exportKey("jwk", (await this.#getKeyPair()).publicKey);
    }

    async exportPrivateKey(): Promise<JsonWebKey> {
        return await crypto.subtle.exportKey("jwk", (await this.#getKeyPair()).privateKey);
    }

    async importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
        return await crypto.subtle.importKey(
            "jwk",
            jwk,
            { name: "RSA-OAEP", hash: "SHA-256" },
            false,
            ["encrypt"]
        );
    }
}

type SymCryptOptions = {
    secret?: string;
    /** Version of the active secret — written into new ciphertexts (default: 1) */
    version?: number;
    /** Older secrets for decrypt-only — key rotation, e.g. { 1: 'v1-secret' } */
    previousSecrets?: Record<number, string>;
    /** Default AAD context — used when no explicit AAD is passed (config default wins over nothing) */
    aad?: string;
};

const sym = (options?: SymCryptOptions) => {
    const enc = cfg.server.encryption;
    const secret = options?.secret ?? enc?.secret ?? Bun.env.APP_SECRET;
    if (enc?.mode && enc.mode !== 'symmetric' && options?.secret === undefined) {
        throw new Error(`useSymCrypt: server.encryption.mode is '${enc.mode}' — use utils.crypt.useAsymCrypt() or set mode: 'symmetric'`);
    }
    if (!secret) {
        throw new Error("useSymCrypt: missing secret — pass { secret } or set server.encryption.secret / APP_SECRET env");
    }
    return new CryptSym({
        secret,
        version: options?.version ?? enc?.version ?? 1,
        previousSecrets: options?.previousSecrets ?? enc?.previousSecrets,
        aad: options?.aad ?? enc?.aad,
    });
};
const asym = (options?: { privateKey?: JsonWebKey }) => {
    const enc = cfg.server.encryption;
    if (enc?.mode && enc.mode !== 'asymmetric' && options?.privateKey === undefined) {
        throw new Error(`useAsymCrypt: server.encryption.mode is '${enc.mode}' — use utils.crypt.useSymCrypt() or set mode: 'asymmetric'`);
    }
    const cfgKey = enc?.privateKey;
    const privateKey = options?.privateKey ?? (typeof cfgKey === 'string' ? JSON.parse(cfgKey) : cfgKey);
    return new CryptAsym(privateKey ? { privateKey } : undefined);
};

/**
 * Resolve the instance matching `server.encryption.mode`
 * ('symmetric' → useSymCrypt, 'asymmetric' → useAsymCrypt).
 */
const resolve = () => {
    const mode = cfg.server.encryption?.mode;
    if (mode === 'symmetric') return sym();
    if (mode === 'asymmetric') return asym();
    throw new Error("utils.crypt.resolve(): server.encryption.mode is required ('symmetric' | 'asymmetric')");
};

export { sym as useSymCrypt, asym as useAsymCrypt, resolve };
