import type { UpdateOneModel, UpdateManyModel, ClientSession, MongoClientOptions } from "mongodb";

export type RestActions =
    'insertOne' | 'insertMany' | 'updateOne' | 'updateMany' | 'replaceOne' | 'deleteOne' | 'deleteMany'

export type BulkUpdateOperation = { updateOne: UpdateOneModel } | { updateMany: UpdateManyModel };

/** Options for the streaming cursor methods (findCursor / aggregateCursor / findStream / aggregateStream) */
export type CursorOptions = {
    /** Number of documents fetched per batch from the server */
    batchSize?: number;
    /** Max execution time in ms — the query aborts with a timeout error if it runs longer */
    maxTimeMS?: number;
    /** Comment attached to the query — shows up in MongoDB profiling / slow query logs */
    comment?: string;
    /** Index hint — force a specific index: index name (`'email_1'`) or key pattern (`{ email: 1 }`) */
    hint?: string | Record<string, 1 | -1>;
    /** Compute the total count of matching docs in the background — each yielded item becomes `{ count, doc }` */
    withCount?: boolean;
    /** Abort the stream when the signal fires — iteration stops and the cursor is closed cleanly */
    signal?: AbortSignal;
    /** Transform each document on the fly (lazy — no intermediate array). Applied before `withCount` wraps the value */
    map?: (doc: any) => any;
    /** Page mode — when set, `findStream` yields `{ count, docs, hasNext() }` batches of this size instead of single docs */
    pageSize?: number;
};

/** Tenant-scoped cache API — `rest.cache.*` (namespace `app:{tenant_id}`) */
export type TenantCache = {
    set(key: string, value: any, ttl?: string | number): Promise<boolean>;
    setForever(key: string, value: any): Promise<boolean>;
    get<T = any>(key: string): Promise<T | undefined>;
    getOrSet<T = any>(key: string, factory: () => Promise<T> | T, ttl?: string | number): Promise<T>;
    getOrSetForever<T = any>(key: string, factory: () => Promise<T> | T): Promise<T>;
    has(key: string): Promise<boolean>;
    missing(key: string): Promise<boolean>;
    delete(key: string): Promise<boolean>;
    deleteMany(keys: string[]): Promise<boolean>;
    pull<T = any>(key: string): Promise<T | undefined>;
    expire(key: string, ttl: string | number): Promise<boolean>;
    clear(): Promise<void>;
    namespace(name: string): any;
};

export type RestOptions = {
    internal?: boolean;
    tenant_id?: string;
    useHook?: boolean;
    useCustomApi?: boolean;
    session?: ClientSession | null | undefined;
    database?: {
        uri: string;
        options?: MongoClientOptions;
    };
}