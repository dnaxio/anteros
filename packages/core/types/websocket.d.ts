import type { Server as SocketIO, Socket as SocketClient } from "socket.io";
import type { useRest } from "../database/rest";



export type WebSocketHandler = {
    _isWebSocket_?: boolean;
    _tenant_?: string;
    enabled: boolean;
    exec: (ctx: {
        io: SocketIO;
        socket: SocketClient;
        rest: InstanceType<typeof useRest>;
    }) => void | Promise<void>;
};
