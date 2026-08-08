import { BentoCache, bentostore } from "bentocache";
import { memoryDriver } from "bentocache/drivers/memory";
import { redisDriver } from "bentocache/drivers/redis";
import { fileDriver } from "bentocache/drivers/file";
import path from "path";
const drivers = {
    memoryDriver,
    redisDriver,
    fileDriver,
}

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

class Cache {
    #cache: InstanceType<typeof BentoCache>;
    constructor(driver: Driver, options?: CacheOptions) {
        let store = bentostore().useL1Layer(memoryDriver({
        }))

        if (driver == 'filesystem') {
            store = store.useL2Layer(fileDriver({
                directory: path.join(process.cwd(), '.cache'),
                pruneInterval: '1h'
            }))
        }

        if (driver == 'redis' && options?.redis?.connection) {
            store = store.useL2Layer(redisDriver({
                connection: options.redis.connection
            }))
        }
        this.#cache = new BentoCache({
            default: driver,
            stores: {
                [driver]: store,
            }
        })
    }

    // ─── BentoCache provider API (delegated to the underlying instance) ───

    set(options: any): Promise<boolean> { return this.#cache.set(options); }
    setForever(options: any): Promise<boolean> { return this.#cache.setForever(options); }
    get(options: any): Promise<unknown> { return this.#cache.get(options); }
    getOrSet(options: any): Promise<unknown> { return this.#cache.getOrSet(options); }
    getOrSetForever(options: any): Promise<unknown> { return this.#cache.getOrSetForever(options); }
    has(options: any): Promise<boolean> { return this.#cache.has(options); }
    missing(options: any): Promise<boolean> { return this.#cache.missing(options); }
    pull(key: string): Promise<unknown> { return this.#cache.pull(key); }
    delete(options: any): Promise<boolean> { return this.#cache.delete(options); }
    deleteMany(options: any): Promise<boolean> { return this.#cache.deleteMany(options); }
    deleteByTag(options: any): Promise<boolean> { return this.#cache.deleteByTag(options); }
    expire(options: any): Promise<boolean> { return this.#cache.expire(options); }
    clear(options?: any): Promise<void> { return this.#cache.clear(options); }
    prune(): Promise<void> { return this.#cache.prune(); }
    namespace(namespace: string): any { return this.#cache.namespace(namespace); }
    disconnect(): Promise<void> { return this.#cache.disconnect(); }
}


function useRedisCache(options: {
    connection: {
        host: string;
        port: number;
        password: string;
    };
    pruneInterval?: string;
}) {
    return new Cache('redis', {
        redis: {
            connection: options.connection,
        },
        pruneInterval: options.pruneInterval,
    });
}

function useMemoryCache() {
    return new Cache('memory');
}

function useFilesystemCache(options: {
    directory: string;
    pruneInterval?: string;
}) {
    return new Cache('filesystem', {
        filesystem: {
            directory: options.directory,
        },
        pruneInterval: options.pruneInterval,
    });
}



export default Cache;
export {
    Cache,
    useFilesystemCache,
    useMemoryCache,
    useRedisCache
}
