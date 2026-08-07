import type { AppError, fn } from "../lib/error";
import type { Field } from "./field";
import type { HooksCollection } from "./hook";
import type Joi from "joi";
import type { Cookies } from "hono/types";
import type { Context } from "hono";
import type { useRest } from "../database/rest";
import type { jwt } from "../utils/func";
import type { ActionsApiList, ApiAccess, ApiActions } from "./api";
import type { Server as SocketIO } from "socket.io";

/** Context passed to a collection custom action (`define.Action`). */
export type CollectionActionContext = {
    rest: InstanceType<typeof useRest>;
    data: any;
    error: typeof fn.error;
    io: SocketIO;
    jwt: typeof jwt;
    token: {
        value: string | null;
        decoded: Record<string, unknown> | null;
        provided: boolean;
        expired: boolean;
    };
};

/** A custom action on a collection — `define.Action(fn)`. */
export type CollectionAction = (ctx: CollectionActionContext) => Promise<any>;
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
            }) => Promise<{
                token: string;
                data?: any;
            } | typeof fn.error>;
            onLogout?: (ctx: {
                rest: InstanceType<typeof useRest>;
                payload: any;
                error: typeof fn.error;
                jwt: typeof jwt;
                cookies: {
                    delete: (name: string) => void;
                }
            }) => Promise<void>;
        };
        privateFields?: (string | RegExp)[];
        readOnlyFields?: (string | RegExp)[];
    };
    actions?: {
        [key: string]: CollectionAction;
    };
    /**
     * The tenant id of the collection
     * @type {string}
     */
    _tenant_?: string;
    _isTimeSerie_?: boolean;
    /** Drop MongoDB indexes for fields no longer in the schema (default: false) */
    purgeOrphanIndexes?: boolean;
    _isCollection_?: boolean;
    _schema_?: Joi.Schema;
    _schemaPartial_?: Joi.Schema;

}
