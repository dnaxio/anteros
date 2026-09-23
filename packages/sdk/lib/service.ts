import type { RestRequestOptions } from "../types/rest";

/** What the service client calls to reach the wire — the transport owns the rest. */
type Post = (action: string, body: unknown, options: RestRequestOptions) => Promise<any>;

/**
 * One service of the tenant, **bound** to its name — `api.service('analytics')`.
 * Talks to `POST /api/:tenant/services/:service/:action`.
 *
 * Exactly like `api.collection(slug)`: the name is stated once, and the verbs are
 * the ones that service actually exposes.
 *
 * ```ts
 * const analytics = api.service('analytics');
 *
 * const report = await analytics.run('generateReport', { from, to });
 * const export_ = await analytics.run('exportCsv');
 * ```
 */
class Service<T = any> {
    #name: string;
    #post: Post;

    constructor(name: string, post: Post) {
        this.#name = name;
        this.#post = post;
    }

    /** The service name this client is bound to. */
    getName(): string {
        return this.#name;
    }

    /** Run one action of the service — `data` is what the handler reads as `body.data`. */
    async run<R = T>(action: string, data?: unknown, options?: RestRequestOptions): Promise<R> {
        return this.#post(action, data !== undefined ? { data } : undefined, options ?? {});
    }
}

export { Service };
