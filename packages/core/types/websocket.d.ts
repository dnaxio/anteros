import type { Server as SocketIO, Socket as SocketClient } from "socket.io";
import type { useRest } from "../database/rest";
import type { TenantAgents } from "./agent";
import type { Api } from "../lib/api";



export type WebSocketHandler = {
    _isWebSocket_?: boolean;
    _tenant_?: string;
    enabled: boolean;
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
