import type { ManagerOptions, SocketOptions } from "socket.io-client";

/** The `auth` payload a Socket.IO handshake carries. */
export type SocketAuth = Record<string, any>;

/**
 * Options of `client.socket()` — Socket.IO's own options, plus the SDK's:
 *
 * - `auth` is **merged over** `{ tenant, token }`, so a caller adds claims without
 *   losing the caller identity the framework's `server.sockets.authorize` reads;
 * - `headers` is merged over the SDK's headers (the `Authorization` of the HTTP
 *   client included) — a Node client can present the token either way;
 * - `timeoutMs` is the default acknowledgement deadline of `emitWithAck()`;
 * - `rooms` are joined **on every (re)connection**, by emitting `joinEvent`;
 * - `waitForTimeoutMs` is the default deadline of `waitFor()`.
 */
export type SdkSocketOptions = Omit<Partial<ManagerOptions & SocketOptions>, "auth" | "extraHeaders"> & {
    /** Handshake credentials — `{ tenant, token }` is filled in, and these win. */
    auth?: SocketAuth;
    /** Extra handshake headers, merged over the SDK's. */
    headers?: Record<string, string>;
    /** Default deadline of an acknowledgement, in ms (`emitWithAck`). */
    timeoutMs?: number;
    /** Default deadline of `waitFor()`, in ms (10 000 when omitted). */
    waitForTimeoutMs?: number;
    /**
     * Rooms to (re)join automatically — `['room-42']`. The socket emits
     * `joinEvent(room)` on every connection, including a reconnection: rooms are
     * server-side and do not survive a dropped socket.
     */
    rooms?: string[];
    /** Event used to join the `rooms` (default `'room:join'`). */
    joinEvent?: string;
};
