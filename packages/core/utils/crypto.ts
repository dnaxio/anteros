const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const RSA_KEY_SIZE = 256;

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
    #key: CryptoKey | null = null;
    #secret: string;

    constructor(options: { secret: string }) {
        this.#secret = options.secret;
    }

    async #getKey(): Promise<CryptoKey> {
        if (this.#key) return this.#key;
        const hash = new Bun.CryptoHasher("sha256").update(this.#secret).digest();
        this.#key = await crypto.subtle.importKey(
            "raw",
            new Uint8Array(hash),
            { name: "AES-GCM" },
            false,
            ["encrypt", "decrypt"]
        );
        return this.#key;
    }

    async encrypt(data: string | object): Promise<string> {
        const text = typeof data === "object" ? JSON.stringify(data) : data;
        const key = await this.#getKey();
        const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
        const encrypted = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv, tagLength: TAG_LENGTH * 8 },
            key,
            new TextEncoder().encode(text)
        );
        const buffer = new Uint8Array(IV_LENGTH + encrypted.byteLength);
        buffer.set(iv, 0);
        buffer.set(new Uint8Array(encrypted), IV_LENGTH);
        return Buffer.from(buffer).toString("base64");
    }

    async decrypt<T = string>(cipher: string, parseJson?: boolean): Promise<T> {
        try {
            const buffer = new Uint8Array(Buffer.from(cipher, "base64"));
            const iv = buffer.slice(0, IV_LENGTH);
            const data = buffer.slice(IV_LENGTH);
            const key = await this.#getKey();
            const decrypted = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv, tagLength: TAG_LENGTH * 8 },
                key,
                data
            );
            const text = new TextDecoder().decode(decrypted);
            if (parseJson) return JSON.parse(text) as T;
            return text as T;
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

    async encrypt(data: string | object, publicKey?: CryptoKey): Promise<string> {
        const text = typeof data === "object" ? JSON.stringify(data) : data;
        const rsaKey = publicKey ?? (await this.#getKeyPair()).publicKey;

        const aesKey = await crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            true,
            ["encrypt"]
        );

        const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
        const encrypted = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv, tagLength: TAG_LENGTH * 8 },
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

    async decrypt<T = string>(cipher: string, parseJson?: boolean): Promise<T> {
        try {
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
                { name: "AES-GCM", iv, tagLength: TAG_LENGTH * 8 },
                aesKey,
                ciphertext
            );
            const text = new TextDecoder().decode(decrypted);
            if (parseJson) return JSON.parse(text) as T;
            return text as T;
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

const sym = (options: { secret: string }) => new CryptSym(options);
const asym = (options?: { privateKey?: JsonWebKey }) => new CryptAsym(options);

export { sym as useSymCrypt, asym as useAsymCrypt };
