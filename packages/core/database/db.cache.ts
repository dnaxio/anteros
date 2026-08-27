import { createHash } from "node:crypto";
import path from "node:path";
import type { FindOptions, FindCallOptions } from "../types/mongo";
import { type Cache, useFilesystemCache, useMemoryCache, useRedisCache } from "../utils/cache";
import { cfg } from "../server/config";

/**
 * DB query cache — cache-aside for `find` with `{ useCache: true }`.
 * (`findOne` is never cached — point queries, no gain.)
 *
 * - Key = sha1(collection params + options) → stored in a per-collection namespace
 *   (`db:{tenant}:{collection}`).
 * - Every cached query is **tagged with the `_id`s of its results** (including the
 *   `_id`s of `$include`d documents) via bentocache's client-side tagging
 *   (`ctx.setTags` — adaptive caching, tags known after the factory runs).
 * - On a write with known ids (update/delete), `deleteByTag` removes exactly the
 *   cached queries whose result contains one of those `_id`s (targeted). Writes
 *   with unknown/new ids (insert, bulk, findOneAndUpdate) clear the namespace.
 * - Relations are tracked: if `orders` caches a query with `$include: ['clients']`,
 *   its entries are tagged with the embedded client `_id`s too — so modifying a
 *   client invalidates exactly the `orders` queries that embed it.
 */

const NAMESPACE = 'db';
const REL_NS = 'db:rel';

/** Sanitary cap on tags per entry (bentocache high-cardinality guidance) — configurable via `server.cache.maxTags`. The cost is ~0.18µs per tag check on each hit, negligible vs the cost of the real query */
const DEFAULT_MAX_TAGS = 50_000;

let dbCache: Cache | null = null;

/** Lazy singleton — configured once from `cfg.server.cache` (default: memory) */
function resolveCache(): Cache {
    if (!dbCache) {
        const conf = cfg.server.cache ?? {};
        const driver = conf.driver ?? 'memory';
        if (driver === 'redis') {
            dbCache = useRedisCache({
                connection: {
                    host: conf.redis?.host ?? 'localhost',
                    port: conf.redis?.port ?? 6379,
                    password: conf.redis?.password ?? '',
                },
                pruneInterval: conf.pruneInterval,
            });
        } else if (driver === 'filesystem') {
            dbCache = useFilesystemCache({
                directory: conf.directory ?? path.join(process.cwd(), '.cache'),
                pruneInterval: conf.pruneInterval ?? '1h',
            });
        } else {
            dbCache = useMemoryCache();
        }
    }
    return dbCache;
}

function isEnabled(): boolean {
    // Opt-in: the DB query cache is disabled unless `cache.enabled: true`
    return cfg.server.cache?.enabled === true;
}

function colNs(tenant: string, collection: string): string {
    return `${NAMESPACE}:${tenant}:${collection}`;
}

function relNs(tenant: string): string {
    return `${REL_NS}:${tenant}`;
}

function hashQuery(params: FindOptions, options: FindCallOptions = {}): string {
    return createHash('sha1').update(JSON.stringify({ params, options })).digest('hex');
}

/** Effective TTL: query option (server-side only) > collection def > server config > default '5m' */
function ttlFor(collection: string, optionsTtl?: string | number): string | number {
    const col = cfg.collections?.find((c) => c.slug === collection);
    return optionsTtl ?? col?.cache?.ttl ?? cfg.server.cache?.ttl ?? '5m';
}

/** `$include` field names — used to tag embedded `_id`s for cross-collection invalidation */
function includeFields(params: FindOptions): string[] {
    return (params.$include ?? []).map((inc) => (typeof inc === 'string' ? inc : inc?.localField ?? inc?.from ?? '')).filter(Boolean);
}

/** Collect the `_id`s of a result — main docs + `$include`d embedded docs */
function extractResultIds(result: any, includes: string[]): string[] {
    const ids = new Set<string>();
    const add = (v: any) => {
        if (v && typeof v === 'object' && v._id !== undefined) ids.add(String(v._id));
    };
    for (const doc of Array.isArray(result) ? result : [result]) {
        add(doc);
        for (const inc of includes) {
            const embedded = doc?.[inc];
            if (Array.isArray(embedded)) embedded.forEach(add);
            else add(embedded);
        }
    }
    return [...ids];
}

/**
 * Cache-aside read-through: serve the cached result for this query, otherwise run
 * the factory (the real query) and store it, tagged by the result `_id`s.
 */
export async function dbGetOrSet<T>(
    collection: string,
    tenant: string,
    params: FindOptions,
    options: FindCallOptions,
    factory: () => Promise<T>,
): Promise<T> {
    if (!isEnabled()) return factory();
    const cache = resolveCache();
    const key = hashQuery(params, options);
    const ns = cache.namespace(colNs(tenant, collection));
    const includes = includeFields(params);

    // Adaptive caching: the tags (result `_id`s) are only known after the factory runs
    const value = await ns.getOrSet({
        key,
        ttl: ttlFor(collection, options.ttl),
        factory: async (ctx: any) => {
            const fresh = await factory();
            const maxTags = cfg.server.cache?.maxTags ?? DEFAULT_MAX_TAGS;
            const tags = extractResultIds(fresh, includes).slice(0, maxTags).map((id) => `id:${id}`);
            if (tags.length) ctx.setTags(tags);
            return fresh;
        },
    });

    await recordRelations(cache, tenant, collection, params);
    return value as T;
}

/**
 * Register the collections this query depends on (via `$include` / `$lookup`) so a
 * write on the *included* collection invalidates the *parent* collection too.
 */
async function recordRelations(cache: Cache, tenant: string, collection: string, params: FindOptions) {
    const col = cfg.collections?.find((c) => c.slug === collection && c._tenant_ === tenant);
    const targets = new Set<string>();
    for (const inc of params.$include ?? []) {
        if (typeof inc === 'string') {
            const f = col?.fields.find((f) => f.name === inc);
            if (f?.type === 'relationship' && f.relation?.to) targets.add(f.relation.to);
        } else if (inc?.from) {
            targets.add(inc.from);
        }
    }
    if (!targets.size) return;
    const rel = cache.namespace(relNs(tenant));
    for (const target of targets) {
        if (target === collection) continue;
        const deps = ((await rel.get({ key: target })) as string[]) ?? [];
        if (!deps.includes(collection)) {
            deps.push(collection);
            await rel.set({ key: target, value: deps, ttl: '7d' });
        }
    }
}

/**
 * Invalidate a collection's cached queries after a write.
 * - `ids` provided (update/delete of known documents) → **targeted**: only the
 *   cached queries tagged with one of those `_id`s are removed (deleteByTag).
 * - `ids` omitted (insert, bulk, unknown) → the whole collection namespace is cleared.
 * Relations ($include) are invalidated the same way on the dependent collections.
 */
export async function dbInvalidate(collection: string, tenant: string, ids?: string[]) {
    if (!isEnabled()) return;
    const cache = resolveCache();
    const ns = cache.namespace(colNs(tenant, collection));

    if (ids?.length) {
        // String(id) normalizes native ObjectIds to their 24-hex form
        await ns.deleteByTag({ tags: ids.map((id) => `id:${String(id)}`) });
    } else {
        await ns.clear();
    }

    // Relations: collections that $include this one embed its docs → invalidate them too
    const rel = cache.namespace(relNs(tenant));
    const dependents = ((await rel.get({ key: collection })) as string[]) ?? [];
    for (const dep of dependents) {
        const depNs = cache.namespace(colNs(tenant, dep));
        if (ids?.length) {
            await depNs.deleteByTag({ tags: ids.map((id) => `id:${String(id)}`) });
        } else {
            await depNs.clear();
        }
    }
    await rel.set({ key: collection, value: [] });
}

export { resolveCache as getDbCache };
