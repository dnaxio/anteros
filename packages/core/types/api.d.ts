export declare enum ApiActions {
    insertOne = "insertOne",
    insertMany = "insertMany",
    updateOne = "updateOne",
    updateMany = "updateMany",
    deleteOne = "deleteOne",
    deleteMany = "deleteMany",
    findOne = "findOne",
    find = "find",
    runAction = "runAction",
    runService = "runService",
    upload = "upload",
    auth = "auth",
    login = "login",
    aggregate = "aggregate",

}

export type ActionsApiList =
    | "insertOne"
    | "insertMany"
    | "updateOne"
    | "updateMany"
    | "deleteOne"
    | "deleteMany"
    | "findOne"
    | "find"
    | "runAction"
    | "runService"
    | "upload"
    | "auth"
    | "login"
    | "logout"
    | "aggregate"
    | "*"


export type ApiOptions = {
    cleanDeep?: boolean;
    useCache?: boolean;
};

export type ApiParams = {
    action: ApiActions;
    collection: string;
    tenant: string;
};


export type ApiAccess = {
    [key in ActionsApiList | (string & {})]?:
    | boolean
    | ((ctx: {
        rest: InstanceType<typeof useRest>;
        error: typeof fn.error;
        jwt: typeof jwt;
        /** `value`: raw JWT string; `decoded`: verified claims (or null if unauthenticated). */
        token: { value: string | null; decoded: Record<string, unknown> | null; provided: boolean; expired: boolean };
    }) => boolean);
};
export type ApiActions = {
    [key: string]:
    | boolean
    | ((ctx: {
        rest: InstanceType<typeof useRest>;
        error: typeof fn.error;
        jwt: typeof jwt;
    }) => boolean);
};

export type ApiResponse = {
    data: any;
    error: any;
};


export type updateApiOptions = {
    cleanDeep?: boolean;
    upsert?: boolean;
}

export type findApiOptions = {
    cleanDeep?: boolean;
}
