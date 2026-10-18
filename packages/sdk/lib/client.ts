import { Agent } from "./agents";
import { Vars } from "./vars";
import { cleanDeep } from "../utils";
import type {
    AnterosError,
    ApiAction,
    PublicConfig,
    RestClientOptions,
    RestRequestOptions,
    SdkEvent,
    SdkListener,
} from "../types/rest";

/** Encode one dynamic path segment (collection, action, agent, filename…). */
function segment(value: string | number): string {
    return encodeURIComponent(String(value));
}

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
    #credentials?: RequestCredentials;
    #timeoutMs: number;
    protected defaultParams: RestClientOptions["defaultParams"];
    /** Listeners, by event — see `on('error')`. */
    #listeners = new Map<SdkEvent, Set<SdkListener>>();

    constructor(options: RestClientOptions) {
        this.#server = options.server.replace(/\/+$/, "");
        this.#tenant = options.tenant;
        this.#headers = { ...(options.headers ?? {}) };
        this.#persistToken = options.token?.persist ?? true;
        // Scope the storage key to the server **and** the tenant: a global key made a
        // second client (another tenant, another server) pick the previous token.
        const scope = `${this.#server}|${options.tenant}`;
        this.#tokenStorageKey = `${options.token?.storageKey ?? "anteros_token"}:${scope}`;
        this.#credentials = options.credentials;
        this.#timeoutMs = options.timeoutMs ?? 0;
        this.defaultParams = options.defaultParams ?? {};

        const stored = this.#readStoredToken();
        if (stored) this.setToken(stored);
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

    /** The browser storage, if there is one — never throws (private mode, quota). */
    #storage(): Storage | null {
        try {
            if (typeof globalThis === "undefined" || !("localStorage" in globalThis)) return null;
            return (globalThis as any).localStorage ?? null;
        } catch {
            return null;
        }
    }

    #readStoredToken(): string | null {
        if (!this.#persistToken) return null;
        try {
            return this.#storage()?.getItem(this.#tokenStorageKey) ?? null;
        } catch {
            return null;
        }
    }

    #writeStoredToken(token: string | undefined): void {
        if (!this.#persistToken) return;
        const storage = this.#storage();
        if (!storage) return;
        try {
            if (token === undefined) storage.removeItem(this.#tokenStorageKey);
            else storage.setItem(this.#tokenStorageKey, token);
        } catch {
            // A full/denied storage must never break the request path
        }
    }

    protected setToken(token: string | undefined) {
        if (!token) {
            this.#token = undefined;
            delete this.#headers.Authorization;
            this.#writeStoredToken(undefined);
            return;
        }

        this.#token = token;
        this.#headers.Authorization = `Bearer ${token}`;
        this.#writeStoredToken(token);
    }

    /** A signal combining the caller's abort with the configured timeout. */
    protected requestSignal(options?: RestRequestOptions): AbortSignal | undefined {
        const timeoutMs = options?.timeoutMs ?? this.#timeoutMs;
        const signals: AbortSignal[] = [];
        if (options?.signal) signals.push(options.signal);
        if (timeoutMs && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
        if (!signals.length) return undefined;
        if (signals.length === 1) return signals[0];
        const any = (AbortSignal as any).any;
        return typeof any === "function" ? any.call(AbortSignal, signals) : signals[0];
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

    // ── Events ───────────────────────────────────────────────────────────

    /**
     * Listen to what this client goes through — the failures, and the ones the server
     * refused with a 401 (see `SdkEvent`).
     *
     * ```ts
     * const api = new Anteros({ server, tenant });
     *
     * // A dead token: disconnect, and let the UI route to the login page
     * api.on('unauthorized', () => { api.logout(); router.push('/login'); });
     *
     * // Anything else, by stable code — never by parsing a message
     * api.on('error', (err) => console.warn(err.code, err.status, err.message));
     * ```
     *
     * The listener receives the **same** error the call throws (a listener is not a
     * replacement for `try`/`catch`), and a listener that throws is ignored rather
     * than masking it. `off(event)` removes one handler, `off(event)` with no handler
     * removes all of them.
     */
    on(event: SdkEvent, listener: SdkListener): this {
        this.#handlers(event).add(listener);
        return this;
    }

    /** Same, once — the listener is removed before it runs. */
    once(event: SdkEvent, listener: SdkListener): this {
        const wrapper: SdkListener = (error) => {
            this.off(event, wrapper);
            listener(error);
        };
        return this.on(event, wrapper);
    }

    /** Remove a listener — or every listener of that event when none is given. */
    off(event: SdkEvent, listener?: SdkListener): this {
        const handlers = this.#handlers(event);
        if (listener) handlers.delete(listener);
        else handlers.clear();
        return this;
    }

    /** How many listeners an event has — what a UI uses to avoid registering twice. */
    listenerCount(event: SdkEvent): number {
        return this.#listeners.get(event)?.size ?? 0;
    }

    #handlers(event: SdkEvent): Set<SdkListener> {
        if (event !== "error" && event !== "unauthorized") {
            // A typo would register a listener that never fires: fail loudly instead
            throw new Error(`Unknown SDK event '${event}' — this client emits 'error' and 'unauthorized'`);
        }
        let handlers = this.#listeners.get(event);
        if (!handlers) {
            handlers = new Set();
            this.#listeners.set(event, handlers);
        }
        return handlers;
    }

    #emit(event: SdkEvent, error: AnterosError): void {
        for (const listener of this.#listeners.get(event) ?? []) {
            try {
                listener(error);
            } catch {
                // A listener must never mask the error it was handed
            }
        }
    }

    // ── URL builders — one per family (`/api/:tenant/<family>/…`) ────────

    protected buildUrl(collection: string, action: ApiAction, query?: Record<string, any>): string {
        return this.#withQuery(joinURL(this.#server, "api", segment(this.#tenant), "collections", segment(collection), segment(String(action))), query);
    }

    protected buildUploadUrl(collection: string): string {
        return joinURL(this.#server, "api", segment(this.#tenant), "upload", segment(collection));
    }

    protected buildFileUrl(collection: string, filename: string): string {
        return joinURL(this.#server, "api", segment(this.#tenant), "files", segment(collection), segment(filename));
    }

    protected buildServiceUrl(service: string, action: string, query?: Record<string, any>): string {
        return this.#withQuery(joinURL(this.#server, "api", segment(this.#tenant), "services", segment(service), segment(action)), query);
    }

    protected buildVarsUrl(action: string, query?: Record<string, any>): string {
        return this.#withQuery(joinURL(this.#server, "api", segment(this.#tenant), "vars", segment(action)), query);
    }

    protected buildAgentUrl(agent: string, action: string, query?: Record<string, any>): string {
        return this.#withQuery(joinURL(this.#server, "api", segment(this.#tenant), "agents", segment(agent), segment(action)), query);
    }

    #withQuery(url: string, query?: Record<string, any>): string {
        if (!query || Object.keys(query).length === 0) return url;
        return withQuery(url, query as Record<string, string | number | boolean | null | undefined>);
    }

    // ── Requests ─────────────────────────────────────────────────────────

    protected async handleResponse<T>(res: Response): Promise<T> {
        const payload = await this.readPayload(res);
        if (!res.ok) throw this.#fail(res, payload);
        return payload as T;
    }

    /** 5 MB is already far beyond any API payload the SDK expects. */
    static MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

    /** The parsed (or raw) body of a response, whichever the Content-Type announces. */
    protected async readPayload(res: Response): Promise<any> {
        const length = Number(res.headers.get("content-length") ?? 0);
        if (Number.isFinite(length) && length > Client.MAX_RESPONSE_BYTES) {
            const error: AnterosError = new Error("The response is too large") as AnterosError;
            error.code = "SDK_RESPONSE_TOO_LARGE";
            error.status = res.status;
            this.#emit("error", error);
            throw error;
        }

        const text = await res.text();
        if (text.length > Client.MAX_RESPONSE_BYTES) {
            const error: AnterosError = new Error("The response is too large") as AnterosError;
            error.code = "SDK_RESPONSE_TOO_LARGE";
            error.status = res.status;
            this.#emit("error", error);
            throw error;
        }

        const contentType = res.headers.get("Content-Type") || "";
        if (!contentType.includes("application/json")) return text;
        try {
            return JSON.parse(text);
        } catch {
            // Invalid JSON: surface the raw text rather than a parser SyntaxError
            return text;
        }
    }

    /**
     * Build the error every SDK method throws: `message`, `code`, `meta` and
     * `status` — never a string to parse.
     */
    protected buildError(res: Response, payload: any): AnterosError {
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

    /** Build the error of a refused response, **report it**, and hand it back. */
    #fail(res: Response, payload: any): AnterosError {
        const error = this.buildError(res, payload);
        this.#emit("error", error);
        if (res.status === 401) this.#emit("unauthorized", error);
        return error;
    }

    /**
     * Every request goes through here — the **one** place that sees a failure, so a
     * listener registered with `on('error')` cannot miss one.
     *
     * A caller abort (`AbortSignal`) is not reported: cancelling is not a failure.
     * Everything else is — a transport failure (`SDK_NETWORK_ERROR`, with the original
     * error as `cause`) or a response the server refused (`#fail`).
     */
    async #send(url: string, init: RequestInit): Promise<Response> {
        let res: Response;
        try {
            res = await fetch(url, {
                ...init,
                ...(this.#credentials ? { credentials: this.#credentials } : {}),
            });
        } catch (err: any) {
            if (err?.name === "AbortError") throw err;
            const timeout = err?.name === "TimeoutError";
            const error: AnterosError = new Error(
                timeout ? "The request timed out" : (err?.message ?? "Network request failed"),
            );
            error.code = timeout ? "SDK_TIMEOUT" : "SDK_NETWORK_ERROR";
            error.cause = err;
            this.#emit("error", error);
            throw error;
        }

        if (!res.ok) throw this.#fail(res, await this.readPayload(res));
        return res;
    }

    /** Raw POST for the streaming path — the response is error-checked, not parsed. */
    protected async postRaw(url: string, body: unknown, options: RestRequestOptions = {}): Promise<Response> {
        return this.#send(url, {
            method: "POST",
            headers: this.headers({ "Content-Type": "application/json", ...(options.headers ?? {}) }),
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: this.requestSignal(options),
        });
    }

    protected async postJson<TResponse = unknown>(
        url: string,
        body?: unknown,
        options: RestRequestOptions = {},
    ): Promise<TResponse> {
        const requestBody = options.cleanDeep && body !== undefined ? cleanDeep(body) : body;
        const res = await this.#send(url, {
            method: "POST",
            headers: this.headers({ "Content-Type": "application/json", ...(options.headers ?? {}) }),
            body: requestBody !== undefined ? JSON.stringify(requestBody) : undefined,
            signal: this.requestSignal(options),
        });

        return this.handleResponse<TResponse>(res);
    }

    /** A multipart POST (uploads) — never sets `Content-Type`, the boundary is generated. */
    protected async postForm<TResponse = unknown>(
        url: string,
        formData: FormData,
        signal?: AbortSignal,
    ): Promise<TResponse> {
        // Never leak a global `Content-Type` into a multipart body: the boundary must be generated.
        const headers = { ...this.headers() };
        for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === "content-type") delete headers[key];
        }
        const res = await this.#send(url, { method: "POST", headers, body: formData, signal: this.requestSignal({ signal }) });
        return this.handleResponse<TResponse>(res);
    }

    protected async remove<TResponse = unknown>(url: string, signal?: AbortSignal): Promise<TResponse> {
        const res = await this.#send(url, { method: "DELETE", headers: this.headers(), signal: this.requestSignal({ signal }) });
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
            // A stream that fails **after** its headers are in (the server sends the
            // error as an SSE event) is reported here too
            (error) => this.#emit("error", error),
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
        const url = joinURL(this.#server, "_dnax", "config", segment(this.#tenant));
        const res = await this.#send(url, { method: "GET", headers: this.headers(), signal: this.requestSignal() });
        return this.handleResponse<PublicConfig>(res);
    }
}

export { Client, joinURL, withQuery };
