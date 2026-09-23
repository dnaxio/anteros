import { Agent } from "./agents";
import { Vars } from "./vars";
import { cleanDeep } from "../utils";
import type { ApiAction, PublicConfig, RestClientOptions, RestRequestOptions } from "../types/rest";

/** Build a URL from the server, the tenant and path segments. */
function joinURL(...parts: string[]): string {
    return parts
        .map((part) => String(part).replace(/^\/+|\/+$/g, ""))
        .filter(Boolean)
        .join("/");
}

function withQuery(url: string, query: Record<string, string | number | boolean | null | undefined>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        params.set(key, String(value));
    }
    const search = params.toString();
    return search ? `${url}?${search}` : url;
}

/**
 * The transport every client shares — URL, headers, token, error shape.
 *
 * Not exported: an application instantiates **`Anteros`** (the namespaced client)
 * or **`Rest`** (the original, flat one). Both extend this class, so the wire
 * behaviour is written once and the two surfaces cannot drift apart.
 */
class Client {
    #server: string;
    #tenant: string;
    #headers: Record<string, string>;
    #token?: string;
    #persistToken: boolean;
    #tokenStorageKey: string;
    protected defaultParams: RestClientOptions["defaultParams"];

    constructor(options: RestClientOptions) {
        this.#server = options.server.replace(/\/+$/, "");
        this.#tenant = options.tenant;
        this.#headers = { ...(options.headers ?? {}) };
        this.#persistToken = options.token?.persist ?? true;
        this.#tokenStorageKey = options.token?.storageKey ?? "anteros_token";
        this.defaultParams = options.defaultParams ?? {};

        if (this.#persistToken && typeof globalThis !== "undefined" && "localStorage" in globalThis) {
            const stored = globalThis.localStorage.getItem(this.#tokenStorageKey);
            if (stored) this.setToken(stored);
        }
    }

    // ── Configuration & token ────────────────────────────────────────────

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

    getTenant(): string {
        return this.#tenant;
    }

    protected setToken(token: string | undefined) {
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

    /** The headers of a request, without the `Content-Type` (per call). */
    protected headers(extra?: Record<string, string>): Record<string, string> {
        return { ...this.#headers, ...(extra ?? {}) };
    }

    // ── URL builders — one per family (`/api/:tenant/<family>/…`) ────────

    protected buildUrl(collection: string, action: ApiAction, query?: Record<string, any>): string {
        return this.#withQuery(joinURL(this.#server, "api", this.#tenant, "collections", collection, String(action)), query);
    }

    protected buildUploadUrl(collection: string): string {
        return joinURL(this.#server, "api", this.#tenant, "upload", collection);
    }

    protected buildFileUrl(collection: string, filename: string): string {
        return joinURL(this.#server, "api", this.#tenant, "files", collection, filename);
    }

    protected buildServiceUrl(service: string, action: string, query?: Record<string, any>): string {
        return this.#withQuery(joinURL(this.#server, "api", this.#tenant, "services", service, action), query);
    }

    protected buildVarsUrl(action: string, query?: Record<string, any>): string {
        return this.#withQuery(joinURL(this.#server, "api", this.#tenant, "vars", action), query);
    }

    protected buildAgentUrl(agent: string, action: string, query?: Record<string, any>): string {
        return this.#withQuery(joinURL(this.#server, "api", this.#tenant, "agents", agent, action), query);
    }

    #withQuery(url: string, query?: Record<string, any>): string {
        if (!query || Object.keys(query).length === 0) return url;
        return withQuery(url, query as Record<string, string | number | boolean | null | undefined>);
    }

    // ── Requests ─────────────────────────────────────────────────────────

    protected async handleResponse<T>(res: Response): Promise<T> {
        const payload = await this.readPayload(res);
        if (!res.ok) throw this.buildError(res, payload);
        return payload as T;
    }

    /** The parsed (or raw) body of a response, whichever the Content-Type announces. */
    protected async readPayload(res: Response): Promise<any> {
        const contentType = res.headers.get("Content-Type") || "";
        return contentType.includes("application/json") ? await res.json() : await res.text();
    }

    /**
     * Build the error every SDK method throws: `message`, `code`, `meta` and
     * `status` — never a string to parse.
     */
    protected buildError(res: Response, payload: any): Error {
        const isJson = !!payload && typeof payload === "object";
        const error: any = new Error(
            (isJson && payload.message) || res.statusText || "Request failed",
        );
        if (isJson) {
            error.code = payload.code;
            error.meta = payload.meta;
        }
        error.status = res.status;
        return error;
    }

    /** Raw POST for the streaming path — the response is error-checked, not parsed. */
    protected async postRaw(url: string, body: unknown, options: RestRequestOptions = {}): Promise<Response> {
        const res = await fetch(url, {
            method: "POST",
            headers: this.headers({ "Content-Type": "application/json", ...(options.headers ?? {}) }),
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: options.signal,
        });
        if (!res.ok) throw this.buildError(res, await this.readPayload(res));
        return res;
    }

    protected async postJson<TResponse = unknown>(
        url: string,
        body?: unknown,
        options: RestRequestOptions = {},
    ): Promise<TResponse> {
        const requestBody = options.cleanDeep && body !== undefined ? cleanDeep(body) : body;
        const res = await fetch(url, {
            method: "POST",
            headers: this.headers({ "Content-Type": "application/json", ...(options.headers ?? {}) }),
            body: requestBody !== undefined ? JSON.stringify(requestBody) : undefined,
            signal: options.signal,
        });

        return this.handleResponse<TResponse>(res);
    }

    /** A multipart POST (uploads) — never sets `Content-Type`, the boundary is generated. */
    protected async postForm<TResponse = unknown>(
        url: string,
        formData: FormData,
        signal?: AbortSignal,
    ): Promise<TResponse> {
        const res = await fetch(url, { method: "POST", headers: this.headers(), body: formData, signal });
        return this.handleResponse<TResponse>(res);
    }

    protected async remove<TResponse = unknown>(url: string, signal?: AbortSignal): Promise<TResponse> {
        const res = await fetch(url, { method: "DELETE", headers: this.headers(), signal });
        return this.handleResponse<TResponse>(res);
    }

    // ── Shared members (both surfaces expose them) ────────────────────────

    /**
     * One agent of the tenant — `POST /api/:tenant/agents/:agent/:action`.
     *
     * ```ts
     * const support = client.agent('support');
     * const { text } = await support.generate('Where is my order?', { thread: 'u-42' });
     * ```
     */
    agent<T = any>(id: string): Agent<T> {
        return new Agent<T>(
            id,
            (action, body, options) => this.postJson<any>(this.buildAgentUrl(id, action, options?.query), body, options ?? {}),
            (action, body, options) => this.postRaw(this.buildAgentUrl(id, action, options?.query), body, options ?? {}),
        );
    }

    /**
     * Tenant-scoped variables — mirrors the server's `rest.vars`.
     *
     * ```ts
     * await client.vars.set('config', 'licence', 'RDX00');
     * const licence = await client.vars.get('config', 'licence');
     * ```
     */
    get vars(): Vars {
        return new Vars((action, body, options) =>
            this.postJson<any>(this.buildVarsUrl(action, options?.query), body, options ?? {}),
        );
    }

    /**
     * The public server configuration (non-sensitive) — `GET /_dnax/config/:tenant`.
     */
    async getConfig(): Promise<PublicConfig> {
        const url = joinURL(this.#server, "_dnax", "config", this.#tenant);
        const res = await fetch(url, { method: "GET", headers: this.headers() });
        return this.handleResponse<PublicConfig>(res);
    }
}

export { Client, joinURL, withQuery };
