import type { UpdateOptions } from "mongodb"

export type updateOptions = UpdateOptions & {


}


export type FindOptions = {
    $match?: {
        _id?: string;
        [key: string]: any;
    };
    $skip?: number;
    $limit?: number;
    $include?: Array<string | LookupOptions>;
    $lookup?: Array<Record<string, any>>;
    $graphLookup?: Array<Record<string, any>>;
    $sort?: {
        [key: string]: 1 | -1;
    }
    $project?: Record<string, unknown>;


    $group?: {
        _id: string;
        [key: string]: any;
    };
    $sample?: {
        size: number;
    };
    $sortAfterInclude?: object;
    $projectAfterInclude?: object;
    $matchAfterInclude?: object;
    $unwind?: Array<string | {
        path: string;
        preserveNullAndEmptyArrays?: boolean;
        includeArrayIndex?: string;
    }>;
}

export type findOneByIdOptions = {
    $include?: Array<string | LookupOptions>;
    $matchAfterInclude?: object;
}

export type findOneOptions = {
    $include?: Array<string | LookupOptions>;
    /** Aligné sur `FindOptions.$project` pour les agrégations findOne (buildPipeline). */
    $project?: Record<string, unknown>;
}

/** Third parameter of `find`/`findOne` — query options */
export type FindCallOptions = {
    /** Serve from the DB query cache — cache-first, populated on miss, invalidated on any write */
    useCache?: boolean;
    /** TTL override for this query — human string ('5m', '2h') or ms (default: collection/server config, else '5m') */
    ttl?: string | number;
    /** Clean undefined/null/empty values from the result (SDK parity) */
    cleanDeep?: boolean;
}

export type LookupOptions = {
    from: string;
    localField: string;
    foreignField: string;
    as?: string;
    pipeline?: Array<any>;
    let?: Record<string, any>;
    unwind?: boolean;
}
