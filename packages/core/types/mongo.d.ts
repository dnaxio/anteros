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

export type LookupOptions = {
    from: string;
    localField: string;
    foreignField: string;
    as?: string;
    pipeline?: Array<any>;
    let?: Record<string, any>;
    unwind?: boolean;
}
