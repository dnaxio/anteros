import { io, type Manager, type Socket as IOSocket } from "socket.io-client";
import type { SdkSocketOptions } from "../types/socket";

type Listener = (...args: any[]) => void;
/** The shape of an event map — `{ message: (m: Msg) => void }`. */
export type SocketEvents = Record<string, Listener>;

const DEFAULT_WAIT_MS = 10_000;

function timeoutError(event: string, ms: number): any {
    const error: any = new Error(`Socket event '${event}' did not arrive within ${ms}ms`);
    error.code = "SOCKET_TIMEOUT";
    return error;
}

/**
 * An emitting view of a socket — what `timeout()`, `volatile` and `compress()`
 * return. It shares the connection: only the way events leave changes.
 */
export class SocketEmitter {
    #socket: IOSocket;
    #timeoutMs?: number;

    constructor(socket: IOSocket, timeoutMs?: number) {
        this.#socket = socket;
        this.#timeoutMs = timeoutMs;
    }

    emit(event: string, ...args: any[]): this {
        this.#socket.emit(event, ...args);
        return this;
    }

    /** Emit and wait for the server's acknowledgement. */
    emitWithAck<T = any>(event: string, ...args: any[]): Promise<T> {
        const target = this.#timeoutMs !== undefined ? this.#socket.timeout(this.#timeoutMs) : this.#socket;
        return target.emitWithAck(event, ...args) as Promise<T>;
    }

    send(...args: any[]): this {
        this.#socket.send(...args);
        return this;
    }

    get volatile(): SocketEmitter {
        return new SocketEmitter(this.#socket.volatile, this.#timeoutMs);
    }

    compress(compress: boolean): SocketEmitter {
        return new SocketEmitter(this.#socket.compress(compress), this.#timeoutMs);
    }
}

/**
 * The reconnection manager (`socket.io`) — reconnect policy, and the transport
 * events (`reconnect_attempt`, `reconnect_error`, `error`…).
 */
export class AnterosSocketManager {
    #manager: Manager;

    constructor(manager: Manager) {
        this.#manager = manager;
    }

    /** The Socket.IO manager, untouched — the escape hatch. */
    get raw(): Manager {
        return this.#manager;
    }

    get reconnection(): boolean {
        return this.#manager.reconnection();
    }

    /** Open the underlying engine (`socket.connect()` does this for you). */
    open(): this {
        this.#manager.open();
        return this;
    }

    /** Alias of `open()`. */
    connect(): this {
        return this.open();
    }

    on(event: string, listener: Listener): this {
        (this.#manager as any).on(event, listener);
        return this;
    }

    once(event: string, listener: Listener): this {
        (this.#manager as any).once(event, listener);
        return this;
    }

    off(event: string, listener?: Listener): this {
        if (listener) (this.#manager as any).off(event, listener);
        else (this.#manager as any).off(event);
        return this;
    }
}

/**
 * A Socket.IO connection, built by `client.socket()` with the SDK's URL, tenant
 * and token — every Socket.IO client method, wrapped so chaining and typing hold.
 *
 * ```ts
 * const socket = api.socket<{ message: (m: Msg) => void }>();   // typed listen map
 * socket.rooms;                                                  // re-joined on reconnect
 *
 * socket.onConnect(() => console.log('connected', socket.id));
 * socket.on('message', (msg) => console.log(msg));
 * socket.emit('join', { room: 'support' });
 * const ack = await socket.emitWithAck('sum', 1, 2);
 * socket.disconnect();
 * ```
 *
 * The handshake carries `auth: { tenant, token }` (the framework's
 * `server.sockets.authorize` reads the token there) and the client's headers.
 */
export class AnterosSocket<
    ListenEvents extends SocketEvents = SocketEvents,
    EmitEvents extends SocketEvents = ListenEvents,
> {
    #url: string;
    #socket: IOSocket<any, any>;
    #auth: Record<string, any>;
    #headers: Record<string, string>;
    #ioOptions: Record<string, any>;
    #timeoutMs?: number;
    #waitForMs: number;
    #rooms: string[];
    #joinEvent: string;

    /** Listeners the wrapper re-attaches after a transport rebuild. */
    #listeners = new Map<string, Set<Listener>>();
    #onceListeners = new Map<string, Set<Listener>>();
    #anyListeners: Listener[] = [];
    #prepended: Listener[] = [];
    #outgoingListeners: Listener[] = [];
    #onConnectRejoin: () => void;

    constructor(url: string, options: SdkSocketOptions = {}) {
        const { headers, auth, timeoutMs, waitForTimeoutMs, rooms, joinEvent, ...ioOptions } = options;
        this.#url = url;
        this.#auth = { ...(auth ?? {}) };
        this.#headers = { ...(headers ?? {}) };
        this.#ioOptions = ioOptions;
        this.#timeoutMs = timeoutMs;
        this.#waitForMs = waitForTimeoutMs ?? DEFAULT_WAIT_MS;
        this.#rooms = [...(rooms ?? [])];
        this.#joinEvent = joinEvent ?? "room:join";
        this.#onConnectRejoin = () => this.#rejoin();

        this.#socket = this.#open();
        // `io()` connects asynchronously: the `connect` handler (re-join) and the
        // tracked listeners must be in place before that
        this.#attach();
    }

    #open(): IOSocket<any, any> {
        return io(this.#url, {
            ...this.#ioOptions,
            auth: this.#auth,
            ...(Object.keys(this.#headers).length ? { extraHeaders: this.#headers } : {}),
        }) as unknown as IOSocket<any, any>;
    }

    /** Re-join the declared rooms — on the first connection **and** every reconnection. */
    #rejoin(): void {
        for (const room of this.#rooms) this.#socket.emit(this.#joinEvent, room);
    }

    /** (Re)attach the tracked listeners — after a rebuild the socket object is new. */
    #attach(): void {
        this.#socket.on("connect", this.#onConnectRejoin);
        for (const [event, set] of this.#listeners) for (const fn of set) this.#socket.on(event, fn);
        for (const [event, set] of this.#onceListeners) for (const fn of set) this.#socket.once(event, fn);
        for (const fn of this.#prepended) this.#socket.prependAny(fn);
        for (const fn of this.#anyListeners) this.#socket.onAny(fn);
        for (const fn of this.#outgoingListeners) this.#socket.onAnyOutgoing(fn);
    }

    /** Replace the underlying socket, keeping the listeners this wrapper knows about. */
    #rebuild(): void {
        const wasConnected = this.#socket.connected;
        try { this.#socket.removeAllListeners(); } catch { /* already gone */ }
        try { this.#socket.disconnect(); } catch { /* already gone */ }
        this.#socket = this.#open();
        this.#attach();
        if (wasConnected) this.#socket.connect();
    }

    // ── State ────────────────────────────────────────────────────────────

    /** The Socket.IO socket, untouched — for what this wrapper does not cover. */
    get raw(): IOSocket<ListenEvents, EmitEvents> {
        return this.#socket as unknown as IOSocket<ListenEvents, EmitEvents>;
    }

    /** The URL the socket connects to (server + namespace). */
    get url(): string {
        return this.#url;
    }

    /** The id the server assigned, or `undefined` while disconnected. */
    get id(): string | undefined {
        return this.#socket.id;
    }

    get connected(): boolean {
        return this.#socket.connected;
    }

    get disconnected(): boolean {
        return this.#socket.disconnected;
    }

    /** `true` while a connection or a reconnection is in progress. */
    get active(): boolean {
        return this.#socket.active;
    }

    /** A **copy** of the handshake payload — change it through `setAuth` / `setToken`. */
    get auth(): Record<string, any> {
        return { ...this.#auth };
    }

    /** The rooms re-joined on every connection. */
    get rooms(): string[] {
        return [...this.#rooms];
    }

    /** Reconnection policy and transport events. */
    get io(): AnterosSocketManager {
        return new AnterosSocketManager(this.#socket.io);
    }

    // ── Connection ───────────────────────────────────────────────────────

    connect(): this {
        this.#socket.connect();
        return this;
    }

    /** Alias of `connect()`. */
    open(): this {
        return this.connect();
    }

    disconnect(): this {
        this.#socket.disconnect();
        return this;
    }

    /** Alias of `disconnect()`. */
    close(): this {
        return this.disconnect();
    }

    /** Drop the connection and open it again **with the current auth** — how a token is refreshed. */
    reconnect(): this {
        this.#socket.disconnect();
        this.#socket.connect();
        return this;
    }

    /**
     * Rebuild the connection with **new handshake headers** — `extraHeaders` is
     * fixed when the Socket.IO manager is created, so rotating a header (a Node
     * server that only reads `Authorization`) needs a new transport. The listeners
     * registered through this wrapper survive; the ones attached on `raw` do not.
     */
    reconnectWithHeaders(headers: Record<string, string>): this {
        this.#headers = { ...this.#headers, ...headers };
        this.#rebuild();
        return this;
    }

    /** Merge claims into the handshake payload; a live socket reconnects. */
    setAuth(patch: Record<string, any>): this {
        Object.assign(this.#auth, patch);
        (this.#socket as any).auth = { ...this.#auth };
        if (this.#socket.connected) this.reconnect();
        return this;
    }

    /**
     * Set (or clear) `auth.token`; a live socket reconnects so the next handshake
     * carries it.
     */
    setToken(token?: string): this {
        if (token) this.#auth.token = token;
        else delete this.#auth.token;
        (this.#socket as any).auth = { ...this.#auth };
        if (this.#socket.connected) this.reconnect();
        return this;
    }

    /** Declare rooms to (re)join — they are joined immediately when connected. */
    setRooms(rooms: string[], joinEvent?: string): this {
        this.#rooms = [...rooms];
        if (joinEvent) this.#joinEvent = joinEvent;
        if (this.#socket.connected) this.#rejoin();
        return this;
    }

    // ── Listening ────────────────────────────────────────────────────────

    /** Listen to a server event. */
    on<K extends keyof ListenEvents & string>(event: K, listener: ListenEvents[K]): this;
    on(event: string, listener: Listener): this;
    on(event: string, listener: Listener): this {
        this.#track(this.#listeners, event, listener);
        this.#socket.on(event, listener);
        return this;
    }

    /** Listen once — the listener is removed before it runs. */
    once<K extends keyof ListenEvents & string>(event: K, listener: ListenEvents[K]): this;
    once(event: string, listener: Listener): this;
    once(event: string, listener: Listener): this {
        const wrapper: Listener = (...args: any[]) => {
            this.#onceListeners.get(event)?.delete(wrapper);
            listener(...args);
        };
        this.#track(this.#onceListeners, event, wrapper);
        this.#socket.once(event, wrapper);
        return this;
    }

    /** Remove a listener — or every listener of that event. */
    off<K extends keyof ListenEvents & string>(event: K, listener?: ListenEvents[K]): this;
    off(event: string, listener?: Listener): this;
    off(event: string, listener?: Listener): this {
        if (listener) {
            this.#listeners.get(event)?.delete(listener);
            this.#socket.off(event, listener);
        } else {
            this.#listeners.delete(event);
            this.#onceListeners.delete(event);
            this.#socket.off(event);
        }
        return this;
    }

    /** Every event, whatever its name — `(event, ...args)`; useful for a debug panel. */
    onAny(listener: Listener): this {
        this.#anyListeners.push(listener);
        this.#socket.onAny(listener);
        return this;
    }

    /** Same, but registered **before** the existing listeners. */
    prependAny(listener: Listener): this {
        this.#prepended.push(listener);
        this.#socket.prependAny(listener);
        return this;
    }

    offAny(listener?: Listener): this {
        if (listener) {
            this.#anyListeners = this.#anyListeners.filter((entry) => entry !== listener);
            this.#prepended = this.#prepended.filter((entry) => entry !== listener);
            this.#socket.offAny(listener);
        } else {
            this.#anyListeners = [];
            this.#prepended = [];
            this.#socket.offAny();
        }
        return this;
    }

    /** Every event this socket **sends** — the outgoing side of `onAny`. */
    onAnyOutgoing(listener: Listener): this {
        this.#outgoingListeners.push(listener);
        this.#socket.onAnyOutgoing(listener);
        return this;
    }

    offAnyOutgoing(listener?: Listener): this {
        if (listener) {
            this.#outgoingListeners = this.#outgoingListeners.filter((entry) => entry !== listener);
            this.#socket.offAnyOutgoing(listener);
        } else {
            this.#outgoingListeners = [];
            this.#socket.offAnyOutgoing();
        }
        return this;
    }

    /** Fires on every (re)connection. */
    onConnect(listener: Listener): this {
        return this.on("connect", listener);
    }

    /** `(reason)` — `io server disconnect`, `transport close`, `ping timeout`… */
    onDisconnect(listener: Listener): this {
        return this.on("disconnect", listener);
    }

    /** `(error)` — a refused handshake (the `authorize` hook, a bad token). */
    onConnectError(listener: Listener): this {
        return this.on("connect_error", listener);
    }

    listeners(event: string): Listener[] {
        return this.#socket.listeners(event);
    }

    listenerCount(event: string): number {
        return this.listeners(event).length;
    }

    hasListeners(event: string): boolean {
        return this.#socket.hasListeners(event);
    }

    /**
     * Remove listeners — all of them, or only those of `event`. The internal
     * re-join handler is reinstalled (a declared `rooms` list keeps working).
     */
    removeAllListeners(event?: string): this {
        if (event) {
            this.#listeners.delete(event);
            this.#onceListeners.delete(event);
            this.#socket.removeAllListeners(event);
            return this;
        }
        this.#listeners.clear();
        this.#onceListeners.clear();
        this.#anyListeners = [];
        this.#prepended = [];
        this.#outgoingListeners = [];
        this.#socket.removeAllListeners();
        this.#socket.on("connect", this.#onConnectRejoin);
        return this;
    }

    // ── Emitting ─────────────────────────────────────────────────────────

    /** Send an event — `socket.emit('chat', data)`, or with an ack callback last. */
    emit<K extends keyof EmitEvents & string>(event: K, ...args: Parameters<EmitEvents[K]>): this;
    emit(event: string, ...args: any[]): this;
    emit(event: string, ...args: any[]): this {
        this.#socket.emit(event, ...args);
        return this;
    }

    /**
     * Send an event and wait for the server's acknowledgement.
     *
     * ```ts
     * const total = await socket.emitWithAck<number>('sum', 1, 2);
     * ```
     */
    emitWithAck<T = any>(event: string, ...args: any[]): Promise<T> {
        const target = this.#timeoutMs !== undefined ? this.#socket.timeout(this.#timeoutMs) : this.#socket;
        return target.emitWithAck(event, ...args) as Promise<T>;
    }

    /** The `message` event — `socket.send('hi')` is `socket.emit('message', 'hi')`. */
    send(...args: any[]): this {
        this.#socket.send(...args);
        return this;
    }

    /** An emitting view whose acknowledgements give up after `ms`. */
    timeout(ms: number): SocketEmitter {
        return new SocketEmitter(this.#socket.timeout(ms), ms);
    }

    /** An emitting view that drops the event when the transport is not ready. */
    get volatile(): SocketEmitter {
        return new SocketEmitter(this.#socket.volatile, this.#timeoutMs);
    }

    compress(compress: boolean): SocketEmitter {
        return new SocketEmitter(this.#socket.compress(compress), this.#timeoutMs);
    }

    /**
     * Wait for one event as a promise — the one-shot form of `once`.
     *
     * ```ts
     * const welcome = await socket.waitFor('welcome', 5_000);
     * ```
     */
    waitFor<T = any>(event: string, timeoutMs = this.#waitForMs): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const handler = (value: T) => {
                clearTimeout(timer);
                this.#socket.off(event, handler);
                resolve(value);
            };
            const timer = setTimeout(() => {
                this.#socket.off(event, handler);
                reject(timeoutError(event, timeoutMs));
            }, timeoutMs);
            this.#socket.on(event, handler);
        });
    }

    #track(map: Map<string, Set<Listener>>, event: string, listener: Listener): void {
        let set = map.get(event);
        if (!set) {
            set = new Set();
            map.set(event, set);
        }
        set.add(listener);
    }
}
