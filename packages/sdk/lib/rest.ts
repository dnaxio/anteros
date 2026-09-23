import { Client } from "./client";
import type { FileResult, FindOptions, RestRequestOptions } from "../types/rest";

/**
 * The **original** client — the flat surface, unchanged.
 *
 * ```ts
 * import { Rest } from '@anteros/sdk';
 *
 * const api = new Rest({ server: 'http://localhost:4000', tenant: 'v1' });
 *
 * const paid = await api.find('orders', { $match: { status: 'paid' } });
 * await api.updateOne('orders', paid[0]._id, { $set: { status: 'shipped' } });
 * await api.upload('photos', file);
 * await api.runService('analytics', 'monthly', { month: '2026-09' });
 * ```
 *
 * Every method still works, with the same signature it always had — a client
 * written before the namespaced client existed needs **no change**: only the
 * URLs it talks to moved (they are built by this class, and the server serves
 * them). For new code, [`Anteros`](./anteros) groups the very same calls per
 * family; the two clients share the transport and can even be used side by side.
 */
class Rest extends Client {
    // ── Authentication ───────────────────────────────────────────────────

    /** Authenticate against an auth-enabled collection and store the token. */
    async login<TData = any>(
        collection: string,
        payload: Record<string, unknown>,
        options?: RestRequestOptions,
    ): Promise<{ token: string; data: TData }> {
        this.clearToken(); // a fresh login never reuses the previous token
        const res = await this.request<{ token: string; data: TData }>(collection, "login", { payload }, options);
        if (res?.token) this.setToken(res.token);
        return res;
    }

    async logout<TResponse = any>(
        collection: string,
        payload?: Record<string, unknown>,
        options?: RestRequestOptions,
    ): Promise<TResponse> {
        const res = await this.request<TResponse>(collection, "logout", payload ? { payload } : undefined, options);
        this.clearToken();
        return res;
    }

    // ── Reads ────────────────────────────────────────────────────────────

    async find<T = any>(
        collection: string,
        params: FindOptions,
        options?: RestRequestOptions,
    ): Promise<T[]> {
        const merged = { ...(this.defaultParams?.find ?? {}), ...params };
        const { useCache, ...requestOptions } = options ?? {};
        const body: Record<string, unknown> = { params: merged };
        if (useCache !== undefined) body.options = { useCache }; // TTL is managed server-side
        return this.request<T[]>(collection, "find", body, requestOptions);
    }

    async findOne<T = any>(
        collection: string,
        id: string,
        params: Record<string, unknown> = {},
        options?: RestRequestOptions,
    ): Promise<T | null> {
        const merged = { ...(this.defaultParams?.findOne ?? {}), ...params };
        return this.request<T | null>(collection, "findOne", { id, params: merged }, options);
    }

    async aggregate<T = any>(
        collection: string,
        pipeline: unknown[],
        options?: RestRequestOptions,
    ): Promise<T[]> {
        const extra = this.defaultParams?.aggregate ?? {};
        return this.request<T[]>(collection, "aggregate", { pipeline, ...extra }, options);
    }

    // ── Writes ───────────────────────────────────────────────────────────

    async insertOne<T = any, TBody = any>(
        collection: string,
        data: TBody,
        options?: RestRequestOptions,
    ): Promise<T & { _id: string }> {
        const extra = this.defaultParams?.insertOne ?? {};
        return this.request<T & { _id: string }>(collection, "insertOne", { data, ...extra }, options);
    }

    async insertMany<T = any, TBody = any>(
        collection: string,
        data: TBody[],
        options?: RestRequestOptions,
    ): Promise<(T & { _id: string })[]> {
        const extra = this.defaultParams?.insertMany ?? {};
        return this.request<(T & { _id: string })[]>(collection, "insertMany", { data, ...extra }, options);
    }

    async updateOne<T = any, TUpdate = any>(
        collection: string,
        id: string,
        update: TUpdate,
        options?: RestRequestOptions,
    ): Promise<T> {
        const extra = this.defaultParams?.updateOne ?? {};
        return this.request<T>(collection, "updateOne", { id, update, ...extra }, options);
    }

    async updateMany<TUpdate = any>(
        collection: string,
        ids: string[],
        update: TUpdate,
        options?: RestRequestOptions,
    ): Promise<any> {
        const extra = this.defaultParams?.updateMany ?? {};
        return this.request(collection, "updateMany", { ids, update, ...extra }, options);
    }

    async deleteOne(
        collection: string,
        id: string,
        options?: RestRequestOptions,
    ): Promise<any> {
        const extra = this.defaultParams?.deleteOne ?? {};
        return this.request(collection, "deleteOne", { id, ...extra }, options);
    }

    async deleteMany(
        collection: string,
        ids: string[],
        options?: RestRequestOptions,
    ): Promise<any> {
        const extra = this.defaultParams?.deleteMany ?? {};
        return this.request(collection, "deleteMany", { ids, ...extra }, options);
    }

    // ── Custom actions & services ────────────────────────────────────────

    async runAction<T = any>(
        collection: string,
        action: string,
        data?: unknown,
        options?: RestRequestOptions,
    ): Promise<T> {
        return this.request<T>(collection, action, data !== undefined ? { data } : undefined, options);
    }

    /**
     * Calls an action of a service (`cfg.services`), on its own family route.
     * @param service — service name
     * @param action — name of the entry in `service.actions`
     */
    async runService<T = any>(
        service: string,
        action: string,
        data?: unknown,
        options?: RestRequestOptions,
    ): Promise<T> {
        const opts = options ?? {};
        const url = this.buildServiceUrl(service, action, opts.query);
        return this.postJson<T>(url, data !== undefined ? { data } : undefined, opts);
    }

    // ── Files ────────────────────────────────────────────────────────────

    /**
     * Uploads one or more files (`multipart/form-data`) to a file collection —
     * one document per file. `data` carries the collection's custom fields.
     */
    async upload<T extends FileResult = FileResult>(
        collection: string,
        file: Blob | File | (Blob | File)[],
        data?: Record<string, any>,
        opts?: {
            fieldName?: string;
            signal?: AbortSignal;
        },
    ): Promise<T | T[]> {
        const files = Array.isArray(file) ? file : [file];
        const fieldName = opts?.fieldName ?? "file";
        const formData = new FormData();
        for (const entry of files) formData.append(fieldName, entry);

        if (data) {
            for (const [key, value] of Object.entries(data)) formData.append(key, String(value));
        }

        return this.postForm<T | T[]>(this.buildUploadUrl(collection), formData, opts?.signal);
    }

    /** The URL serving a file, with optional image transformations. */
    getFileUrl(collection: string, filename: string, transform?: {
        width?: number;
        height?: number;
        format?: "webp" | "jpeg" | "png" | "avif";
        quality?: number;
    }): string {
        let url = this.buildFileUrl(collection, filename);
        if (transform) {
            const params: Record<string, string> = {};
            if (transform.width) params.w = String(transform.width);
            if (transform.height) params.h = String(transform.height);
            if (transform.format) params.format = transform.format;
            if (transform.quality) params.q = String(transform.quality);
            url = withQueryParams(url, params);
        }
        return url;
    }

    /**
     * Deletes a file document and its stored binary.
     * @param fileId — the `_id` of the file document (returned by `upload()`)
     */
    async deleteFile<TResponse = { message: string; ok: boolean }>(
        collection: string,
        fileId: string,
        signal?: AbortSignal,
    ): Promise<TResponse> {
        return this.remove<TResponse>(this.buildFileUrl(collection, fileId), signal);
    }

    // ── Internals ────────────────────────────────────────────────────────

    private request<TResponse = any>(
        collection: string,
        action: string,
        body?: unknown,
        options: RestRequestOptions = {},
    ): Promise<TResponse> {
        return this.postJson<TResponse>(this.buildUrl(collection, action, options.query), body, options);
    }
}

function withQueryParams(url: string, params: Record<string, string>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) search.set(key, value);
    const query = search.toString();
    return query ? `${url}?${query}` : url;
}

export { Rest };
