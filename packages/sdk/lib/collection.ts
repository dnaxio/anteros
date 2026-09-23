import type { FindOptions, RestClientOptions, RestRequestOptions } from "../types/rest";

/** What the collection client calls to reach the wire — `Rest` owns the transport. */
type Post = (action: string, body?: unknown, options?: RestRequestOptions) => Promise<any>;

type Defaults = NonNullable<RestClientOptions["defaultParams"]>;

/**
 * One collection of the tenant — `api.collection('users')`.
 * Talks to `POST /api/:tenant/collections/:collection/:action`.
 *
 * The point of the bound client is that the **slug is stated once** (with its row
 * type) and never repeated per call, which is also what makes the argument order
 * impossible to get wrong: `find` takes the query, `findOne` takes an id, and
 * neither can be mistaken for the other.
 *
 * ```ts
 * const users = api.collection<User>('users');
 *
 * const page = await users.find({ $match: { active: true }, $limit: 20 });
 * const one = await users.findOne('64f1a2b3c4d5e6f7a8b9c0d1');
 * await users.insertOne({ name: 'Ada' });
 * await users.updateOne(id, { $set: { name: 'Ada L.' } });
 * await users.runAction('invite', { email });
 * const { token } = await users.login({ email, password });
 * ```
 */
class Collection<T = any> {
    #slug: string;
    #post: Post;
    #defaults: Defaults;
    /** The token lives on the client, not here: `login`/`logout` set it there. */
    #onToken: (token?: string) => void;

    constructor(slug: string, post: Post, options: { defaults?: Defaults; onToken?: (token?: string) => void } = {}) {
        this.#slug = slug;
        this.#post = post;
        this.#defaults = options.defaults ?? {};
        this.#onToken = options.onToken ?? (() => {});
    }

    /** The collection slug this client is bound to. */
    getSlug(): string {
        return this.#slug;
    }

    // ── Authentication (a collection with `api.auth` enabled) ────────────

    /** Authenticate and store the token on the client — every later call carries it. */
    async login<TData = any>(
        payload: Record<string, unknown>,
        options?: RestRequestOptions,
    ): Promise<{ token: string; data: TData }> {
        this.#onToken(undefined); // a fresh login never reuses the previous token
        const res = await this.#post("login", { payload }, options) as { token: string; data: TData };
        if (res?.token) this.#onToken(res.token);
        return res;
    }

    async logout<TResponse = any>(
        payload?: Record<string, unknown>,
        options?: RestRequestOptions,
    ): Promise<TResponse> {
        const res = await this.#post("logout", payload ? { payload } : undefined, options) as TResponse;
        this.#onToken(undefined);
        return res;
    }

    // ── Reads ────────────────────────────────────────────────────────────

    async find(params: FindOptions = {}, options?: RestRequestOptions): Promise<T[]> {
        const merged = { ...(this.#defaults.find ?? {}), ...params };
        const { useCache, ...requestOptions } = options ?? {};
        const body: Record<string, unknown> = { params: merged };
        // TTL is managed server-side (collection/server config)
        if (useCache !== undefined) body.options = { useCache };
        return this.#post("find", body, requestOptions) as Promise<T[]>;
    }

    async findOne(id: string, params: Record<string, unknown> = {}, options?: RestRequestOptions): Promise<T | null> {
        const merged = { ...(this.#defaults.findOne ?? {}), ...params };
        return this.#post("findOne", { id, params: merged }, options) as Promise<T | null>;
    }

    async aggregate<U = T>(pipeline: unknown[], options?: RestRequestOptions): Promise<U[]> {
        const extra = this.#defaults.aggregate ?? {};
        return this.#post("aggregate", { pipeline, ...extra }, options) as Promise<U[]>;
    }

    // ── Writes ───────────────────────────────────────────────────────────

    async insertOne<TBody = any>(data: TBody, options?: RestRequestOptions): Promise<T & { _id: string }> {
        const extra = this.#defaults.insertOne ?? {};
        return this.#post("insertOne", { data, ...extra }, options) as Promise<T & { _id: string }>;
    }

    async insertMany<TBody = any>(data: TBody[], options?: RestRequestOptions): Promise<(T & { _id: string })[]> {
        const extra = this.#defaults.insertMany ?? {};
        return this.#post("insertMany", { data, ...extra }, options) as Promise<(T & { _id: string })[]>;
    }

    async updateOne<TUpdate = any>(id: string, update: TUpdate, options?: RestRequestOptions): Promise<T> {
        const extra = this.#defaults.updateOne ?? {};
        return this.#post("updateOne", { id, update, ...extra }, options) as Promise<T>;
    }

    async updateMany<TUpdate = any>(ids: string[], update: TUpdate, options?: RestRequestOptions): Promise<any> {
        const extra = this.#defaults.updateMany ?? {};
        return this.#post("updateMany", { ids, update, ...extra }, options);
    }

    async deleteOne(id: string, options?: RestRequestOptions): Promise<any> {
        const extra = this.#defaults.deleteOne ?? {};
        return this.#post("deleteOne", { id, ...extra }, options);
    }

    async deleteMany(ids: string[], options?: RestRequestOptions): Promise<any> {
        const extra = this.#defaults.deleteMany ?? {};
        return this.#post("deleteMany", { ids, ...extra }, options);
    }

    // ── Custom actions ───────────────────────────────────────────────────

    /** A `define.Action` (or the collection's own) registered on this collection. */
    async runAction<U = any>(action: string, data?: unknown, options?: RestRequestOptions): Promise<U> {
        return this.#post(action, data !== undefined ? { data } : undefined, options) as Promise<U>;
    }
}

export { Collection };
