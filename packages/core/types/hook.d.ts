import type { MongoRest } from "../database/mongodbadapter";
import type { Server as SocketIO } from "socket.io";
import type { ActionsApiList } from "./api";

export type HookMeta = {
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

/** Context passed to a collection hook (`define.Hook`). */
export type HookContext = {
    rest: MongoRest;
    action: ActionsApiList;
    meta: HookMeta;
    io: SocketIO;
};

/** A collection hook — `define.Hook(fn)`, used as beforeOperation/afterOperation. */
export type CollectionHook = (ctx: HookContext) => Promise<void>;

export type HooksCollection = {
    beforeOperation?: CollectionHook;
    afterOperation?: CollectionHook;
}
