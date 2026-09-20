import type { RestRequestOptions } from "../types/rest";
import type { VarEntry, VarsAllOptions, VarsScopeOptions, VarsSetOptions } from "../types/vars";

type Post = (action: string, body: any, options?: RestRequestOptions) => Promise<any>;

/**
 * Tenant-scoped variables API — `api.vars` (see the server's `rest.vars`).
 * Calls `POST /vars/:tenant_id/:action`; the tenant is the one passed to `new Rest()`.
 *
 * ```ts
 * await api.vars.set('config', 'licence', 'RDX00');
 * const licence = await api.vars.get('config', 'licence');
 * const acme = api.vars.scope(companyId);          // per-company store
 * await acme.set('config', 'licence', 'ACME-001', { ttl: '30d' });
 * ```
 */
class Vars {
    #post: Post;
    #scope?: any;

    constructor(post: Post, scope?: any) {
        this.#post = post;
        this.#scope = scope;
    }

    /** Bound store with the scope pre-filled. */
    scope(value: any): Vars {
        return new Vars(this.#post, value);
    }

    /** Explicit `{ scope }` wins over the bound scope. */
    #scopeBody(opts?: VarsScopeOptions): Record<string, any> {
        const scope = opts && "scope" in opts ? opts.scope : this.#scope;
        return scope === undefined ? {} : { scope };
    }

    /** Set a value (`ttl` replaces the entry's TTL). */
    async set(ns: string, key: string, value: any, opts?: VarsSetOptions): Promise<void> {
        await this.#post("set", { ns, key, value, meta: opts?.meta, ttl: opts?.ttl, ...this.#scopeBody(opts) });
    }

    /** Set several keys at once (shared `meta` / `ttl`). */
    async setMany(ns: string, entries: Record<string, any>, opts?: VarsSetOptions): Promise<void> {
        await this.#post("setMany", { ns, entries, meta: opts?.meta, ttl: opts?.ttl, ...this.#scopeBody(opts) });
    }

    /** Read a value — `undefined` when missing or expired. */
    async get<T = any>(ns: string, key: string, opts?: VarsScopeOptions): Promise<T | undefined> {
        const res = await this.#post("get", { ns, key, ...this.#scopeBody(opts) });
        return res?.value as T | undefined;
    }

    /** Read the full entry (value + meta + expiry). */
    async entry<T = any>(ns: string, key: string, opts?: VarsScopeOptions): Promise<VarEntry<T> | undefined> {
        const res = await this.#post("entry", { ns, key, ...this.#scopeBody(opts) });
        return res?.entry as VarEntry<T> | undefined;
    }

    /** All entries of a namespace (filter on `meta` with `where`). */
    async entries(ns: string, opts?: VarsAllOptions): Promise<VarEntry[]> {
        const res = await this.#post("entries", { ns, where: opts?.where, ...this.#scopeBody(opts) });
        return (res?.entries ?? []) as VarEntry[];
    }

    /** All key/value pairs of a namespace. */
    async all(ns: string, opts?: VarsAllOptions): Promise<Record<string, any>> {
        const res = await this.#post("all", { ns, where: opts?.where, ...this.#scopeBody(opts) });
        return (res?.vars ?? {}) as Record<string, any>;
    }

    /** Delete a key — `true` when a key was removed. */
    async del(ns: string, key: string, opts?: VarsScopeOptions): Promise<boolean> {
        const res = await this.#post("del", { ns, key, ...this.#scopeBody(opts) });
        return !!res?.ok;
    }

    /** Whether a (non-expired) key exists. */
    async has(ns: string, key: string, opts?: VarsScopeOptions): Promise<boolean> {
        const res = await this.#post("has", { ns, key, ...this.#scopeBody(opts) });
        return !!res?.exists;
    }

    /** Atomic increment (default `1`). */
    async incr(ns: string, key: string, by = 1, opts?: VarsSetOptions): Promise<number> {
        const res = await this.#post("incr", { ns, key, by, ttl: opts?.ttl, ...this.#scopeBody(opts) });
        return Number(res?.value);
    }

    /** Set / renew the TTL of an existing key. */
    async expire(ns: string, key: string, ttl: string | number, opts?: VarsScopeOptions): Promise<boolean> {
        const res = await this.#post("expire", { ns, key, ttl, ...this.#scopeBody(opts) });
        return !!res?.ok;
    }

    /** Delete every key of the namespace in the current scope — returns the count. */
    async clear(ns: string, opts?: VarsScopeOptions): Promise<number> {
        const res = await this.#post("clear", { ns, ...this.#scopeBody(opts) });
        return Number(res?.deleted ?? 0);
    }
}

export { Vars };
