import type { Hono, Context } from "hono"
import { cfg, safePublicConfig } from "./config";
import type { ApiOptions } from "../types/api";
import { getCollection } from "../database/collection";
import { getFileCollection } from "../database/file";
import { getTenant } from "../database/tenant";
import { AppError, fn } from "../lib/error";
import * as cookie from "hono/cookie"
import { useRest } from "../database/rest";
import * as func from "../utils/func";
import type { HonoVariables } from "./env";
import { io } from "./io";
import type { Service } from "../types/service";
import { requestCtxStorage } from "../lib/asyncContextStorage";
import { getTenantMiddlewares } from "../lib/middleware";
import type { ActivityInput } from "../types/activity";
import * as os from 'node:os';
import { basename } from 'node:path';
import { handleUpload, handleServe, handleDelete, type FileResult } from "../lib/files";
import { getVarsDefinition } from "../database/vars";
import { endpoints, patterns } from "../lib/endpoints";
import { getAccessToken, errorResponse, evaluateAccess } from "./access";

// Every surface hangs off `/api/:tenant_id` — the patterns live in `lib/endpoints.ts`,
// next to the builders a client (and the SDK) uses, so a path is written once.
const API_PREFIX = patterns.collection;
const SERVICE_PREFIX = patterns.service;
const VARS_PREFIX = patterns.vars;
const UPLOAD_PREFIX = patterns.upload;
const FILES_PREFIX = patterns.file;


const ActionsValues = [
    'insertOne',
    'insertMany',
    'updateOne',
    'updateMany',
    'deleteOne',
    'deleteMany',
    'findOne',
    'find',
    'runService',
    'upload',
    'auth',
    'login',
    'logout',
    'aggregate',
] as const;

// ─── Helpers ───────────────────────────────────────────────────────────────

function stripReadOnlyData(col: any, body: any) {
    if (col?.api?.readOnlyFields?.length && body?.data) {
        body.data = func.omit(body.data, col.api.readOnlyFields);
    }
}

function stripReadOnlyUpdate(col: any, body: any) {
    if (col?.api?.readOnlyFields?.length && body?.update) {
        body.update = func.omit(body.update, col.api.readOnlyFields);
    }
}

/**
 * The collections a request pulls documents **into** its response — an `$include`
 * on `find`/`findOne`, a `$lookup` / `$graphLookup` anywhere in an `aggregate`
 * pipeline (`$facet` branches and nested lookups included).
 *
 * Returns the path each joined document lands at, paired with the target
 * collection's `api.privateFields`. `func.omit` only knows the *queried*
 * collection's matchers, so a joined document — which carries the *included*
 * collection's fields — has to be masked separately, at its own path.
 */
function embeddedPrivateFields(col: any, body: any): Array<{ path: string[]; keys: (string | RegExp)[] }> {
    const found: Array<{ path: string[]; keys: (string | RegExp)[] }> = [];

    const keysOf = (slug: string): (string | RegExp)[] =>
        (cfg.collections?.find((c) => c.slug === slug && c._tenant_ === col._tenant_)?.api?.privateFields) ?? [];

    const push = (slug: string, path?: string) => {
        if (!path) return;
        const keys = keysOf(slug);
        if (keys.length) found.push({ path: path.split('.'), keys });
    };

    // find / findOne — `$include`
    for (const inc of body?.params?.$include ?? []) {
        if (typeof inc === 'string') {
            const field = col.fields?.find((f: any) => f.name === inc);
            if (field?.relation?.to) push(field.relation.to, inc);
        } else if (inc?.from) {
            push(inc.from, inc.as || inc.localField);
        }
    }

    // aggregate — every `$lookup` / `$graphLookup`, nested ones included
    const walk = (stages: any, prefix: string) => {
        if (!Array.isArray(stages)) return;
        for (const stage of stages) {
            if (!stage || typeof stage !== 'object') continue;
            const lookup = stage.$lookup ?? stage.$graphLookup;
            if (lookup?.from && typeof lookup.as === 'string') {
                const path = prefix ? `${prefix}.${lookup.as}` : lookup.as;
                push(lookup.from, path);
                walk(lookup.pipeline, path);
            }
            if (stage.$facet && typeof stage.$facet === 'object') {
                for (const branch of Object.values(stage.$facet)) walk(branch, prefix);
            }
        }
    };
    walk(body?.pipeline, '');

    return found;
}

/**
 * Apply `func.omit` **at `path` only**, walking through arrays (a `$include` of a
 * `hasMany`). Each node on the way is shallow-copied, so a cached result is never
 * mutated in place.
 */
function omitAtPath(node: any, path: string[], keys: (string | RegExp)[]): any {
    if (node === null || node === undefined) return node;
    if (Array.isArray(node)) return node.map((item) => omitAtPath(item, path, keys));
    if (typeof node !== 'object') return node;

    const [head, ...rest] = path;
    if (!head || !(head in node)) return node;

    return { ...node, [head]: rest.length ? omitAtPath(node[head], rest, keys) : func.omit(node[head], keys) };
}

// ─── External-API guards (issues #31, #32, #33) ───────────────────────────
//
// The internal `rest` keeps its full surface (scripts and services may compute,
// replace, etc.); these checks only protect what a **client** sends to the HTTP
// API.

const RESERVED_UPLOAD_FIELDS = new Set(["_id", "_file", "createdAt", "updatedAt"]);

/** Framework-managed upload metadata cannot be named by the client (#31). */
function assertUploadMetadata(data: Record<string, any>): void {
    for (const key of Object.keys(data)) {
        if (RESERVED_UPLOAD_FIELDS.has(key) || key.startsWith("$")) {
            throw new AppError(`Metadata field '${key}' is reserved`, { status: 400, code: "UPLOAD_FIELD_RESERVED" });
        }
    }
}

/** A plain object (not an array, not null) — used to validate client bodies (#24). */
function requirePlainObject(value: unknown, label: string): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new AppError(`\`${label}\` must be an object`, { status: 400, code: "INVALID_BODY" });
    }
}

function requireStringArray(value: unknown, label: string): void {
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !id.trim())) {
        throw new AppError(`\`${label}\` must be an array of ids`, { status: 400, code: "INVALID_BODY" });
    }
}

/** A client `id`/`_id` must be a string — an operator object (`$ne`) would match anything (#47). */
function requireId(body: any): void {
    const id = body?.id ?? body?._id;
    if (typeof id !== "string" || !id.trim() || id.startsWith("$")) {
        throw new AppError("`id` must be a string", { status: 400, code: "INVALID_ID" });
    }
}

/** Safe cookie defaults (overridable) — the doc promises HttpOnly/SameSite; enforce them (#48). */
function cookieDefaults(options: any = {}): Record<string, any> {
    const base: Record<string, any> = { httpOnly: true, sameSite: "lax", path: "/" };
    if ((Bun.env.NODE_ENV ?? process.env.NODE_ENV) === "production") base.secure = true;
    return { ...base, ...(options ?? {}) };
}

/** Update operators a client may use (external API). `$rename` is deliberately absent (see #43). */
const CLIENT_UPDATE_OPERATORS = new Set([
    "$set", "$unset", "$inc", "$mul", "$min", "$max", "$currentDate",
    "$push", "$addToSet", "$pull", "$pullAll", "$pop",
]);

/**
 * External mutations must be an allow-listed operator document (#32):
 * MongoDB refuses replacement documents in `findAndModify` (500 today), and the
 * operators other than `$set` escaped Joi validation and `readOnlyFields`.
 */
function assertOperatorUpdate(update: unknown, col: any): void {
    if (!update || typeof update !== "object" || Array.isArray(update)) {
        throw new AppError("`update` must be a MongoDB update document", { status: 400, code: "INVALID_UPDATE" });
    }
    const operators = Object.keys(update);
    if (!operators.length || !operators.every((operator) => CLIENT_UPDATE_OPERATORS.has(operator))) {
        throw new AppError("`update` must only use supported MongoDB update operators", { status: 400, code: "INVALID_UPDATE" });
    }

    const readOnly = (col?.api?.readOnlyFields ?? []).map((field: string | RegExp) =>
        typeof field === "string" ? (name: string) => name === field : (name: string) => field.test(name),
    );
    const required = new Set((col?.fields ?? []).filter((field: any) => field.required).map((field: any) => field.name));

    for (const operator of operators) {
        const value = (update as Record<string, any>)[operator];
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        for (const target of Object.keys(value)) {
            if (readOnly.some((match) => match(target))) {
                throw new AppError(`Field '${target}' is read-only`, { status: 400, code: "READONLY_FIELD" });
            }
            if (operator === "$unset" && required.has(target)) {
                throw new AppError(`Field '${target}' is required`, { status: 400, code: "INVALID_UPDATE" });
            }
        }
    }
}

type PrivateMatcher = (name: string) => boolean;

/** `privateFields` (`string` | `RegExp`) as name matchers. */
function privateMatchers(col: any): PrivateMatcher[] {
    return (col?.api?.privateFields ?? []).map((field: string | RegExp) =>
        typeof field === "string"
            ? (name: string) => name === field
            : (name: string) => {
                field.lastIndex = 0; // a `g`/`y` regex would otherwise keep state between calls
                return field.test(name);
            },
    );
}

/** The join aliases a read may embed, with the private fields of their target. */
function collectJoinAliases(col: any, action: string, body: any): Array<{ alias: string; from: string; matchers: PrivateMatcher[] }> {
    const joins: Array<{ alias: string; from: string; matchers: PrivateMatcher[] }> = [];
    const targetMatchers = (slug: string) =>
        privateMatchers(cfg.collections?.find((c) => c.slug === slug && c._tenant_ === col._tenant_));

    if (action === "find" || action === "findOne") {
        for (const inc of body?.params?.$include ?? []) {
            if (typeof inc === "string") {
                const field = col.fields?.find((f: any) => f.name === inc);
                if (field?.relation?.to) joins.push({ alias: inc, from: field.relation.to, matchers: targetMatchers(field.relation.to) });
            } else if (inc?.from) {
                joins.push({ alias: inc.as || inc.localField, from: inc.from, matchers: targetMatchers(inc.from) });
            }
        }
    }

    const walk = (stages: any): void => {
        if (!Array.isArray(stages)) return;
        for (const stage of stages) {
            if (!stage || typeof stage !== "object") continue;
            const lookup = stage.$lookup ?? stage.$graphLookup;
            if (lookup?.from && typeof lookup.as === "string") {
                joins.push({ alias: lookup.as, from: lookup.from, matchers: targetMatchers(lookup.from) });
            }
            if (lookup?.pipeline) walk(lookup.pipeline);
            if (stage.$facet && typeof stage.$facet === "object") {
                for (const branch of Object.values(stage.$facet)) walk(branch);
            }
        }
    };
    walk(body?.pipeline);
    return joins;
}

/**
 * A client read may only join collections it could read itself (#36): the target's
 * `api.access` rule is evaluated for the same caller, exactly like a `find` on it.
 * Internal collections (`_audit_`, `_workflows_`, `_locks_`) are not declared and
 * are therefore refused. The in-process `rest` is untouched.
 */
async function assertJoinedCollectionsAllowed(
    col: any,
    action: string,
    body: any,
    c: any,
    rest: InstanceType<typeof useRest>,
    tenant_id: string,
): Promise<void> {
    const seen = new Set<string>();
    for (const join of collectJoinAliases(col, action, body)) {
        if (!join.from || seen.has(join.from)) continue;
        seen.add(join.from);

        const target = cfg.collections?.find((candidate) => candidate.slug === join.from && candidate._tenant_ === col._tenant_);
        if (target) {
            await evaluateAccess(target.api?.access as any, 'find', rest, `lookup:${join.from}`, c, {
                collection: join.from,
                tenant: tenant_id,
                lookup: true,
            });
            continue;
        }

        const fileTarget = cfg.fileCollections?.find((candidate) => candidate.slug === join.from && candidate._tenant_ === col._tenant_);
        if (fileTarget) {
            await evaluateAccess(fileTarget.api?.access as any, 'read', rest, `lookup:${join.from}`, c, {
                collection: join.from,
                tenant: tenant_id,
                lookup: true,
            });
            continue;
        }

        throw new AppError(`Joining '${join.from}' is not allowed`, { status: 403, code: "LOOKUP_TARGET_FORBIDDEN" });
    }
}

/** Expression operators that can move a field value under another name without a `$path`. */
const PRIVATE_MOVING_OPERATORS = new Set(["$getField", "$objectToArray", "$arrayToObject"]);

/**
 * A client read may not reach a private field **under another name** (#33):
 * masking is by key name, so `$addFields: { leak: "$password" }` would slip
 * through. A reference to a private field — own or through a join alias — is
 * refused, as are the operators that can move a field without an explicit path.
 * Internal `rest` calls are untouched.
 */
function assertNoPrivateFieldAliasing(col: any, action: string, body: any): void {
    const own = privateMatchers(col);
    const joins = collectJoinAliases(col, action, body);
    const guarded = own.length > 0 || joins.some((join) => join.matchers.length > 0);
    if (!guarded) return;

    const fail = () => {
        throw new AppError("The request references a private field", { status: 400, code: "PRIVATE_FIELD_REFERENCE" });
    };

    const isPrivatePath = (path: string): boolean => {
        const segments = path.split(".");
        const head = segments[0] ?? "";
        if (own.some((match) => match(head))) return true;
        const join = joins.find((candidate) => candidate.alias === head);
        return !!join && segments.length > 1 && join.matchers.some((match) => match(segments[1]!));
    };

    const walk = (node: any): void => {
        if (typeof node === "string") {
            if (node.startsWith("$") && !node.startsWith("$$")) {
                if (isPrivatePath(node.slice(1))) fail();
            } else if (node.startsWith("$$ROOT.") && isPrivatePath(node.slice(7))) {
                fail();
            } else if (node.startsWith("$$CURRENT.") && isPrivatePath(node.slice(10))) {
                fail();
            }
            return;
        }
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
            for (const value of node) walk(value);
            return;
        }
        for (const [key, value] of Object.entries(node)) {
            if (PRIVATE_MOVING_OPERATORS.has(key)) fail();
            walk(value);
        }
    };

    walk(action === "aggregate" ? body?.pipeline : body?.params);
}

// ─── Access control ─────────────────────────────────────────────────────────
// `evaluateAccess` / `errorResponse` / `getAccessToken` live in `./access`
// (shared with the agents API).

async function checkFileAccess(
    access: { [key: string]: boolean | ((ctx: any) => boolean | Promise<boolean>) | undefined } | undefined,
    operation: string,
    tenant_id: string,
    c: any,
): Promise<void> {
    // No access config at all → deny (secure by default)
    if (!access) {
        throw new AppError('Access denied', { status: 401, code: 'ACCESS_DENIED' });
    }

    const hasWildcard = access['*'] !== undefined;
    const hasSpecific = access[operation] !== undefined;

    if (!hasWildcard && !hasSpecific) {
        throw new AppError('Access denied', { status: 401, code: 'ACCESS_DENIED' });
    }

    const rule = hasSpecific ? access[operation] : access['*'];
    if (rule === undefined) {
        throw new AppError('Access denied', { status: 401, code: 'ACCESS_DENIED' });
    }

    // Boolean `true` → allow without requiring a token
    if (typeof rule === 'boolean') {
        if (!rule) {
            throw new AppError(`${operation} not allowed`, { status: 401, code: 'ACCESS_DENIED' });
        }
        return;
    }

    // Function → requires a valid token
    const accessToken = getAccessToken(c);

    if (accessToken.expired) {
        throw new AppError('Token expired', { status: 401, code: 'TOKEN_EXPIRED' });
    }
    if (!accessToken.value) {
        throw new AppError('Authentication required', { status: 401, code: 'AUTH_REQUIRED' });
    }

    const rest = new useRest({ internal: false, tenant_id });
    const allowed = await (rule as Function)({ rest, error: fn.error, jwt: func.jwt, token: accessToken });
    if (!allowed) {
        throw new AppError(`${operation} not allowed`, { status: 401, code: 'ACCESS_DENIED' });
    }
}

// ─── CRUD dispatch table ───────────────────────────────────────────────────

type CrudHandler = (rest: InstanceType<typeof useRest>, collection: string, body: any) => Promise<any>;

const crudHandlers: Record<string, CrudHandler> = {
    aggregate:       (rest, collection, body) => rest.aggregate(collection, body?.pipeline || []),
    find:            (rest, collection, body) => rest.find(collection, body?.params || {}, { useCache: body?.options?.useCache }),
    findOne:         (rest, collection, body) => rest.findOne(collection, body?.id, body?.params || {}),
    insertOne:       (rest, collection, body) => rest.insertOne(collection, body?.data),
    insertMany:      (rest, collection, body) => rest.insertMany(collection, body?.data),
    updateOne:       (rest, collection, body) => rest.updateOne(collection, body?.id || body?._id, body?.update || {}),
    updateMany:      (rest, collection, body) => rest.updateMany(collection, body?.ids || body?._ids || [], body?.update || {}),
    deleteOne:       (rest, collection, body) => rest.deleteOne(collection, body?.id || body?._id),
    deleteMany:      (rest, collection, body) => rest.deleteMany(collection, body?.ids || body?._ids || []),
};

function initializeApi(app: Hono<{ Variables: HonoVariables }>) {

    // tenant middlewares (scoped to their tenant only)
    const tenantMiddlewares = getTenantMiddlewares();
    for (const mw of tenantMiddlewares) {
        app.use(async (c, next) => {
            const url = new URL(c.req.url);
            const segments = url.pathname.split('/').filter(Boolean);
            const tenantInUrl = segments[1];
            if (mw._tenant_ === tenantInUrl) {
                return mw.handler(c, next);
            }
            return next();
        });
    }

    async function logActivity({
        rest, tenant_id, action, collection, collectionType,
        status, input, result, error, duration, token, transaction = false
    }: {
        rest: InstanceType<typeof useRest>;
        tenant_id: string;
        action: string;
        collection: string;
        collectionType?: 'document' | 'file';
        status: 'success' | 'error';
        input?: any;
        result?: any;
        error?: { message: string; code: string } | null;
        duration: number;
        transaction?: boolean;
        token?: { decoded: any; value: any; provided: boolean; expired: boolean };
    }) {
        const logTraceId = requestCtxStorage.get<{ id: string }>('trace')?.id ?? crypto.randomUUID();
        const ctxMeta = requestCtxStorage.get<Record<string, any>>('meta');
        const { request: logRequest, ...logMeta } = ctxMeta ?? {};

        await rest.audit.addActivities([{
            internal: false,
            trace: { id: logTraceId },
            request: logRequest,
            meta: { ...logMeta, platform: logMeta?.platform ?? os.platform(), core_version: cfg.version ?? logMeta?.core_version },
            operation: {
                tenant: tenant_id,
                action,
                collection,
                collectionType: collectionType || undefined,
                status,
                input: input ?? null,
                result: result ?? null,
                error: error ?? null,
                duration,
                transaction,
                ...(token && { token }),
            },
            ts: new Date(),
        }]);
    }

    // ─── Collection API ─────────────────────────────────────────────────
    app.post(API_PREFIX, async (c: Context<{ Variables: HonoVariables }>) => {
        let response: any;
        let body: any;
        let rest: InstanceType<typeof useRest>;

        try {
            const ContentType = c.req.header('Content-Type');
            const { action, collection, tenant_id } = c.req.param() as { action: typeof ActionsValues[number], collection: string, tenant_id: string };

            // Validate params
            if (!tenant_id) throw new AppError('Tenant ID is required', { status: 400, code: 'TENANT_ID_REQUIRED' });
            if (!collection) throw new AppError('Collection is required', { status: 400, code: 'COLLECTION_REQUIRED' });
            if (!action) throw new AppError('Action is required', { status: 400, code: 'ACTION_REQUIRED' });

            // Parse body
            if (ContentType?.includes('application/json')) {
                try { body = await c.req.json(); } catch {
                    throw new AppError('Invalid JSON body', { status: 400, code: 'INVALID_JSON_BODY' });
                }
            } else if (ContentType?.includes('multipart/form-data') || ContentType?.includes('application/x-www-form-urlencoded')) {
                try { body = await c.req.parseBody({ all: true }); } catch {
                    throw new AppError('Invalid form data', { status: 400, code: 'INVALID_FORM_DATA' });
                }
            }

            if (!cfg.tenants.find(t => t.id === tenant_id)) {
                throw new AppError('Resource not found', { status: 400, code: 'TENANT_NOT_FOUND' });
            }

            // Store tenant in request context so nested useRest() calls (hooks, actions) resolve it
            requestCtxStorage.set('tenant_id', tenant_id);

            const col = getCollection(collection, tenant_id)
            if (!col) {
                throw new AppError('Resource not found', { status: 400, code: 'COLLECTION_NOT_FOUND' });
            }

            if (!ActionsValues.includes(action as (typeof ActionsValues)[number]) && !Object.hasOwn(col?.actions ?? {}, action)) {
                throw new AppError('Resource not found', { status: 400, code: 'ACTION_NOT_FOUND' });
            }

            const fieldOrder = ['_id', ...col.fields.map(f => f.name)];
            const privateFields = col.api?.privateFields || [];
            const accessToken = getAccessToken(c);

            rest = new useRest({ internal: false, tenant_id, useHook: true });

            // ── Logout ──
            if (action === 'logout') {
                const logStart = Date.now();
                try {
                    if (!col?.api?.auth?.enabled) throw new AppError('Auth is not enabled', { status: 400, code: 'AUTH_NOT_ENABLED' });
                    if (!col?.api?.auth?.onLogout) throw new AppError('Auth onLogout is not defined', { status: 400, code: 'AUTH_HANDLER_NOT_DEFINED' });

                    await col.api.auth.onLogout({
                        rest, payload: body?.payload, error: fn.error, jwt: func.jwt,
                        cookies: { delete: (name: string, opts?: any) => cookie.deleteCookie(c, name, cookieDefaults(opts)) },
                    });

                    await logActivity({ rest, tenant_id, action: 'logout', collection, status: 'success', input: { payload: body?.payload }, duration: Date.now() - logStart });
                    return c.json({ message: 'Logout successful', ok: true });
                } catch (err: any) {
                    await logActivity({ rest, tenant_id, action: 'logout', collection, status: 'error', input: { payload: body?.payload }, error: { message: err?.message, code: err?.code || 'INTERNAL_API_ERROR' }, duration: Date.now() - logStart }).catch(() => {});
                    throw err;
                }
            }

            // ── Login ──
            if (action === 'login') {
                const logStart = Date.now();
                try {
                    if (!col?.api?.auth?.enabled) throw new AppError('Auth is not enabled', { status: 400, code: 'AUTH_NOT_ENABLED' });
                    if (!col?.api?.auth?.onLogin) throw new AppError('Auth onLogin is not defined', { status: 400, code: 'AUTH_HANDLER_NOT_DEFINED' });

                    // Tenant-bound tokens (#35): the claim is signed by the framework, so a
                    // token can never open another tenant's routes.
                    const loginJwt = {
                        ...func.jwt,
                        sign: (payload: Record<string, unknown>, options?: any) =>
                            func.jwt.sign({ ...payload, tenant: tenant_id }, options),
                    };
                    const authResult = await col.api.auth.onLogin({
                        rest, payload: body?.payload, error: fn.error, jwt: loginJwt,
                        cookies: {
                            set: (name: string, value: string, opts?: any) => cookie.setCookie(c, name, value, cookieDefaults(opts)),
                            get: (name: string) => cookie.getCookie(c, name),
                            delete: (name: string, opts?: any) => cookie.deleteCookie(c, name, cookieDefaults(opts)),
                        },
                    });

                    if (!authResult || typeof authResult === 'function' || !('token' in authResult)) {
                        throw new AppError('Invalid login response', { status: 401, code: 'INVALID_LOGIN' });
                    }
                    if (!authResult.token) {
                        throw new AppError('Invalid token assigned', { status: 401, code: 'INVALID_TOKEN_ASSIGNED' });
                    }

                    const { value, error } = await func.jwt.verify(authResult.token);
                    if (error) throw new AppError('Invalid token', { status: 401, code: 'INVALID_TOKEN' });

                    await logActivity({ rest, tenant_id, action: 'login', collection, status: 'success', input: { payload: body?.payload }, result: { message: 'Login successful' }, duration: Date.now() - logStart, token: { decoded: value, value: null, provided: true, expired: false } });
                    return c.json({ token: authResult.token, data: authResult.data });
                } catch (err: any) {
                    await logActivity({ rest, tenant_id, action: 'login', collection, status: 'error', input: { payload: body?.payload }, error: { message: err?.message, code: err?.code || 'INTERNAL_API_ERROR' }, duration: Date.now() - logStart }).catch(() => {});
                    throw err;
                }
            }

            // ── Access control ──
            // Flaw 7: single implementation via evaluateAccess (checks expired/forged tokens)
            await evaluateAccess(col?.api?.access as any, action, rest, 'Action', c, { collection, tenant: tenant_id, body });

            // ── External-API guards (issues #31–#33) ──
            if (action === 'updateOne' || action === 'updateMany') {
                assertOperatorUpdate(body?.update, col);
            } else if (action === 'find' || action === 'findOne' || action === 'aggregate') {
                assertNoPrivateFieldAliasing(col, action, body);
                await assertJoinedCollectionsAllowed(col, action, body, c, rest, tenant_id);
            }

            // ── Execute action ──
            if (col.actions?.[action]) {
                // Delegated to `rest.runAction` so the invocation is audited once,
                // with the same context (`rest`, `io`, `data`, `token`, …)
                response = await rest.runAction(collection, action, body?.data);
            } else {
                const handler = crudHandlers[action];
                if (!handler) throw new AppError('Action `' + action + '` not found', { status: 400, code: 'ACTION_NOT_FOUND' });

                // Client body shape + id guards (#24, #47) — custom actions are untouched
                if (action === 'insertOne') {
                    requirePlainObject(body?.data, 'data');
                } else if (action === 'insertMany') {
                    if (!Array.isArray(body?.data)) {
                        throw new AppError("`data` must be an array", { status: 400, code: "INVALID_BODY" });
                    }
                } else if (action === 'updateOne' || action === 'deleteOne' || action === 'findOne') {
                    requireId(body);
                } else if (action === 'updateMany' || action === 'deleteMany') {
                    requireStringArray(body?.ids ?? body?._ids, 'ids');
                }

                // Strip readOnlyFields for mutations
                if (action === 'insertOne' || action === 'insertMany') {
                    stripReadOnlyData(col, body);
                } else if (action === 'updateOne' || action === 'updateMany') {
                    stripReadOnlyUpdate(col, body);
                }

                response = await handler(rest, collection, body);
            }

            // Strip private fields from response — the queried collection's own,
            // then each collection it embeds via `$include` / `$lookup`
            if (privateFields.length > 0) {
                response = func.omit(response!, privateFields, fieldOrder);
            }
            for (const { path, keys } of embeddedPrivateFields(col, body)) {
                response = omitAtPath(response, path, keys);
            }

            return c.json(response);

        } catch (err: any) {
            if (cfg?.debug) console.error(err)
            return errorResponse(c, err);
        }
    });

    // ─── Vars API ───────────────────────────────────────────────────────
    app.post(VARS_PREFIX, async (c) => {
        let rest: InstanceType<typeof useRest> | undefined;
        let tenant_id = '';
        let action = '';
        let ns = '';
        let body: any;
        const logStart = Date.now();
        try {
            const ContentType = c.req.header('Content-Type');
            if (ContentType?.includes('application/json')) {
                try { body = await c.req.json(); } catch {
                    throw new AppError('Invalid JSON body', { status: 400, code: 'INVALID_JSON_BODY' });
                }
            } else {
                body = {};
            }

            const params = c.req.param() as { tenant_id: string; action: string };
            tenant_id = params.tenant_id;
            action = params.action;
            ns = body?.ns;

            if (!tenant_id) throw new AppError('Tenant ID is required', { status: 400, code: 'TENANT_ID_REQUIRED' });
            if (!action) throw new AppError('Action is required', { status: 400, code: 'ACTION_REQUIRED' });
            if (!ns) throw new AppError('Variables namespace is required', { status: 400, code: 'NAMESPACE_REQUIRED' });
            if (!getTenant(tenant_id)) throw new AppError('Tenant not found', { status: 400, code: 'TENANT_NOT_FOUND' });

            requestCtxStorage.set('tenant_id', tenant_id);

            // Only namespaces declared with `define.Vars` are reachable, and their
            // `api.access` gates every action (no rules = denied).
            const definition = getVarsDefinition(tenant_id, ns);
            if (!definition) throw new AppError('Resource not found', { status: 400, code: 'NAMESPACE_NOT_FOUND' });

            rest = new useRest({ internal: false, tenant_id });
            await evaluateAccess(definition.api?.access as any, action, rest, `vars:${ns}`, c, { namespace: ns, body, tenant: tenant_id });

            const vars = rest.vars;
            const { key, value, meta, ttl, scope, where, entries, by } = body ?? {};
            let response: any;

            switch (action) {
                case 'set': await vars.set(ns, key, value, { meta, ttl, scope }); response = { ok: true }; break;
                case 'setMany': await vars.setMany(ns, entries ?? {}, { meta, ttl, scope }); response = { ok: true }; break;
                case 'get': response = { value: await vars.get(ns, key, { scope }) }; break;
                case 'entry': response = { entry: await vars.entry(ns, key, { scope }) }; break;
                case 'entries': response = { entries: await vars.entries(ns, { scope, where }) }; break;
                case 'all': response = { vars: await vars.all(ns, { scope, where }) }; break;
                case 'del': response = { ok: await vars.del(ns, key, { scope }) }; break;
                case 'has': response = { exists: await vars.has(ns, key, { scope }) }; break;
                case 'incr': response = { value: await vars.incr(ns, key, by, { scope, ttl }) }; break;
                case 'expire': response = { ok: await vars.expire(ns, key, ttl, { scope }) }; break;
                case 'clear': response = { deleted: await vars.clear(ns, { scope }) }; break;
                default: throw new AppError(`Action '${action}' not found`, { status: 400, code: 'ACTION_NOT_FOUND' });
            }

            // Audit — never store `value` / `meta` (they may hold secrets).
            const accessToken = getAccessToken(c);
            await logActivity({
                rest,
                tenant_id,
                action,
                collection: `_vars_:${ns}`,
                status: 'success',
                input: { ns, key, scope, ttl },
                duration: Date.now() - logStart,
                token: { decoded: accessToken.decoded, value: null, provided: true, expired: false },
            });
            return c.json(response);
        } catch (err: any) {
            if (cfg?.debug) console.error(err);
            if (rest && tenant_id && ns) {
                const accessToken = getAccessToken(c);
                await logActivity({
                    rest,
                    tenant_id,
                    action,
                    collection: `_vars_:${ns}`,
                    status: 'error',
                    input: { ns },
                    error: { message: err?.message, code: err?.code || 'INTERNAL_VARS_ERROR' },
                    duration: Date.now() - logStart,
                    token: { decoded: accessToken.decoded, value: null, provided: true, expired: false },
                }).catch(() => {});
            }
            return errorResponse(c, err);
        }
    });

    // ─── Service API ────────────────────────────────────────────────────
    app.post(SERVICE_PREFIX, async (c) => {
        try {
            const ContentType = c.req.header('Content-Type');
            let body: any;

            if (ContentType?.includes('application/json')) {
                try { body = await c.req.json(); } catch {
                    throw new AppError('Invalid JSON body', { status: 400, code: 'INVALID_JSON_BODY' });
                }
            } else if (ContentType?.includes('multipart/form-data') || ContentType?.includes('application/x-www-form-urlencoded')) {
                try { body = await c.req.parseBody({ all: true }); } catch {
                    throw new AppError('Invalid form data', { status: 400, code: 'INVALID_FORM_DATA' });
                }
            }

            const { service, tenant_id } = c.req.param() as { service: string, tenant_id: string };
            if (!tenant_id) throw new AppError('Tenant ID is required', { status: 400, code: 'TENANT_ID_REQUIRED' });
            if (!service) throw new AppError('Service is required', { status: 400, code: 'SERVICE_REQUIRED' });
            requestCtxStorage.set('tenant_id', tenant_id);

            const serviceInstance = cfg.services?.find(s => s.name === service && s._tenant_ === tenant_id) as Service;
            const { action } = c.req.param() as { action: string };
            if (!serviceInstance) throw new AppError('Resource not found', { status: 400, code: 'SERVICE_NOT_FOUND' });
            if (!serviceInstance.enabled) throw new AppError('Service `' + service + '` is not enabled', { status: 400, code: 'SERVICE_NOT_ENABLED' });
            if (!serviceInstance.actions?.[action]) throw new AppError('Service `' + service + '` is not defined', { status: 400, code: 'SERVICE_NOT_DEFINED' });

            const rest = new useRest({ internal: false, tenant_id });

            // Access control (same logic as checkFileAccess)
            const serviceAccess = serviceInstance.api?.access as Record<string, boolean | Function> | undefined;
            await evaluateAccess(serviceAccess as any, action, rest, action, c, { service, tenant: tenant_id, body });

            // No `logActivity` here: the call is delegated to `rest.runService()`, which
            // audits it once (`action: 'runService'`, `internal: false`, params only)
            const response = await rest.runService(service, action, body?.data);
            return c.json(response);
        } catch (err: any) {
            if (cfg?.debug) console.error(err)
            return errorResponse(c, err);
        }
    });

    // ─── File Upload ────────────────────────────────────────────────────
    app.post(UPLOAD_PREFIX, async (c) => {
        try {
            const { tenant_id, collection } = c.req.param() as { tenant_id: string; collection: string };

            if (!cfg.tenants.find(t => t.id === tenant_id)) {
                throw new AppError('Tenant `' + tenant_id + '` not found', { status: 400, code: 'TENANT_NOT_FOUND' });
            }
            requestCtxStorage.set('tenant_id', tenant_id);

            const colUpload = getFileCollection(collection, tenant_id);
            if (!colUpload) {
                throw new AppError('Resource not found', { status: 400, code: 'FILE_COLLECTION_NOT_FOUND' });
            }
            await checkFileAccess(colUpload?.api?.access as any, 'upload', tenant_id, c);

            const contentType = c.req.header('Content-Type') || '';
            if (!contentType.includes('multipart/form-data')) {
                throw new AppError('Content-Type must be multipart/form-data', { code: 'INVALID_CONTENT_TYPE', status: 400 });
            }

            // Security: reject oversized bodies BEFORE parseBody buffers them in memory.
            // `upload.maxSize` is the per-file cap AND the upload request allowance →
            // a multi-file upload must fit within it (each file is validated in handleUpload).
            const contentLength = Number(c.req.header('Content-Length') ?? 0);
            const maxRequestSize = colUpload.upload?.maxSize ?? 100 * 1024 * 1024; // 100MB upload default
            // multipart overhead (boundaries/headers) ≈ 64KB max
            if (Number.isFinite(contentLength) && contentLength > 0 && contentLength > maxRequestSize + 64 * 1024) {
                throw new AppError(`Request too large (max ${Math.round(maxRequestSize / 1024 / 1024)}MB)`, {
                    code: 'FILE_TOO_LARGE', status: 413,
                });
            }

            const formData = await c.req.parseBody({ all: true }); // repeated fields → arrays; a single occurrence stays a single value

            // Collect files from both accepted field names (single or multiple)
            const files: File[] = [];
            for (const key of ['file', 'upload']) {
                const raw = formData[key];
                const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
                for (const value of values) {
                    if (value instanceof File) files.push(value);
                }
            }
            if (!files.length) {
                throw new AppError('No file provided. Use field name "file" or "upload".', { code: 'FILE_REQUIRED', status: 400 });
            }

            // Metadata: non-file fields. Single value → scalar (unchanged contract),
            // repeated under the same name → array.
            const data: Record<string, any> = {};
            for (const [key, value] of Object.entries(formData)) {
                if (key === 'file' || key === 'upload') continue;
                const list = (Array.isArray(value) ? value : [value]) as any[];
                if (list.some((v) => v instanceof File)) continue;
                data[key] = list.length === 1 ? list[0] : list;
            }

            // Framework-managed fields are not client metadata (#31)
            assertUploadMetadata(data);

            // Only declared fields, and never a read-only one (#46)
            const declared = new Set((colUpload.fields ?? []).map((field: any) => field.name));
            const readOnlyMatchers = ((colUpload.api?.readOnlyFields ?? []) as (string | RegExp)[]).map((field) =>
                typeof field === "string" ? (name: string) => name === field : (name: string) => field.test(name),
            );
            for (const key of Object.keys(data)) {
                if (!declared.has(key)) {
                    throw new AppError(`Unknown metadata field '${key}'`, { status: 400, code: "UPLOAD_FIELD_UNKNOWN" });
                }
                if (readOnlyMatchers.some((match) => match(key))) {
                    throw new AppError(`Field '${key}' is read-only`, { status: 400, code: "READONLY_FIELD" });
                }
            }

            // One document per file (per-file validation: MIME, size, storage, replication).
            // 1 file → single object (backward compatible), N files → array (SDK contract).
            const results: FileResult[] = [];
            for (const file of files) {
                results.push(await handleUpload({ collection, tenant_id, file, data }));
            }
            return c.json(results.length === 1 ? results[0] : results);
        } catch (err: any) {
            if (cfg?.debug) console.error(err)
            return errorResponse(c, err);
        }
    });

    // ─── File Serve ─────────────────────────────────────────────────────
    app.get(FILES_PREFIX, async (c) => {
        try {
            const { tenant_id, collection } = c.req.param() as { tenant_id: string; collection: string };

            if (!cfg.tenants.find(t => t.id === tenant_id)) {
                throw new AppError('Tenant `' + tenant_id + '` not found', { status: 400, code: 'TENANT_NOT_FOUND' });
            }
            requestCtxStorage.set('tenant_id', tenant_id);

            const colServe = getFileCollection(collection, tenant_id);
            if (!colServe) {
                throw new AppError('File collection `' + collection + '` not found', { status: 400, code: 'FILE_COLLECTION_NOT_FOUND' });
            }
            await checkFileAccess(colServe?.api?.access as any, 'read', tenant_id, c);

            // Flaw 18: validate the RAW path before basename (checks were dead code)
            const rawFile = c.req.param('file') as string;
            if (!rawFile || rawFile.startsWith('.') || rawFile.includes('..') || rawFile.includes('/') || rawFile.includes('\\')) {
                throw new AppError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' });
            }
            const filename = basename(rawFile);
            const fileId = filename.replace(/\.[^.]+$/, '');

            const query = c.req.query();
            const transform = query.w || query.width || query.h || query.height || query.format
                ? {
                    width: query.w ? Number(query.w) : query.width ? Number(query.width) : undefined,
                    height: query.h ? Number(query.h) : query.height ? Number(query.height) : undefined,
                    format: (query.format as 'webp' | 'jpeg' | 'png' | 'avif') || undefined,
                    quality: query.q ? Number(query.q) : query.quality ? Number(query.quality) : undefined,
                }
                : undefined;

            const result = await handleServe(tenant_id, collection, fileId, filename, transform);
            if (!result) {
                throw new AppError('File not found', { code: 'FILE_NOT_FOUND', status: 404 });
            }

            c.header('Content-Type', result.mimetype);
            if (result.size) c.header('Content-Length', String(result.size));
            // Public immutable caching only when the read rule is literally public (#49);
            // a function rule (token-dependent) must never be cached by a shared proxy.
            const fileAccess = colServe.api?.access as Record<string, any> | undefined;
            const readRule = fileAccess?.read ?? fileAccess?.['*'];
            if (readRule === true) {
                c.header('Cache-Control', 'public, max-age=31536000, immutable');
            } else {
                c.header('Cache-Control', 'private, no-store');
                c.header('Vary', 'Authorization, Cookie');
            }
            // Flaw 4: SVG served as attachment (no inline execution)
            if (result.attachment) {
                c.header('Content-Disposition', `attachment; filename="${filename}"`);
            }
            return c.newResponse(result.stream);
        } catch (err: any) {
            if (cfg?.debug) console.error(err)
            return errorResponse(c, err);
        }
    });

    // ─── File Delete ────────────────────────────────────────────────────
    app.delete(FILES_PREFIX, async (c) => {
        try {
            const { tenant_id, collection } = c.req.param() as { tenant_id: string; collection: string };

            if (!cfg.tenants.find(t => t.id === tenant_id)) {
                throw new AppError('Tenant `' + tenant_id + '` not found', { status: 400, code: 'TENANT_NOT_FOUND' });
            }
            requestCtxStorage.set('tenant_id', tenant_id);

            const colDelete = getFileCollection(collection, tenant_id);
            if (!colDelete) {
                throw new AppError('File collection `' + collection + '` not found', { status: 400, code: 'FILE_COLLECTION_NOT_FOUND' });
            }
            await checkFileAccess(colDelete?.api?.access as any, 'delete', tenant_id, c);

            const fileId = c.req.param('file') as string;
            if (!fileId || fileId.startsWith('.') || fileId.includes('..') || fileId.includes('/')) {
                throw new AppError('Invalid file id', { status: 400, code: 'INVALID_FILE_ID' });
            }

            await handleDelete(tenant_id, collection, fileId);
            return c.json({ message: 'File deleted', ok: true });
        } catch (err: any) {
            if (cfg?.debug) console.error(err)
            return errorResponse(c, err);
        }
    });

    // ─── Public config ──────────────────────────────────────────────────
    app.get('/_dnax/config/:tenant_id', (c) => {
        const t = c.get('token');
        // Flaw 6: require a VERIFIED, non-expired token (not just any provided value)
        if (!t?.decoded || t?.expired || !t?.provided) {
            return c.json({ message: 'Authentication required', code: 'AUTH_REQUIRED' }, 401);
        }
        const { tenant_id } = c.req.param() as { tenant_id: string };
        const config = safePublicConfig();

        return c.json({
            tenants: config?.tenants?.filter(t => t.id === tenant_id),
            collections: config?.collections?.filter(c => c._tenant_ === tenant_id),
            services: config?.services?.filter(s => s._tenant_ === tenant_id),
            fileCollections: config?.fileCollections?.filter(fc => fc._tenant_ === tenant_id),
        });
    });

}

export {
    initializeApi
}
