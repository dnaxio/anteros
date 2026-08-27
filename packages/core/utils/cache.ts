import { BentoCache, bentostore } from "bentocache";
import { memoryDriver } from "bentocache/drivers/memory";
import { redisDriver } from "bentocache/drivers/redis";
import { fileDriver } from "bentocache/drivers/file";
import path from "path";

/** The underlying BentoCache instance — full provider API, with autocompletion */
export type Cache = InstanceType<typeof BentoCache>;

type Driver = 'memory' | 'redis' | 'filesystem';

type CacheOptions = {
    filesystem?: {
        directory: string;
    },
    redis?: {
        connection: {
            host: string;
            port: number;
            password: string;
        };
    },
    pruneInterval?: string;
}

function createCache(driver: Driver, options?: CacheOptions): Cache {
    let store = bentostore().useL1Layer(memoryDriver({}))

    if (driver == 'filesystem') {
        store = store.useL2Layer(fileDriver({
            directory: options?.filesystem?.directory ?? path.join(process.cwd(), '.cache'),
            pruneInterval: options?.pruneInterval ?? '1h'
        }))
    }

    if (driver == 'redis' && options?.redis?.connection) {
        store = store.useL2Layer(redisDriver({
            connection: options.redis.connection
        }))
    }
    return new BentoCache({
        default: driver,
        stores: {
            [driver]: store,
        }
    })
}


function useRedisCache(options: {
    connection: {
        host: string;
        port: number;
        password: string;
    };
    pruneInterval?: string;
}): Cache {
    return createCache('redis', {
        redis: {
            connection: options.connection,
        },
        pruneInterval: options.pruneInterval,
    });
}

function useMemoryCache(): Cache {
    return createCache('memory');
}

function useFilesystemCache(options: {
    directory: string;
    pruneInterval?: string;
}): Cache {
    return createCache('filesystem', {
        filesystem: {
            directory: options.directory,
        },
        pruneInterval: options.pruneInterval,
    });
}



export {

    useFilesystemCache,
    useMemoryCache,
    useRedisCache
}
