import type { AppError, fn } from "../lib/error";
import type { Field } from "./field";
import type { HooksCollection } from "./hook";
import type Joi from "joi";
import type { Cookies } from "hono/types";
import type { Context } from "hono";
import type { useRest } from "../database/rest";
import type { jwt } from "../utils/func";
import type { ActionsApiList, ApiAccess, ApiActions } from "./api";
export type Collection = {
    type?: "document" | "file";
    slug: string;
    studio?: {
        label?: string;
        info?: string;
    };
    hooks?: {
        beforeOperation?: HooksCollection['beforeOperation'];
        afterOperation?: HooksCollection['afterOperation'];
    },
    fields: Field[];
    api?: {
        access?: ApiAccess,
        auth?: {
            enabled: boolean;
            onLogin: (ctx: {
                rest: InstanceType<typeof useRest>;
                payload: any;
                error: typeof fn.error;
                jwt: typeof jwt;
                req: {
                    cookies: {
                        set: (name: string, value: string, options?: {
                            httpOnly?: boolean;
                            secure?: boolean;
                            maxAge?: number;
                            path?: string;
                            domain?: string;
                            sameSite?: 'lax' | 'strict' | 'none';
                        }) => any;
                        get: (name: string) => string | undefined;
                        delete: (name: string) => void;
                    }

                }
            }) => Promise<{
                token: string;
                data?: any;
            } | typeof fn.error>;
            onLogout?: (ctx: {
                rest: InstanceType<typeof useRest>;
                payload: any;
                error: typeof fn.error;
                jwt: typeof jwt;
                req: {
                    cookies: {
                        delete: (name: string) => void;
                    }
                }
            }) => Promise<void>;
        };
        privateFields?: (string | RegExp)[];
        readOnlyFields?: (string | RegExp)[];
    };
    actions?: {
        [key: string]: (ctx: {
            rest: InstanceType<typeof useRest>;
            data: any;
            error: typeof fn.error;
        }) => Promise<any>;
    };
    /**
     * The tenant id of the collection
     * @type {string}
     */
    _tenant_?: string;
    _isTimeSerie_?: boolean;
    _isCollection_?: boolean;
    _schema_?: Joi.Schema;
    _schemaPartial_?: Joi.Schema;

}
