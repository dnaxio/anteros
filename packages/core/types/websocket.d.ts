import type { Server as SocketIO, Socket as SocketClient } from "socket.io";
import type { useRest } from "../database/rest";
import type { TenantAgents } from "./agent";
import type { Api } from "../lib/api";
import type { Tenant } from "./tenant";

/** What a handler receives — one connection at a time. */
export type WebSocketContext = {
    io: SocketIO;
    socket: SocketClient;
    rest: InstanceType<typeof useRest>;
    /** Tenant-scoped LLM registry — `agents.get('support')`, bound to `rest`. */
    agents: TenantAgents;
    /** The in-process facade — `api.collection("orders")`, `api.service("analytics")`, `api.vars`, `api.files`, `api.agent(id)`. */
    api: Api;
    /** The tenant this handler belongs to. */
    tenant: Tenant;
};

export type WebSocketHandler = {
    _isWebSocket_?: boolean;
    _tenant_?: string;
    enabled: boolean;
    /**
     * The Socket.IO namespace this handler serves (default `'/'`). Each namespace
     * has its own rooms and its own connections.
     */
    namespace?: string;
    /**
     * Refuse the connection before `exec` runs — a `false` (or a throw) closes the
     * socket. Runs **after** the global `server.sockets.authorize` (the transport
     * layer), and sees the tenant's `rest`/`api`/`agents`.
     */
    authorize?: (ctx: WebSocketContext) => boolean | Promise<boolean>;
    exec: (ctx: WebSocketContext) => void | Promise<void>;
};
