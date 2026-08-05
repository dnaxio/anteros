import type { Context } from "hono";
import type { useRest } from "../database/rest";

type routeContext = {
    rest: InstanceType<typeof useRest>;
    jwt: typeof jwt;
    io: InstanceType<typeof IO>;
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
