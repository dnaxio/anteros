import type { Context, Next } from "hono";

export type TenantMiddlewareHandler = (c: Context, next: Next) => Promise<void | Response>;

export type TenantMiddlewareConfig = {
  name: string;
  enabled?: boolean;
  handler: TenantMiddlewareHandler;
  _isTenantMiddleware_?: boolean;
  _tenant_?: string;
};

export type GlobalMiddlewareConfig = {
  name: string;
  enabled?: boolean;
  handler: TenantMiddlewareHandler;
  _isGlobalMiddleware_?: boolean;
};
