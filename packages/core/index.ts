

import { define } from "./lib/define";
import { bootApp } from "./server/boot";
import { useRest } from "./database/rest";
import { AppError } from "./lib/error";
import { Agent } from "./lib/agent";
import { agents } from "./lib/agents";
import { endpoints } from "./lib/endpoints";
import * as v from "joi";
import utils from "./utils";




// BentoCache-based caching (memory L1 + filesystem/Redis L2)
import { useMemoryCache, useFilesystemCache, useRedisCache } from "./utils/cache";
import { logger } from "./utils/logger";
import { startReplication, stopReplication, replicationNow, getReplicationState, resetReplication, seedReplication } from "./database/replication";
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
    Agent,
    agents,
    endpoints,
}
