

import { define } from "./lib/define";
import { bootApp } from "./server/boot";
import { useRest } from "./database/rest";
import { AppError } from "./lib/error";
import { Agent } from "./lib/agent";
import { agents } from "./lib/agents";
import { evaluateAgent } from "./lib/eval";
import { endpoints } from "./lib/endpoints";
import * as v from "joi";
import utils from "./utils";
import {ObjectId} from "mongodb"




// BentoCache-based caching (memory L1 + filesystem/Redis L2)
import { useMemoryCache, useFilesystemCache, useRedisCache } from "./utils/cache";
import { logger } from "./utils/logger";
import { builtinToolsFor, BUILTIN_TOOL_NAMES } from "./lib/builtinTools";
import { startReplication, stopReplication, replicationNow, getReplicationState, resetReplication, seedReplication } from "./database/replication";
import { tasks } from "./lib/task";
const cache = {
    useMemoryCache,
    useFilesystemCache,
    useRedisCache
}
const replication = {
    start: startReplication,
    stop: stopReplication,
    now: replicationNow,
    state: getReplicationState,
    reset: resetReplication,
    seed: seedReplication,
}
const app = {
    boot: bootApp
}

export {
    define,
    app,
    useRest,
    AppError,
    v,
    utils,
    cache,
    replication,
    logger,
    tasks,
    Agent,
    agents,
    evaluateAgent,
    endpoints,
    builtinToolsFor,
    BUILTIN_TOOL_NAMES,
}

export type {
    AgentMemoryContext,
    AgentRecallHit,
    AgentRecallQuery,
    AgentRecallRecord,
    AgentRunState,
    AgentRunStore,
    AgentSemanticRecallOptions,
    AgentTraceEvent,
    BuiltinToolName,
    BuiltinToolsOptions,
} from "./types/agent";

export type {
    AgentEvalCase,
    AgentEvalCaseReport,
    AgentEvalGrader,
    AgentEvalReport,
} from "./lib/eval";

export type {
    TaskConfig,
    TaskDocument,
    TaskInfo,
    TaskRunContext,
    TaskRunResult,
    TaskTrigger,
    TaskUpdate,
} from "./types/task";
