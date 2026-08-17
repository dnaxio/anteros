import { cfg } from "../server/config";
import { AppError } from "../lib/error";
import type { Collection } from "../types/collection";

/**
 * Field-level encryption — `encryption: true` encrypts the whole field value;
 * `encryptionOptions: { path: 'zip' }` encrypts only a sub-path inside a
 * `json` (or array of json) field, e.g. `address.zip`.
 *
 * Uses the server encryption config (utils.crypt.resolve() — mode-driven:
 * symmetric AES-256-GCM or asymmetric RSA-OAEP envelope).
 *
 * - Writes (insert/update): encrypted values are encrypted BEFORE storage.
 * - Reads: NO automatic decryption — ciphertext is returned as stored
 *   (decrypt manually with utils.crypt.resolve().decrypt(value, true)).
 *
 * ⚠️ Encrypted values are opaque in Mongo — $match/$sort/$group on them operates
 * on ciphertext (don't use them as query/order keys).
 */

async function getCipher() {
    const { resolve } = await import("../utils/crypto");
    return resolve();
}

type PathField = { name: string; paths: string[] };

/** Fields marked `encryption: true` (whole value) */
export function encryptedFields(col: Collection | null): string[] {
    return (col?.fields ?? []).filter((f) => f.encryption).map((f) => f.name);
}

/** Fields with `encryptionOptions.path` (sub-path inside json / array of json) */
export function encryptedPaths(col: Collection | null): PathField[] {
    return (col?.fields ?? [])
        .filter((f) => f.encryptionOptions?.path)
        .map((f) => ({
            name: f.name,
            paths: (Array.isArray(f.encryptionOptions!.path) ? f.encryptionOptions!.path : [f.encryptionOptions!.path]) as string[],
        }));
}

function requireConfig(col: Collection | null, targets: string[]) {
    if (!cfg.server.encryption?.mode) {
        throw new AppError(
            `Encrypted field(s) [${targets.join(", ")}] require server.encryption to be configured (mode + keys)`,
            { code: "ENCRYPTION_NOT_CONFIGURED", status: 500 }
        );
    }
}

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
        if (!next || typeof next !== "object") return; // intermediate missing → nothing to encrypt
        cur = next;
    }
    cur[parts[parts.length - 1]!] = value;
}

/** Encrypt the values at `paths` inside a json value — object or array of json objects */
async function encryptAt(cipher: any, value: any, paths: string[]): Promise<any> {
    if (Array.isArray(value)) {
        return Promise.all(value.map((item) => encryptAt(cipher, item, paths)));
    }
    if (!value || typeof value !== "object") return value;
    const out: Record<string, any> = { ...value };
    for (const p of paths) {
        const v = getPath(out, p);
        if (v !== undefined && v !== null) {
            setPath(out, p, await cipher.encrypt(JSON.stringify(v))); // JSON-wrap → decrypt(..., true) round-trips any value
        }
    }
    return out;
}

/** Encrypt the encrypted values present in a write payload (new object, input untouched) */
export async function encryptFields(col: Collection | null, data: Record<string, any> | null | undefined): Promise<any> {
    const names = encryptedFields(col);
    const pathFields = encryptedPaths(col);
    if ((!names.length && !pathFields.length) || !data || typeof data !== "object") return data;
    if (Array.isArray(data)) return Promise.all(data.map((d) => encryptFields(col, d)));

    const targets = [...names, ...pathFields.map((p) => p.paths.map((path) => `${p.name}.${path}`)).flat()];
    requireConfig(col, targets);

    const out: Record<string, any> = { ...data };
    const cipher = await getCipher();

    // Whole-value fields (encryption: true)
    for (const name of names) {
        const v = out[name];
        if (v !== undefined && v !== null) {
            out[name] = await cipher.encrypt(JSON.stringify(v));
        }
    }
    // Path fields (encryptionOptions.path) — encrypt only the sub-path(s)
    for (const { name, paths } of pathFields) {
        const v = out[name];
        if (v !== undefined && v !== null) {
            out[name] = await encryptAt(cipher, v, paths);
        }
    }
    return out;
}

/**
 * Encrypt $set / $setOnInsert values for encrypted fields; reject operators that
 * cannot work on ciphertext ($inc, $push, $addToSet, …). $unset/$rename/$currentDate are safe.
 */
export async function encryptUpdate(col: Collection | null, update: Record<string, any> | null | undefined): Promise<any> {
    const names = encryptedFields(col);
    const pathFields = encryptedPaths(col);
    if ((!names.length && !pathFields.length) || !update || typeof update !== "object") return update;
    const nameSet = new Set(names);

    // Resolve a $set key → whole-field | sub-path of a path-field | null (not encrypted)
    const resolveKey = (k: string): { kind: "whole" | "path"; field: string; sub: string | null; paths?: string[] } | null => {
        if (nameSet.has(k)) return { kind: "whole", field: k, sub: null };
        const pf = pathFields.find((p) => k === p.name || k.startsWith(p.name + "."));
        if (pf) {
            const sub = k === pf.name ? null : k.slice(pf.name.length + 1);
            // chemin exact, descendant ('zip.sub') ou à travers un index de array ('0.zip')
            if (sub === null || pf.paths.some((p) => sub === p || sub.startsWith(p + ".") || sub.endsWith("." + p))) {
                return { kind: "path", field: pf.name, sub, paths: pf.paths };
            }
        }
        return null;
    };

    const out: Record<string, any> = { ...update };

    for (const [op, values] of Object.entries(out)) {
        if ((op === "$set" || op === "$setOnInsert") && values && typeof values === "object") {
            const keys = Object.keys(values);
            const hits = keys.map((k) => ({ k, hit: resolveKey(k) })).filter((x) => x.hit);
            if (!hits.length) continue;
            requireConfig(col, hits.map(({ hit }) => hit!.kind === "whole" ? hit!.field : hit!.sub ? `${hit!.field}.${hit!.sub}` : `${hit!.field}.${hit!.paths![0]}`));
            const cipher = await getCipher();
            const newValues: Record<string, any> = { ...values };
            for (const { k, hit } of hits) {
                const v = newValues[k];
                if (v === undefined || v === null) continue;
                if (hit!.kind === "whole") {
                    newValues[k] = await cipher.encrypt(JSON.stringify(v));
                } else if (hit!.sub === null) {
                    // whole json replacement → encrypt the configured paths inside
                    newValues[k] = await encryptAt(cipher, v, hit!.paths!);
                } else {
                    // dot-notation leaf ('address.zip') → encrypt the value directly
                    newValues[k] = await cipher.encrypt(JSON.stringify(v));
                }
            }
            out[op] = newValues;
        } else if (op === "$unset" || op === "$rename" || op === "$currentDate") {
            // safe on encrypted fields — no value written
        } else if (op.startsWith("$") && values && typeof values === "object") {
            const targets = Object.keys(values).filter((k) => resolveKey(k) !== null);
            if (targets.length) {
                throw new AppError(
                    `Operator ${op} on encrypted field(s) [${targets.join(", ")}] is not supported — only $set/$setOnInsert can write encrypted fields`,
                    { code: "ENCRYPTED_FIELD_OPERATOR", status: 400 }
                );
            }
        }
    }
    return out;
}

/** Decrypt the encrypted values in a read result (new object; non-ciphertext kept as-is) — manual use */
export async function decryptFields(col: Collection | null, doc: any): Promise<any> {
    const names = encryptedFields(col);
    const pathFields = encryptedPaths(col);
    if ((!names.length && !pathFields.length) || !doc || typeof doc !== "object" || !cfg.server.encryption?.mode) return doc;
    const out: Record<string, any> = { ...doc };
    const cipher = await getCipher();
    for (const name of names) {
        const v = out[name];
        if (typeof v === "string") {
            try {
                out[name] = await cipher.decrypt(v, true);
            } catch {
                // not a ciphertext (legacy plaintext) → keep as-is
            }
        }
    }
    for (const { name, paths } of pathFields) {
        const v = out[name];
        if (v && typeof v === "object") out[name] = await decryptAt(cipher, v, paths);
    }
    return out;
}

async function decryptAt(cipher: any, value: any, paths: string[]): Promise<any> {
    if (Array.isArray(value)) {
        return Promise.all(value.map((item) => decryptAt(cipher, item, paths)));
    }
    if (!value || typeof value !== "object") return value;
    const out: Record<string, any> = { ...value };
    for (const p of paths) {
        const v = getPath(out, p);
        if (typeof v === "string") {
            try {
                setPath(out, p, await cipher.decrypt(v, true));
            } catch {
                // not a ciphertext → keep as-is
            }
        }
    }
    return out;
}
