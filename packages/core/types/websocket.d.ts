import type { Server as SocketIO, Socket as SocketClient } from "socket.io";
import type { useRest } from "../database/rest";
import type { TenantAgents } from "./agent";
import type { Api } from "../lib/api";
import type { fn } from "../lib/error";
import type { jwt } from "../utils/func";

/** Context handed to an `api.access` rule of a WebSocket handler (same contract as agents/MCP). */
export type WebSocketAccessContext = {
    rest: InstanceType<typeof useRest>;
    error: typeof fn.error;
    jwt: typeof jwt;
    token: { value: string | null; decoded: Record<string, unknown> | null; provided: boolean; expired: boolean };
    tenant: string;
    socketId: string;
};

export type WebSocketAccess = {
    connect?: boolean | ((ctx: WebSocketAccessContext) => boolean | Promise<boolean>);
    '*'?: boolean | ((ctx: WebSocketAccessContext) => boolean | Promise<boolean>);
};



export type WebSocketHandler = {
    _isWebSocket_?: boolean;
    _tenant_?: string;
    enabled: boolean;
    /** Per-connection access — **no rule = denied** (secure by default). */
    api?: { access?: WebSocketAccess };
    exec: (ctx: {
        io: SocketIO;
        socket: SocketClient;
        rest: InstanceType<typeof useRest>;
        /** Tenant-scoped LLM registry — `agents.get('support')`, bound to `rest`. */
        agents: TenantAgents;
        /** The in-process facade — `api.collection("orders")`, `api.service("analytics")`, `api.vars`, `api.files`, `api.agent(id)`. */
        api: Api;
    }) => void | Promise<void>;
};
