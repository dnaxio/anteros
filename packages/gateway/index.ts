export { defineGateway, resolveGatewayConfig, shouldLogRequest } from "./lib/config";
export { loadGatewayConfig } from "./lib/configFile";
export { buildDownstreamHeaders, buildUpstreamHeaders } from "./lib/headers";
export type { UpstreamHeaderContext } from "./lib/headers";
export { proxyRequest } from "./lib/proxy";
export type { ProxyContext } from "./lib/proxy";
export { matchMicroservice } from "./lib/router";
export type { RouteMatch } from "./lib/router";
export { createGateway } from "./lib/server";
export type { Gateway } from "./lib/server";
export { GatewayConfigError } from "./types";
export type {
    GatewayBodyCaptureConfig,
    GatewayConfig,
    GatewayConfigErrorCode,
    GatewayCorsConfig,
    GatewayLogEngine,
    GatewayLogEntry,
    GatewayLogLevel,
    GatewayLoggingConfig,
    GatewayLogRotation,
    GatewayMicroservice,
    ResolvedGatewayBodyCaptureConfig,
    ResolvedGatewayConfig,
    ResolvedGatewayCorsConfig,
    ResolvedGatewayLoggingConfig,
    ResolvedGatewayLogRotation,
    ResolvedGatewayMicroservice,
} from "./types";
