import type { ServerConfig } from "../types/config";
import type { Collection } from "../types/collection";
import type { FileCollection } from "../types/file";
import type { Script } from "../types/scripts";
import type { Route } from "../types/route";
import type { Service } from "../types/service";
import type { WebSocketHandler } from "../types/websocket";
import type { TenantMiddlewareConfig, GlobalMiddlewareConfig } from "../types/middleware";
import { file } from "bun";
function Server(config: ServerConfig) {
    config.clusterMode = config?.clusterMode ?? true;
    config.server = {
        ...config?.server,
    }

    return config;
}


function Collection(collection: Collection): Collection {


    collection.type = collection.type ?? 'document';



    return {
        ...collection,
        _isTimeSerie_: false,
        _isCollection_: true,

    }
}

function FileCollection(collection: FileCollection): FileCollection {
    return {
        ...collection,
        _isTimeSerie_: false,
        _isFileCollection_: true,
    }
}

function Script(config: Script) {
    return {
        ...config,
        _isScript_: true,
    }
}


function Route(route: Route): Route {
    return {
        ...route,
        enabled: route.enabled ?? true,
        _isRoute_: true,
    }
}

function Service(service: Service): Service {
    return {
        ...service,
        _isService_: true,
    }
}


function TenantMiddleware(config: TenantMiddlewareConfig): TenantMiddlewareConfig {
    return {
        ...config,
        enabled: config.enabled ?? true,
        _isTenantMiddleware_: true,
    }
}

function WebSocket(handler: WebSocketHandler): WebSocketHandler {
    return {
        ...handler,
        enabled: handler.enabled ?? true,
        _isWebSocket_: true,
    }
}

function Middleware(config: GlobalMiddlewareConfig): GlobalMiddlewareConfig {
    return {
        ...config,
        enabled: config.enabled ?? true,
        _isGlobalMiddleware_: true,
    }
}

import type { WorkflowDefinition } from "../types/workflow";

export function Workflow<TData = any>(workflow: WorkflowDefinition<TData>): WorkflowDefinition<TData> {
    return {
        ...workflow,
        _isWorkflow_: true,
    }
}



export const define = {
    Server: Server,
    App: Server,
    Collection,
    FileCollection,
    Script,
    Route,
  Service,
  Workflow,
  TenantMiddleware,
  Middleware,
  WebSocket
}
