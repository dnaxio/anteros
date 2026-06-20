export type ActivityInput = {
    internal: boolean;
    trace: {
        id: string;
        comment?: string;
        tag?: string;
        version?: string;
    };
    request?: {
        ip?: string;
        user_agent?: string;
        headers?: Record<string, string>;
        method?: string;
        path?: string;
        query?: Record<string, any>;
    };
    meta: {
        environment?: string;
        hostname?: string;
        core_version?: string;
        platform?: string;
    };
    operation: {
        tenant: string;
        action: string;
        collection: string;
        collectionType?: "document" | "file";
        status: "success" | "error";
        input: any;
        result: any;
        error: {
            message: string;
            code: string;
        } | null;
        duration: number;
        transaction: boolean;
        token?: {
            decoded: Record<string, unknown> | null;
            value: string | null;
            provided: boolean;
            expired: boolean;
        };
    };
    ts: Date;
}
