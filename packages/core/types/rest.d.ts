import type { UpdateOneModel, UpdateManyModel, ClientSession, MongoClientOptions } from "mongodb";

export type RestActions =
    'insertOne' | 'insertMany' | 'updateOne' | 'updateMany' | 'replaceOne' | 'deleteOne' | 'deleteMany'

export type BulkUpdateOperation = { updateOne: UpdateOneModel } | { updateMany: UpdateManyModel };

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