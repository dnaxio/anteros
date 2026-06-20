import { define } from "./lib/define";
import { bootApp } from "./server/boot";
import { useRest } from "./database/rest";
import * as v from "joi";
import utils from "./utils";
import * as crypto from "./utils/crypto";


// Imort bentocache use as cache
import { useMemoryCache, useFilesystemCache, useRedisCache } from "./utils/cache";
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
    v,
    utils,
    cache,
    crypto,
}
