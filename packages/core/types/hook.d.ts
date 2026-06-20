import type { MongoRest } from "../database/mongodbadapter";
import type { Server as SocketIO } from "socket.io";
import type { ActionsApiList } from "./api";
type metaHook = {
    action: ActionsApiList;
    collection: string;
    data?: any;
    params?: any;
    ids?: string[];
    filter?: object;
    id?: string;
    update?: any;
    result?: any;
    pipeline?: any[];
    options?: any;
}
export type HooksCollection = {
    beforeOperation?: (ctx: {
        rest: MongoRest;
        action: ActionsApiList;
        meta: metaHook;
        io: SocketIO;
    }) => Promise<void>;
    afterOperation?: (ctx: {
        rest: MongoRest;
        action: ActionsApiList;
        meta: metaHook;
        io: SocketIO;
    }) => Promise<void>;
}
