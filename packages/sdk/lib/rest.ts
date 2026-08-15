import { joinURL, withQuery } from "ufo";
import type { ApiAction, FileResult, FindOptions, PublicConfig, RestClientOptions, RestQueryOptions, RestRequestOptions } from "../types/rest";
import { cleanDeep } from "../utils";

export type { RestClientOptions, RestQueryOptions, RestRequestOptions } from "../types/rest";

class Rest {
    #server: string;
    #tenant: string;
    #headers: Record<string, string>;
    #token?: string;
    #persistToken: boolean;
    #tokenStorageKey: string;
    #defaultParams: RestClientOptions["defaultParams"];

    constructor(options: RestClientOptions) {
        this.#server = options.server.replace(/\/+$/, "");
        this.#tenant = options.tenant;
        this.#headers = options.headers ?? {};
        this.#persistToken = options.token?.persist ?? true;
        this.#tokenStorageKey = options.token?.storageKey ?? "dnax_token";
        this.#defaultParams = options.defaultParams ?? {};

        // Récupération éventuelle d'un token déjà stocké côté client
        if (this.#persistToken && typeof globalThis !== "undefined" && "localStorage" in globalThis) {
            const storedToken = globalThis.localStorage.getItem(this.#tokenStorageKey);
            if (storedToken) {
                this.setToken(storedToken);
            }
        }
    }

    setHeader(name: string, value: string | undefined) {
        if (value === undefined) {
            delete this.#headers[name];
            return;
        }
        this.#headers[name] = value;
    }

    setServer(url: string) {
        this.#server = url.replace(/\/+$/, "");
    }

    setTenant(tenant: string) {
        this.#tenant = tenant;
    }

    private setToken(token: string | undefined) {
        if (!token) {
            this.#token = undefined;
            delete this.#headers.Authorization;
            if (this.#persistToken && typeof globalThis !== "undefined" && "localStorage" in globalThis) {
                globalThis.localStorage.removeItem(this.#tokenStorageKey);
            }
            return;
        }

        this.#token = token;
        this.#headers.Authorization = `Bearer ${token}`;

        if (this.#persistToken && typeof globalThis !== "undefined" && "localStorage" in globalThis) {
            globalThis.localStorage.setItem(this.#tokenStorageKey, token);
        }
    }

    getToken(): string | undefined {
        return this.#token;
    }

    clearToken() {
        this.setToken(undefined);
    }

    private buildUrl(collection: string, action: ApiAction, query?: RestQueryOptions): string {
        const base = joinURL(this.#server, "api", this.#tenant, collection, String(action));
        if (!query || Object.keys(query).length === 0) {
            return base;
        }
        return withQuery(base, query as Record<string, string | number | boolean | null | undefined>);
    }

    /** `POST /services/:tenant/:service/:action` (voir `SERVICE_PREFIX` côté serveur). */
    private buildUploadUrl(collection: string): string {
        return joinURL(this.#server, "upload", this.#tenant, collection);
    }

    private buildFileUrl(collection: string, filename: string): string {
        return joinURL(this.#server, "files", this.#tenant, collection, filename);
    }

    private buildServiceUrl(service: string, action: string, query?: RestQueryOptions): string {
        const base = joinURL(this.#server, "services", this.#tenant, service, action);
        if (!query || Object.keys(query).length === 0) {
            return base;
        }
        return withQuery(base, query as Record<string, string | number | boolean | null | undefined>);
    }

    private async handleResponse<T>(res: Response): Promise<T> {
        const contentType = res.headers.get("Content-Type") || "";
        const isJson = contentType.includes("application/json");
        const payload = isJson ? await res.json() : await res.text();

        if (!res.ok) {
            const error: any = new Error(
                (isJson && (payload as any)?.message) || res.statusText || "Request failed",
            );
            if (isJson && typeof payload === "object" && payload) {
                error.code = (payload as any).code;
                error.meta = (payload as any).meta;
            }
            error.status = res.status;
            throw error;
        }

        return payload as T;
    }

    private async postJson<TResponse = unknown>(
        url: string,
        body?: unknown,
        options: RestRequestOptions = {},
    ): Promise<TResponse> {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            ...this.#headers,
            ...(options.headers ?? {}),
        };

        const requestBody = options.cleanDeep && body !== undefined ? cleanDeep(body) : body;
        const res = await fetch(url, {
            method: "POST",
            headers,
            body: requestBody !== undefined ? JSON.stringify(requestBody) : undefined,
            signal: options.signal,
        });

        return this.handleResponse<TResponse>(res);
    }

    private async request<TResponse = any>(
        collection: string,
        action: ApiAction,
        body?: unknown,
        options: RestRequestOptions = {},
    ): Promise<TResponse> {
        const url = this.buildUrl(collection, action, options.query);
        return this.postJson<TResponse>(url, body, options);
    }

    async login<TData = any>(
        collection: string,
        payload: Record<string, unknown>,
        options?: RestRequestOptions,
    ): Promise<{ token: string; data: TData }> {
        this.clearToken()
        const res = await this.request<{ token: string; data: TData }>(
            collection,
            "login",
            { payload },
            options,
        );
        if (res?.token) {
            this.setToken(res.token);
        }
        return res;
    }

    async logout<TResponse = any>(
        collection: string,
        payload?: Record<string, unknown>,
        options?: RestRequestOptions,
    ): Promise<TResponse> {
        const res = await this.request<TResponse>(
            collection,
            "logout",
            payload ? { payload } : undefined,
            options,
        );
        this.clearToken();
        return res;
    }

    async find<T = any>(
        collection: string,
        params: FindOptions,
        options?: RestRequestOptions,
    ): Promise<T[]> {
        const merged = { ...(this.#defaultParams?.find ?? {}), ...params };
        const { useCache, ...requestOptions } = options ?? {};
        const body: Record<string, unknown> = { params: merged };
        if (useCache !== undefined) {
            body.options = { useCache }; // TTL is managed server-side (collection/server config)
        }
        return this.request<T[]>(collection, "find", body, requestOptions);
    }

    async findOne<T = any>(
        collection: string,
        id: string,
        params: Record<string, unknown> = {},
        options?: RestRequestOptions,
    ): Promise<T | null> {
        const merged = { ...(this.#defaultParams?.findOne ?? {}), ...params };
        return this.request<T | null>(collection, "findOne", { id, params: merged }, options);
    }

    async insertOne<T = any, TBody = any>(
        collection: string,
        data: TBody,
        options?: RestRequestOptions,
    ): Promise<T & { _id: string }> {
        const extra = this.#defaultParams?.insertOne ?? {};
        return this.request<T & { _id: string }>(collection, "insertOne", { data, ...extra }, options);
    }

    async insertMany<T = any, TBody = any>(
        collection: string,
        data: TBody[],
        options?: RestRequestOptions,
    ): Promise<(T & { _id: string })[]> {
        const extra = this.#defaultParams?.insertMany ?? {};
        return this.request<(T & { _id: string })[]>(collection, "insertMany", { data, ...extra }, options);
    }

    async updateOne<T = any, TUpdate = any>(
        collection: string,
        id: string,
        update: TUpdate,
        options?: RestRequestOptions,
    ): Promise<T> {
        const extra = this.#defaultParams?.updateOne ?? {};
        return this.request<T>(collection, "updateOne", { id, update, ...extra }, options);
    }

    async updateMany<TUpdate = any>(
        collection: string,
        ids: string[],
        update: TUpdate,
        options?: RestRequestOptions,
    ): Promise<any> {
        const extra = this.#defaultParams?.updateMany ?? {};
        return this.request(collection, "updateMany", { ids, update, ...extra }, options);
    }

    async deleteOne(
        collection: string,
        id: string,
        options?: RestRequestOptions,
    ): Promise<any> {
        const extra = this.#defaultParams?.deleteOne ?? {};
        return this.request(collection, "deleteOne", { id, ...extra }, options);
    }

    async deleteMany(
        collection: string,
        ids: string[],
        options?: RestRequestOptions,
    ): Promise<any> {
        const extra = this.#defaultParams?.deleteMany ?? {};
        return this.request(collection, "deleteMany", { ids, ...extra }, options);
    }

    async aggregate<T = any>(
        collection: string,
        pipeline: unknown[],
        options?: RestRequestOptions,
    ): Promise<T[]> {
        const extra = this.#defaultParams?.aggregate ?? {};
        return this.request<T[]>(collection, "aggregate", { pipeline, ...extra }, options);
    }

    async runAction<T = any>(
        collection: string,
        action: string,
        data?: unknown,
        options?: RestRequestOptions,
    ): Promise<T> {
        return this.request<T>(collection, action, data !== undefined ? { data } : undefined, options);
    }

    /**
     * Appelle `POST /services/:tenant/:service/:action` (handler serveur : `SERVICE_PREFIX`).
     * @param service — nom du service (config `cfg.services`)
     * @param action — nom de l’entrée dans `service.actions`
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

    /**
     * Upload un ou plusieurs fichiers via `POST /upload/:tenant/:collection`.
     * Les fichiers sont envoyés en `multipart/form-data`.
     * Utilise les champs supplémentaires pour envoyer des métadonnées.
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

        const appendData = (formData: FormData) => {
            if (data) {
                for (const [key, value] of Object.entries(data)) {
                    formData.append(key, String(value));
                }
            }
        };

        if (files.length === 1) {
            const url = this.buildUploadUrl(collection);
            const formData = new FormData();
            formData.append(fieldName, files[0]!);
            appendData(formData);

            const res = await fetch(url, {
                method: "POST",
                headers: { ...this.#headers },
                body: formData,
                signal: opts?.signal,
            });

            return this.handleResponse<T>(res);
        }

        // Upload multiple
        const url = this.buildUploadUrl(collection);
        const formData = new FormData();
        for (let i = 0; i < files.length; i++) {
            formData.append(fieldName, files[i]!);
        }
        appendData(formData);

        const res = await fetch(url, {
            method: "POST",
            headers: { ...this.#headers },
            body: formData,
            signal: opts?.signal,
        });

        return this.handleResponse<T[]>(res);
    }

    /**
     * Retourne l'URL complète pour servir un fichier.
     */
    getFileUrl(collection: string, filename: string, transform?: {
        width?: number;
        height?: number;
        format?: 'webp' | 'jpeg' | 'png' | 'avif';
        quality?: number;
    }): string {
        let url = this.buildFileUrl(collection, filename);
        if (transform) {
            const params: Record<string, string> = {};
            if (transform.width) params.w = String(transform.width);
            if (transform.height) params.h = String(transform.height);
            if (transform.format) params.format = transform.format;
            if (transform.quality) params.q = String(transform.quality);
            url = withQuery(url, params);
        }
        return url;
    }

    /**
     * Supprime un fichier via `DELETE /files/:tenant/:collection/:fileId`.
     * @param fileId — the `_id` of the file document (returned by `upload()`)
     */
    async deleteFile<TResponse = { message: string; ok: boolean }>(
        collection: string,
        fileId: string,
        signal?: AbortSignal,
    ): Promise<TResponse> {
        const url = joinURL(this.#server, "files", this.#tenant, collection, fileId);
        const res = await fetch(url, {
            method: "DELETE",
            headers: { ...this.#headers },
            signal,
        });
        return this.handleResponse<TResponse>(res);
    }

    /**
     * Fetch the public server configuration (non-sensitive only).
     * GET /_dnax/config
     */
    async getConfig(): Promise<PublicConfig> {
        const url = joinURL(this.#server, '_dnax', 'config', this.#tenant);
        const res = await fetch(url, {
            method: 'GET',
            headers: { ...this.#headers },
        });
        return this.handleResponse<PublicConfig>(res);
    }
}

export {
    Rest,
};
