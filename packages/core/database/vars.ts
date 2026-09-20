import { Glob } from "bun";
import path from "path";
import fs from "fs/promises";
import Joi, { type AnySchema } from "joi";
import { ObjectId } from "mongodb";
import { cfg } from "../server/config";
import { getTenant } from "./tenant";
import { logger } from "../utils/logger";
import { fieldToSchema } from "./schema";
import { writeDeleteMarkers } from "./deleteLog";
import { AppError } from "../lib/error";
import * as func from "../utils/func";
import type { Field } from "../types/field";
import type {
    TenantVars,
    VarDefinition,
    VarEntry,
    VarSpec,
    VarsAllOptions,
    VarsOptions,
    VarsSetOptions,
} from "../types/vars";

/** System collection holding the variables — one document per `(scope, namespace, key)`. */
const COLLECTION = "_vars_";

/** Compiled definition of one namespace — schemas precompiled at boot. */
type Compiled = {
    namespace: string;
    scope?: Field;
    meta: Field[];
    /** key → value schema (`undefined` when the variable is free-form). */
    schemas: Map<string, AnySchema | undefined>;
    /** key → default TTL (ms). */
    ttls: Map<string, number | undefined>;
    /** key → default value seeded at boot. */
    defaults: Map<string, any>;
    metaSchema?: AnySchema;
};

/** `${tenantId}:${namespace}` → compiled definition. */
const compiled = new Map<string, Compiled>();

const compiledKey = (tenantId: string, ns: string) => `${tenantId}:${ns}`;

/** Deterministic entry id — `scope:ns:key`, or `ns:key` when unscoped. */
function varId(scope: string | null, ns: string, key: string): string {
    return scope ? `${scope}:${ns}:${key}` : `${ns}:${key}`;
}

function scopeToString(scope: any): string | null {
    if (scope === undefined || scope === null || scope === "") return null;
    return String(scope);
}

/** A `VarSpec` is an object with a string `type`; anything else is a raw default value. */
function isVarSpec(value: any): value is VarSpec {
    return !!value && typeof value === "object" && !Array.isArray(value) && typeof (value as any).type === "string";
}

function validationError(ns: string, message: string): AppError {
    return new AppError(`[vars] ${ns}: ${message}`, { code: "VALIDATION_ERROR", status: 400 });
}

/** Validate (and normalize) a value against its variable spec. */
function validateValue(def: Compiled | undefined, key: string, value: any): any {
    const schema = def?.schemas.get(key);
    if (!schema) return value;
    const { error, value: out } = schema.validate(value, { abortEarly: false });
    if (error) throw validationError(def!.namespace, `${key} — ${error.message}`);
    return out;
}

/** Validate the `meta` object against the namespace meta fields. */
function validateMeta(def: Compiled | undefined, meta: any): Record<string, any> {
    const input = meta ?? {};
    // Undeclared namespace → free-form meta.
    if (!def) return input;
    // Declared namespace without `meta` fields → reject any meta (catches typos).
    if (!def.metaSchema) {
        if (Object.keys(input).length) {
            throw validationError(def.namespace, "no `meta` field is declared for this namespace");
        }
        return {};
    }
    const { error, value } = def.metaSchema.validate(input, { abortEarly: false });
    if (error) throw validationError(def.namespace, `meta — ${error.message}`);
    return value as Record<string, any>;
}

/** Validate (and normalize) the scope value, using the namespace's `scope` field when declared. */
function validateScope(def: Compiled | undefined, scope: any): any {
    if (scope === undefined || scope === null || scope === "") return null;
    if (!def?.scope) return scope;
    const schema = fieldToSchema(def.scope);
    const { error, value } = schema!.validate(scope);
    if (error) throw validationError(def.namespace, `${def.scope.name} — ${error.message}`);
    // Keep a real reference for relationship scopes (so indexes / $lookup work).
    if (def.scope.type === "relationship" && typeof value === "string" && ObjectId.isValid(value)) {
        return new ObjectId(value);
    }
    return value;
}

/** Resolve the TTL in ms — `undefined` means "no TTL". */
function resolveTtl(def: Compiled | undefined, key: string, ttl?: string | number | null): number | null {
    const raw = ttl !== undefined ? ttl : def?.ttls.get(key);
    if (raw === undefined || raw === null) return null;
    const ms = func.parseDuration(raw);
    if (ms === null) throw validationError(def?.namespace ?? "?", `invalid ttl '${raw}'`);
    return ms;
}

/**
 * Tenant-scoped key/value store — `rest.vars`. MongoDB-backed (durable), one
 * document per `(scope, namespace, key)`. Entries may carry a TTL — enforced by a
 * MongoDB TTL index **and** re-checked at read time (TTL deletion is lazy).
 *
 * Unlike `rest.cache` (ephemeral, pluggable driver), variables persist and are
 * meant for configuration-like values.
 */
function createVars(tenantId: string, boundScope?: any): TenantVars {
    // any: the driver types `_id` as ObjectId while we use string ids here
    const col = (): any => {
        const db = getTenant(tenantId)?.database?.db;
        if (!db) throw new Error(`vars: tenant '${tenantId}' database is not connected`);
        return db.collection(COLLECTION);
    };

    /** Excludes expired entries (the TTL index is lazy — up to ~60s). */
    const alive = () => ({
        $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
    });

    const defOf = (ns: string) => compiled.get(compiledKey(tenantId, ns));

    /** Write delete tombstones for `_vars_` — only for namespaces that opted into replication. */
    const markDeleted = async (ns: string, ids: string[]): Promise<void> => {
        if (!ids.length || !getVarsDefinition(tenantId, ns)?.replication?.enabled) return;
        const db = getTenant(tenantId)?.database?.db;
        if (!db) return;
        await writeDeleteMarkers(db, tenantId, "_vars_", ids);
    };

    /** Resolve the effective scope for a call (explicit option wins over the bound scope). */
    const resolveScope = (ns: string, opts?: VarsOptions) => {
        const raw = opts && "scope" in opts ? opts.scope : boundScope;
        const value = validateScope(defOf(ns), raw);
        return { id: scopeToString(value), value };
    };

    const toEntry = (doc: any): VarEntry => ({
        ns: doc.ns,
        key: doc.key,
        scope: doc.scope ?? null,
        value: doc.value,
        meta: doc.meta ?? {},
        expiresAt: doc.expiresAt ?? null,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    });

    /** Live documents of a namespace, optionally filtered on `meta` fields. */
    const findEntries = async (ns: string, opts?: VarsAllOptions): Promise<any[]> => {
        const scope = resolveScope(ns, opts);
        const where = opts?.where ?? {};
        const metaFilter = Object.fromEntries(Object.entries(where).map(([k, v]) => [`meta.${k}`, v]));
        return await col().find({ ns, scope: scope.value, ...metaFilter, ...alive() }).toArray();
    };

    return {
        async set(ns, key, value, opts?: VarsSetOptions): Promise<void> {
            const def = defOf(ns);
            const scope = resolveScope(ns, opts);
            const stored = validateValue(def, key, value);
            const meta = validateMeta(def, opts?.meta);
            const ttl = resolveTtl(def, key, opts?.ttl);

            const now = new Date();
            const $set: Record<string, any> = { ns, key, scope: scope.value, value: stored, meta, updatedAt: now };
            const update: Record<string, any> = { $set, $setOnInsert: { createdAt: now } };
            // `set` is authoritative: it replaces the TTL (like Redis SET).
            if (ttl !== null) $set.expiresAt = new Date(now.getTime() + ttl);
            else update.$unset = { expiresAt: "" };

            await col().updateOne({ _id: varId(scope.id, ns, key) }, update, { upsert: true });
        },

        async setMany(ns, entries, opts?: VarsSetOptions): Promise<void> {
            const def = defOf(ns);
            const scope = resolveScope(ns, opts);
            const meta = validateMeta(def, opts?.meta);

            const now = new Date();
            const ops = Object.entries(entries).map(([key, value]) => {
                const stored = validateValue(def, key, value);
                const $set: Record<string, any> = { ns, key, scope: scope.value, value: stored, meta, updatedAt: now };
                const update: Record<string, any> = { $set, $setOnInsert: { createdAt: now } };
                const entryTtl = resolveTtl(def, key, opts?.ttl);
                if (entryTtl !== null) $set.expiresAt = new Date(now.getTime() + entryTtl);
                else update.$unset = { expiresAt: "" };
                return { updateOne: { filter: { _id: varId(scope.id, ns, key) }, update, upsert: true } };
            });
            if (ops.length) await col().bulkWrite(ops, { ordered: false });
        },

        async get<T = any>(ns: string, key: string, opts?: VarsOptions): Promise<T | undefined> {
            const scope = resolveScope(ns, opts);
            const doc = await col().findOne({ _id: varId(scope.id, ns, key), ...alive() });
            return doc?.value as T | undefined;
        },

        async entry<T = any>(ns: string, key: string, opts?: VarsOptions): Promise<VarEntry<T> | undefined> {
            const scope = resolveScope(ns, opts);
            const doc = await col().findOne({ _id: varId(scope.id, ns, key), ...alive() });
            return doc ? (toEntry(doc) as VarEntry<T>) : undefined;
        },

        async entries(ns: string, opts?: VarsAllOptions): Promise<VarEntry[]> {
            const docs = await findEntries(ns, opts);
            return docs.map(toEntry);
        },

        async all(ns: string, opts?: VarsAllOptions): Promise<Record<string, any>> {
            const docs = await findEntries(ns, opts);
            const out: Record<string, any> = {};
            for (const doc of docs) out[doc.key] = doc.value;
            return out;
        },

        async del(ns: string, key: string, opts?: VarsOptions): Promise<boolean> {
            const scope = resolveScope(ns, opts);
            const id = varId(scope.id, ns, key);
            const res = await col().deleteOne({ _id: id });
            const removed = (res?.deletedCount ?? 0) > 0;
            if (removed) await markDeleted(ns, [id]);
            return removed;
        },

        async has(ns: string, key: string, opts?: VarsOptions): Promise<boolean> {
            const scope = resolveScope(ns, opts);
            const doc = await col().findOne({ _id: varId(scope.id, ns, key), ...alive() }, { projection: { _id: 1 } });
            return !!doc;
        },

        async incr(ns: string, key: string, by = 1, opts?: VarsSetOptions): Promise<number> {
            const def = defOf(ns);
            const scope = resolveScope(ns, opts);
            const ttl = resolveTtl(def, key, opts?.ttl);
            const now = new Date();

            const $set: Record<string, any> = { ns, key, scope: scope.value, updatedAt: now };
            // Only touch the TTL when a TTL is resolved (like Redis INCR — keeps the existing one).
            if (ttl !== null) $set.expiresAt = new Date(now.getTime() + ttl);
            const doc = await col().findOneAndUpdate(
                { _id: varId(scope.id, ns, key) },
                { $inc: { value: by }, $set, $setOnInsert: { createdAt: now, meta: {} } },
                { upsert: true, returnDocument: "after" },
            );
            return Number(doc?.value ?? by);
        },

        async expire(ns: string, key: string, ttl: string | number, opts?: VarsOptions): Promise<boolean> {
            const def = defOf(ns);
            const scope = resolveScope(ns, opts);
            const ms = resolveTtl(def, key, ttl);
            if (ms === null) throw validationError(ns, `invalid ttl '${ttl}'`);
            const now = new Date();
            const res = await col().updateOne(
                { _id: varId(scope.id, ns, key), ...alive() },
                { $set: { expiresAt: new Date(now.getTime() + ms), updatedAt: now } },
            );
            return (res?.matchedCount ?? 0) > 0;
        },

        async clear(ns: string, opts?: VarsOptions): Promise<number> {
            const scope = resolveScope(ns, opts);
            const filter = { ns, scope: scope.value };
            const docs = await col().find(filter, { projection: { _id: 1 } }).toArray();
            const res = await col().deleteMany(filter);
            await markDeleted(ns, docs.map((d: any) => d._id));
            return res?.deletedCount ?? 0;
        },

        scope(value: any): TenantVars {
            return createVars(tenantId, value);
        },
    };
}

/** Raw `define.Vars` definition for a tenant + namespace (used by the HTTP API). */
function getVarsDefinition(tenantId: string, namespace: string): VarDefinition | undefined {
    return (cfg.vars ?? []).find((v) => v._tenant_ === tenantId && v.namespace === namespace);
}

/**
 * Load `{tenant.dir}/vars/**\/*.var.ts` for every tenant, precompile the
 * validation schemas, seed the default values at the **global** scope (a key that
 * already exists is never overwritten), and ensure the indexes.
 */
async function syncVars(): Promise<void> {
    try {
        compiled.clear();
        const definitions: VarDefinition[] = [];

        for (const tenant of cfg.tenants ?? []) {
            const VARS_PATH = path.join(process.cwd(), tenant.dir, "vars");
            if (!(await fs.exists(VARS_PATH))) continue;
            if (!(await fs.stat(VARS_PATH)).isDirectory()) continue;

            const glob = new Glob(path.join(VARS_PATH, "**/*.var.ts"));
            for await (const file of glob.scan(".")) {
                const module = await import(file);
                if (module?.default?._isVars_) {
                    definitions.push({ ...module.default, _tenant_: tenant.id });
                }
            }
        }

        cfg.vars = definitions;

        // Always index the variables collection — per tenant, even without any
        // `define.Vars`: the `scope` index (all lookups are scoped) and the TTL
        // index. Built in the background so boot is never blocked.
        for (const tenant of cfg.tenants ?? []) {
            const db = getTenant(tenant.id)?.database?.db;
            if (!db) continue;
            const col: any = db.collection(COLLECTION);
            try { await col.createIndex({ scope: 1, ns: 1 }, { background: true }); } catch { /* ignore */ }
            try { await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, background: true }); } catch { /* ignore */ }
        }

        for (const definition of definitions) {
            const tenantId = definition._tenant_!;
            const db = getTenant(tenantId)?.database?.db;
            if (!db) continue;

            const schemas = new Map<string, AnySchema | undefined>();
            const ttls = new Map<string, number | undefined>();
            const defaults = new Map<string, any>();

            for (const [key, raw] of Object.entries(definition.vars ?? {})) {
                if (isVarSpec(raw)) {
                    schemas.set(key, fieldToSchema({ name: key, ...raw }));
                    ttls.set(key, raw.ttl != null ? (func.parseDuration(raw.ttl) ?? undefined) : undefined);
                    if (raw.defaultValue !== undefined) defaults.set(key, raw.defaultValue);
                } else {
                    defaults.set(key, raw);
                }
            }

            const meta = definition.meta ?? [];
            const metaSchema = meta.length
                ? Joi.object(Object.fromEntries(meta.map((f) => [f.name, fieldToSchema(f)!])))
                : undefined;

            compiled.set(compiledKey(tenantId, definition.namespace), {
                namespace: definition.namespace,
                scope: definition.scope,
                meta,
                schemas,
                ttls,
                defaults,
                metaSchema,
            });

            const col: any = db.collection(COLLECTION);
            const now = new Date();

            // Seed defaults at the global scope — `$setOnInsert` never overwrites.
            const ops = [...defaults.entries()].map(([key, value]) => ({
                updateOne: {
                    filter: { _id: varId(null, definition.namespace, key) },
                    update: {
                        $setOnInsert: {
                            ns: definition.namespace, key, scope: null, value, meta: {},
                            createdAt: now, updatedAt: now,
                        },
                    },
                    upsert: true,
                },
            }));
            if (ops.length) await col.bulkWrite(ops, { ordered: false });

            // Per-field `meta` indexes (only when the field is marked `index: true`).
            for (const f of meta) {
                if (f.index) { try { await col.createIndex({ [`meta.${f.name}`]: 1 }, { background: true }); } catch { /* ignore */ } }
            }
        }

        if (definitions.length) {
            logger.file("vars: loaded", {
                definitions: definitions.map((d) => `${d._tenant_}:${d.namespace}`),
            });
        }
    } catch (err: any) {
        console.error("Failed to sync vars:", err?.message);
    }
}

export {
    createVars,
    syncVars,
    getVarsDefinition,
};
