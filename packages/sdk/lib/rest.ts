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

    constructor(options: RestClientOptions) {
        this.#server = options.server.replace(/\/+$/, "");
        this.#tenant = options.tenant;
        this.#headers = options.headers ?? {};
        this.#persistToken = options.token?.persist ?? true;
        this.#tokenStorageKey = options.token?.storageKey ?? "dnax_token";

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

        return payload as TResponse;
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
        return this.request<T[]>(collection, "find", { params }, options);
    }

    async findOne<T = any>(
        collection: string,
        id: string,
        params: Record<string, unknown> = {},
        options?: RestRequestOptions,
    ): Promise<T | null> {
        return this.request<T | null>(collection, "findOne", { id, params }, options);
    }

    async insertOne<T = any, TBody = any>(
        collection: string,
        data: TBody,
        options?: RestRequestOptions,
    ): Promise<T & { _id: string }> {
        return this.request<T & { _id: string }>(collection, "insertOne", { data }, options);
    }

    async insertMany<T = any, TBody = any>(
        collection: string,
        data: TBody[],
        options?: RestRequestOptions,
    ): Promise<(T & { _id: string })[]> {
        return this.request<(T & { _id: string })[]>(collection, "insertMany", { data }, options);
    }

    async updateOne<T = any, TUpdate = any>(
        collection: string,
        id: string,
        update: TUpdate,
        options?: RestRequestOptions,
    ): Promise<T> {
        return this.request<T>(collection, "updateOne", { id, update }, options);
    }

    async updateMany<TUpdate = any>(
        collection: string,
        ids: string[],
        update: TUpdate,
        options?: RestRequestOptions,
    ): Promise<any> {
        return this.request(collection, "updateMany", { ids, update }, options);
    }

    async deleteOne(
        collection: string,
        id: string,
        options?: RestRequestOptions,
    ): Promise<any> {
        return this.request(collection, "deleteOne", { id }, options);
    }

    async deleteMany(
        collection: string,
        ids: string[],
        options?: RestRequestOptions,
    ): Promise<any> {
        return this.request(collection, "deleteMany", { ids }, options);
    }

    async aggregate<T = any>(
        collection: string,
        pipeline: unknown[],
        options?: RestRequestOptions,
    ): Promise<T[]> {
        return this.request<T[]>(collection, "aggregate", { pipeline }, options);
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

            const payload = await res.json();

            if (!res.ok) {
                const error: any = new Error(
                    (payload as any)?.message || res.statusText || "Upload failed",
                );
                error.code = (payload as any)?.code;
                error.status = res.status;
                throw error;
            }

            return payload as T;
        }

        // Upload multiple — chaque fichier dans un champ séparé du même FormData
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

        const payload = await res.json();

        if (!res.ok) {
            const error: any = new Error(
                (payload as any)?.message || res.statusText || "Upload failed",
            );
            error.code = (payload as any)?.code;
            error.status = res.status;
            throw error;
        }

        return payload as T[];
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
     * Supprime un fichier via `DELETE /files/:tenant/:collection/:filename`.
     */
    async deleteFile<TResponse = { message: string; ok: boolean }>(
        collection: string,
        filename: string,
        signal?: AbortSignal,
    ): Promise<TResponse> {
        const url = this.buildFileUrl(collection, filename);

        const res = await fetch(url, {
            method: "DELETE",
            headers: { ...this.#headers },
            signal,
        });

        const payload = await res.json();

        if (!res.ok) {
            const error: any = new Error(
                (payload as any)?.message || res.statusText || "Delete failed",
            );
            error.code = (payload as any)?.code;
            error.status = res.status;
            throw error;
        }

        return payload as TResponse;
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

        const payload = await res.json();

        if (!res.ok) {
            const error: any = new Error(
                (payload as any)?.message || res.statusText || 'Failed to fetch config',
            );
            error.code = (payload as any)?.code;
            error.status = res.status;
            throw error;
        }

        return payload as T;
    }
}

export {
    Rest,
};
