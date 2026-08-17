

import { define } from "./lib/define";
import { bootApp } from "./server/boot";
import { useRest } from "./database/rest";
import { AppError } from "./lib/error";
import * as v from "joi";
import utils from "./utils";




// BentoCache-based caching (memory L1 + filesystem/Redis L2)
import { useMemoryCache, useFilesystemCache, useRedisCache } from "./utils/cache";
import { logger } from "./utils/logger";
const cache = {
    useMemoryCache,
    useFilesystemCache,
    useRedisCache
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
    logger,
}
