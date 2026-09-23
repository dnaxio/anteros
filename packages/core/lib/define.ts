import type { ServerConfig } from "../types/config";
import type { Collection, CollectionAction } from "../types/collection";
import type { CollectionHook } from "../types/hook";
import type { FileCollection } from "../types/file";
import type { Script } from "../types/scripts";
import type { Route } from "../types/route";
import type { Service } from "../types/service";
import type { WebSocketHandler } from "../types/websocket";
import type { TenantMiddlewareConfig, GlobalMiddlewareConfig } from "../types/middleware";
import type { McpTool, McpResource } from "../types/mcp";
import type { Lifecycle } from "../types/lifecycle";
import type { VarDefinition } from "../types/vars";
import { file } from "bun";
function Server(config: ServerConfig) {
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

/**
 * Defines a custom action on a collection — usable in `define.Collection({ actions: { ... } })`.
 *
 * @example
 * ```ts
 * const processOrder = define.Action(async ({ rest, data, error }) => {
 *   const order = await rest.findOne("orders", data.orderId);
 *   if (!order) throw error("Order not found", { status: 404 });
 *   return { ok: true };
 * });
 *
 * define.Collection({ slug: "orders", actions: { processOrder } })
 * ```
 */
function Action(action: CollectionAction): CollectionAction & { _isAction_: true } {
    return Object.assign(action, { _isAction_: true }) as CollectionAction & { _isAction_: true };
}

/**
 * Defines a collection hook — usable as `beforeOperation` / `afterOperation`.
 *
 * @example
 * ```ts
 * const softDelete = define.Hook(async ({ rest, action, meta }) => {
 *   if (action === 'deleteOne' && meta.id) {
 *     await rest.updateOne("items", meta.id, { $set: { deletedAt: new Date().toISOString() } });
 *   }
 * });
 *
 * define.Collection({ slug: "items", hooks: { beforeOperation: softDelete } })
 * ```
 */
function Hook(hook: CollectionHook): CollectionHook & { _isHook_: true } {
    return Object.assign(hook, { _isHook_: true }) as CollectionHook & { _isHook_: true };
}

function McpTool(tool: McpTool): McpTool {
    return {
        ...tool,
        enabled: tool.enabled ?? true,
        _isMcpTool_: true,
    }
}

function McpResource(resource: McpResource): McpResource {
    return {
        ...resource,
        enabled: resource.enabled ?? true,
        _isMcpResource_: true,
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

function Lifecycle(config: Lifecycle): Lifecycle {
    return {
        ...config,
        enabled: config.enabled ?? true,
        _isLifecycle_: true,
    }
}

function Vars(config: VarDefinition): VarDefinition {
    return {
        ...config,
        _isVars_: true,
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
import type { AgentConfig, AgentTool, AgentToolDefinition } from "../types/agent";

export function Workflow<TData = any>(workflow: WorkflowDefinition<TData>): WorkflowDefinition<TData> {
    return {
        ...workflow,
        enabled: workflow.enabled ?? true,
        _isWorkflow_: true,
    }
}

/**
 * Declares an LLM agent — `{tenant.dir}/agents/**\/*.agent.ts`.
 *
 * `id` and `description` are **required**: the id identifies it (and looks it up),
 * the description says what it is for — it is served by `info` and read by humans.
 *
 * @example
 * ```ts
 * export default define.Agent({
 *   id: 'weather',
 *   description: 'Answers weather questions with a live forecast.',
 *   instructions: 'You are a concise weather assistant.',
 *   provider: { model: 'gpt-4o-mini', compatible: 'openai' },
 *   tools: { forecast },
 * })
 * ```
 */
function Agent(config: AgentConfig & { id: string; description: string }): AgentConfig {
    return {
        ...config,
        enabled: config.enabled ?? true,
        _isAgent_: true,
    }
}

/**
 * Declares an agent tool — `define.Tool({ id, description, inputSchema, execute })`.
 * The `id` is **required** (it is the name the model calls).
 * A `define.McpTool` is accepted by an agent as-is.
 */
function Tool(tool: AgentToolDefinition): AgentToolDefinition {
    return {
        ...tool,
        enabled: tool.enabled ?? true,
        _isTool_: true,
    }
}



export const define = {
    Server: Server,
    App: Server,
    Collection,
    Action,
    Hook,
    FileCollection,
    Script,
    Route,
  Service,
  Workflow,
  TenantMiddleware,
  Middleware,
  WebSocket,
  McpTool,
  McpResource,
  Lifecycle,
  Vars,
  Agent,
  Tool,
}
