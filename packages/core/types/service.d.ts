import type { Server as SocketIO } from "socket.io";
import type { useRest } from "../database/rest";
import type { fn } from "../lib/error";
import type { jwt } from "../utils/func";
import type { TenantAgents } from "./agent";
import type { Api } from "../lib/api";

export type Service = {
    _isService_?: boolean;
    _tenant_?: string;
    name: string;
    enabled: boolean;
    api?: {
        access?: {
            '*'?: ((ctx: {
                rest: InstanceType<typeof useRest>;
                error: typeof fn.error;
                jwt: typeof jwt;
                token: { value: string | null; decoded: Record<string, unknown> | null; provided: boolean; expired: boolean };
            }) => Promise<boolean> | boolean) | boolean;
            [key: string]: ((ctx: {
                rest: InstanceType<typeof useRest>;
                error: typeof fn.error;
                jwt: typeof jwt;
                token: { value: string | null; decoded: Record<string, unknown> | null; provided: boolean; expired: boolean };
            }) => Promise<boolean> | boolean) | boolean;
        };
    };
    actions: {
        [key: string]: (ctx: {
            data: any;
            token: { value: string | null; decoded: Record<string, unknown> | null; provided: boolean; expired: boolean };
            jwt: typeof jwt;
            error: typeof fn.error;
            io: SocketIO;
            rest: InstanceType<typeof useRest>;
            /** Tenant-scoped LLM registry — `agents.get('support')`, bound to `rest`. */
            agents: TenantAgents;
            /** The in-process facade — `api.collection("orders")`, `api.service("analytics")`, `api.vars`, `api.files`, `api.agent(id)`. */
            api: Api;
        }) => Promise<any>
    }
}
