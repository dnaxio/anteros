import type { Context } from "hono";
import type { useRest } from "../database/rest";
import type { TenantAgents } from "./agent";
import type { Api } from "../lib/api";

type routeContext = {
    rest: InstanceType<typeof useRest>;
    /** Tenant-scoped LLM registry — `agents.get('support')`, bound to `rest`. */
    agents: TenantAgents;
    /** The in-process facade — `api.collection("orders")`, `api.service("analytics")`, `api.vars`, `api.files`, `api.agent(id)`. */
    api: Api;
    jwt: typeof jwt;
    io: InstanceType<IO>;
    c: Context
}

type Route = {
    enabled?: boolean;
    path: string;
    method: 'GET' | 'POST'|'PUT';
    handler: (ctx: routeContext) => void;
    _tenant_?: string;
    _isRoute_?: boolean;
    _prefix_?: string;
}
