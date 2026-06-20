import type { Db, MongoClient, MongoClientOptions } from "mongodb";
export type Tenant = {
    id: string;
    name?: string;
    description?: string;
    dir: string;
    routes?: {
        prefix?: string;
    },
    database: {
        uri: string;
        options?: MongoClientOptions;
        db?: Db;
        client?: MongoClient;
    }
}
