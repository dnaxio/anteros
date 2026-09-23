import { createAgents } from "./agents";
import { endpoints } from "./endpoints";
import { handleDelete } from "./files";
import type { useRest } from "../database/rest";
import type { Agent } from "./agent";
import type { FindCallOptions, FindOptions, findOneOptions } from "../types/mongo";
import type { updateApiOptions } from "../types/api";
import type { TenantVars } from "../types/vars";
import type { BulkUpdateOperation } from "../types/rest";
import type {
    AnyBulkWriteOperation,
    BulkWriteOptions,
    BulkWriteResult,
    ChangeStream,
    ChangeStreamOptions,
    DeleteResult,
    Document,
    UpdateFilter,
    UpdateResult,
} from "mongodb";

type Rest = InstanceType<typeof useRest>;

/**
 * The in-process facade — an `api` member in every context, next to `rest`,
 * `io` and `agents`.
 *
 * It is **the same thing as `rest`, grouped the way the SDK and the HTTP API are
 * grouped**: one namespace per family, and a **bound client** for a collection.
 * Nothing is re-implemented — every call lands on the very same `rest` method the
 * context already had, so audit, hooks, access rules, the session and the
 * transaction are those of the caller.
 *
 * ```ts
 * export default define.Hook(async ({ api, rest }) => {
 *   // Bound to one collection — the slug is stated once
 *   const orders = api.collection('orders');
 *   const [order] = await orders.find({ $match: { status: 'paid' }, $limit: 1 });
 *   await orders.updateOne(order._id, { $set: { status: 'shipped' } });
 *
 *   // The families
 *   await api.vars.set('config', 'lastRun', new Date().toISOString());
 *   await api.service('analytics').run('refresh', { orderId: order._id });
 *   const url = api.files.url('invoices', 'f1.pdf', { width: 800 });
 *   await api.agent('triage')?.generate(`Classify: ${order.ref}`);
 *
 *   // …and `rest` stays exactly what it was
 *   await rest.aggregate('orders', [{ $count: 'total' }]);
 * });
 * ```
 *
 * Naming rule, shared with the SDK: **singular = a client bound to one resource**
 * (`api.collection(slug)`, `api.agent(id)`), **plural = the family's operations**
 * (`api.vars`, `api.files`).
 */

/** One collection, bound to the `rest` of the context. */
class ApiCollection<T = any> {
    #rest: Rest;
    #slug: string;

    constructor(rest: Rest, slug: string) {
        this.#rest = rest;
        this.#slug = slug;
    }

    /** The slug this client is bound to. */
    getSlug(): string {
        return this.#slug;
    }

    // ── Reads ────────────────────────────────────────────────────────────

    find(params: FindOptions = {}, options: FindCallOptions = {}): Promise<Document[]> {
        return this.#rest.find(this.#slug, params, options);
    }

    findOne(_id: string, params?: findOneOptions): Promise<any> {
        return this.#rest.findOne(this.#slug, _id, params);
    }

    aggregate<T = Document>(pipeline: any[]): Promise<T[]> {
        return this.#rest.aggregate(this.#slug, pipeline) as Promise<T[]>;
    }

    countDocuments(query: any = {}): Promise<number> {
        return this.#rest.countDocuments(this.#slug, query);
    }

    /** The collection's change stream — the caller consumes it. */
    watch(pipeline: any[], options: ChangeStreamOptions): Promise<ChangeStream> {
        return this.#rest.watch(this.#slug, pipeline, options);
    }

    // ── Writes ───────────────────────────────────────────────────────────

    insertOne<TBody>(data: TBody): Promise<TBody & { _id: string }> {
        return this.#rest.insertOne(this.#slug, data);
    }

    insertMany<TBody>(data: TBody[]): Promise<(TBody & { _id: string })[]> {
        return this.#rest.insertMany(this.#slug, data);
    }

    updateOne(_id: string, update: UpdateFilter<any>): Promise<UpdateResult & { previous?: any }> {
        return this.#rest.updateOne(this.#slug, _id, update) as Promise<UpdateResult & { previous?: any }>;
    }

    findOneAndUpdate(
        filter: Document,
        update: UpdateFilter<any>,
        options?: updateApiOptions,
    ): Promise<Document | null> {
        return this.#rest.findOneAndUpdate(this.#slug, filter, update, options);
    }

    updateMany(_ids: string[], update: UpdateFilter<any>): Promise<UpdateResult> {
        return this.#rest.updateMany(this.#slug, _ids, update);
    }

    deleteOne(_id: string): Promise<any> {
        return this.#rest.deleteOne(this.#slug, _id);
    }

    deleteMany(_ids: string[]): Promise<DeleteResult> {
        return this.#rest.deleteMany(this.#slug, _ids);
    }

    bulkWrite(operations: AnyBulkWriteOperation[], options?: BulkWriteOptions): Promise<BulkWriteResult> {
        return this.#rest.bulkWrite(this.#slug, operations, options);
    }

    bulkUpdate(operations: BulkUpdateOperation[], options?: BulkWriteOptions): Promise<BulkWriteResult> {
        return this.#rest.bulkUpdate(this.#slug, operations, options);
    }

    // ── Maintenance & custom actions ─────────────────────────────────────

    dropCollection(): Promise<any> {
        return this.#rest.dropCollection(this.#slug);
    }

    dropIndex(index: string): Promise<any> {
        return this.#rest.dropIndex(this.#slug, index);
    }

    dropIndexes(): Promise<any> {
        return this.#rest.dropIndexes(this.#slug);
    }

    /** A custom action declared on the collection (`define.Action` / `actions`). */
    runAction<T = any>(action: string, data?: any): Promise<T> {
        return this.#rest.runAction<T>(this.#slug, action, data);
    }
}

/** One service of the tenant, bound to its name — `api.service('analytics')`. */
class ApiService {
    #rest: Rest;
    #name: string;

    constructor(rest: Rest, name: string) {
        this.#rest = rest;
        this.#name = name;
    }

    /** The service name this client is bound to. */
    getName(): string {
        return this.#name;
    }

    /** Run one action of the service — `data` is what the handler reads as `body.data`. */
    run<T = any>(action: string, data?: any): Promise<T> {
        return this.#rest.runService<T>(this.#name, action, data);
    }
}

/** The `api` member of a context — see the class doc for the convention. */
type Api = {
    /** One collection, bound: `api.collection('orders').find(...)`. */
    collection<T = any>(slug: string): ApiCollection<T>;
    /** The tenant's variables — the same object as `rest.vars`. */
    vars: TenantVars;
    /** One service, bound: `api.service('analytics').run('monthly', data)`. */
    service<T = any>(name: string): ApiService & { run<R = T>(action: string, data?: any): Promise<R> };
    /** File collections — the URL of a stored file, and its deletion. */
    files: {
        url(collection: string, filename: string, transform?: {
            width?: number;
            height?: number;
            format?: "webp" | "jpeg" | "png" | "avif";
            quality?: number;
        }): string;
        delete(collection: string, fileId: string): Promise<{ message: string; ok: boolean }>;
    };
    /** One agent of the tenant, bound to the same `rest` — `undefined` if unknown. */
    agent(id: string): Agent | undefined;
};

/**
 * Build the `api` facade of a context. Everything delegates to `rest`, so a hook,
 * a script or a workflow step gets the same client it already had — only the shape
 * changes.
 */
function createApi(rest: Rest): Api {
    const tenant = rest.tenant_id;
    const registry = createAgents(tenant, rest);

    return {
        collection: <T = any>(slug: string) => new ApiCollection<T>(rest, slug),
        // `rest.vars` returns a fresh bound client on each access — keep that
        get vars() {
            return rest.vars;
        },
        service: (name: string) => new ApiService(rest, name),
        files: {
            /** `/api/<tenant>/files/<collection>/<file>` (+ `w`, `h`, `format`, `q`). */
            url(collection: string, filename: string, transform?: {
                width?: number;
                height?: number;
                format?: "webp" | "jpeg" | "png" | "avif";
                quality?: number;
            }): string {
                const base = endpoints.file(tenant, collection, filename);
                if (!transform) return base;

                const params = new URLSearchParams();
                if (transform.width) params.set("w", String(transform.width));
                if (transform.height) params.set("h", String(transform.height));
                if (transform.format) params.set("format", transform.format);
                if (transform.quality) params.set("q", String(transform.quality));

                const query = params.toString();
                return query ? `${base}?${query}` : base;
            },
            /** Removes the stored binary **and** the document (the route does the same). */
            delete(collection: string, fileId: string) {
                return handleDelete(tenant, collection, fileId).then(() => ({ message: "File deleted", ok: true }));
            },
        },
        agent: (id: string) => registry.get(id),
    } as Api;
}

export { ApiCollection, ApiService, createApi };
export type { Api };
