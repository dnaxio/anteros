import type { Field } from "./field";
import type { useRest } from "../database/rest";
import type { fn } from "../lib/error";
import type { jwt } from "../utils/func";

/** Actions exposed by the variables HTTP API (`POST /vars/:tenant_id/:action`). */
export type VarsActions =
    | "set"
    | "setMany"
    | "get"
    | "entry"
    | "entries"
    | "all"
    | "del"
    | "has"
    | "incr"
    | "expire"
    | "clear";

/** Access rule context for a vars action. */
export type VarsAccessContext = {
    rest: InstanceType<typeof useRest>;
    /** Namespace targeted by the request. */
    namespace: string;
    /** Raw request body. */
    body: any;
    error: typeof fn.error;
    jwt: typeof jwt;
    token: { value: string | null; decoded: Record<string, unknown> | null; provided: boolean; expired: boolean };
};

/** Per-action access rules — `'*'` wildcard, same pattern as collections. */
export type VarsAccess = {
    [key in VarsActions | (string & {})]?: boolean | ((ctx: VarsAccessContext) => boolean | Promise<boolean>);
};

/** HTTP API configuration of a vars namespace (declared in `define.Vars`). */
export type VarsApi = {
    /** Access rules per action — **no rules = denied** (secure by default). */
    access?: VarsAccess;
};

/**
 * Value spec for a variable — a `Field` (minus `name`) plus an optional default
 * TTL. Use it when a variable needs a type / validation / a default value / a TTL:
 *
 * ```ts
 * vars: {
 *   maxUsers: 100,                                  // shorthand: raw default
 *   licence: { type: 'string', defaultValue: 'RDX00', ttl: '30d' },
 * }
 * ```
 */
export type VarSpec = Omit<Field, "name"> & {
    /** Default TTL for this variable — human string (`'30m'`, `'2h'`, `'1d'`) or ms. */
    ttl?: string | number;
};

/** Per-namespace replication opt-in (`define.Vars({ replication: { enabled: true } })`). */
export type VarsReplicationConfig = {
    /** Replicate the `_vars_` documents of THIS namespace. */
    enabled: boolean;
};

/**
 * A tenant variable definition — `{tenant.dir}/vars/**\/*.var.ts`.
 *
 * - `scope` — **one** optional identity field (often a `relationship`): its value
 *   is part of the entry key, so each company/branch/environment gets its own value.
 * - `meta` — annotation fields: validated, stored alongside — **never** part of the key.
 * - `vars` — values: a raw default, or a `VarSpec`.
 */
export type VarDefinition = {
    _isVars_?: boolean;
    /** Injected by the loader — the tenant this definition belongs to. */
    _tenant_?: string;
    /** Namespace grouping these variables (required). */
    namespace: string;
    /** Optional identity field — its value is part of the entry key. */
    scope?: Field;
    /** Annotation fields — validated, never part of the key. */
    meta?: Field[];
    /** Variables — a raw default value, or a `VarSpec`. */
    vars: Record<string, any>;
    /** HTTP API access rules — required to expose this namespace over `POST /vars/:tenant_id/:action`. */
    api?: VarsApi;
    /** Opt this namespace into replication — like a collection, but scoped to this namespace. */
    replication?: VarsReplicationConfig;
};

/** A stored variable entry, as returned by `rest.vars.entry()` / `.entries()`. */
export type VarEntry<T = any> = {
    ns: string;
    key: string;
    scope: any;
    value: T;
    meta: Record<string, any>;
    expiresAt: Date | null;
    createdAt?: Date;
    updatedAt: Date;
};

/** Scope option shared by every `rest.vars` method. */
export type VarsOptions = { scope?: any };

export type VarsSetOptions = VarsOptions & {
    /** Annotation values — validated against the namespace `meta` fields. */
    meta?: Record<string, any>;
    /** Time-to-live — human string or ms. Pass `null` to clear an existing TTL. */
    ttl?: string | number | null;
};

export type VarsAllOptions = VarsOptions & {
    /** Filter on `meta` fields (e.g. `{ note: 'x' }` → `{ 'meta.note': 'x' }`). */
    where?: Record<string, any>;
};

/**
 * Tenant-scoped key/value store — `rest.vars` (like Redis, MongoDB-backed).
 * The tenant is implicit (like every `rest.*` accessor).
 */
export type TenantVars = {
    /** Set a value. `ttl` replaces the entry's TTL (omit to store without expiry). */
    set(ns: string, key: string, value: any, opts?: VarsSetOptions): Promise<void>;
    /** Set several keys at once (shared `meta` / `ttl`). */
    setMany(ns: string, entries: Record<string, any>, opts?: VarsSetOptions): Promise<void>;
    /** Read a value — `undefined` when missing or expired. */
    get<T = any>(ns: string, key: string, opts?: VarsOptions): Promise<T | undefined>;
    /** Read the full entry (value + meta + expiry). */
    entry<T = any>(ns: string, key: string, opts?: VarsOptions): Promise<VarEntry<T> | undefined>;
    /** All entries of a namespace (current scope). */
    entries(ns: string, opts?: VarsAllOptions): Promise<VarEntry[]>;
    /** All key/value pairs of a namespace (current scope). */
    all(ns: string, opts?: VarsAllOptions): Promise<Record<string, any>>;
    /** Delete a key — `true` when a key was removed. */
    del(ns: string, key: string, opts?: VarsOptions): Promise<boolean>;
    /** Whether a (non-expired) key exists. */
    has(ns: string, key: string, opts?: VarsOptions): Promise<boolean>;
    /** Atomic increment (default `1`) — does not clear an existing TTL. */
    incr(ns: string, key: string, by?: number, opts?: VarsSetOptions): Promise<number>;
    /** Set / renew the TTL of an existing key. */
    expire(ns: string, key: string, ttl: string | number, opts?: VarsOptions): Promise<boolean>;
    /** Delete every key of the namespace in the current scope. */
    clear(ns: string, opts?: VarsOptions): Promise<number>;
    /** Bound store with the scope pre-filled — `rest.vars.scope(companyId)`. */
    scope(value: any): TenantVars;
};
