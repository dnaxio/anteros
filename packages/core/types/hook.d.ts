import type { MongoRest } from "../database/mongodbadapter";
import type { Server as SocketIO } from "socket.io";
import type { ActionsApiList } from "./api";
import type { TenantAgents } from "./agent";
import type { Api } from "../lib/api";

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
    /** Tenant-scoped LLM registry — `agents.get('support')`, bound to `rest`. */
    agents: TenantAgents;
    /** The in-process facade — `api.collection("orders")`, `api.service("analytics")`, `api.vars`, `api.files`, `api.agent(id)`. */
    api: Api;
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
