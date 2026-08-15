import type { Hono, Context } from "hono"
import { cfg, safePublicConfig } from "./config";
import type { ApiOptions } from "../types/api";
import { getCollection } from "../database/collection";
import { getFileCollection } from "../database/file";
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
import { handleUpload, handleServe, handleDelete } from "../lib/files";
const API_PREFIX = '/api/:tenant_id/:collection/:action';
const SERVICE_PREFIX = '/services/:tenant_id/:service/:action';
const UPLOAD_PREFIX = '/upload/:tenant_id/:collection';
const FILES_PREFIX = '/files/:tenant_id/:collection/:file';


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

function getAccessToken(c: any) {
    const t = c.get('token');
    return {
        value: (t?.value ?? null) as string | null,
        decoded: (t?.decoded ?? null) as Record<string, unknown> | null,
        provided: (t?.provided ?? false) as boolean,
        expired: (t?.expired ?? false) as boolean,
    };
}

function errorResponse(c: any, err: any) {
    const isAppError = err instanceof AppError;
    const status = isAppError ? Number(err.status) : 500;
    return c.json({
        message: isAppError ? err.message : 'Internal server error',
        code: isAppError ? err.code : 'INTERNAL_SERVER_ERROR',
        meta: isAppError ? err.meta : undefined,
    }, status);
}

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

// ─── Access control helpers ──────────────────────────────────────────────────

async function evaluateAccess(
    access: { [key: string]: boolean | ((ctx: any) => boolean | Promise<boolean>) | undefined } | undefined,
    operation: string,
    rest: InstanceType<typeof useRest>,
    label: string,
    c: any,
): Promise<void> {
    if (!access) {
        throw new AppError('Access denied', { status: 401, code: 'ACCESS_DENIED' });
    }

    const hasWildcard = access['*'] !== undefined;
    const hasSpecific = access[operation] !== undefined;

    if (!hasWildcard && !hasSpecific) {
        throw new AppError('Access denied', { status: 401, code: 'ACCESS_DENIED' });
    }

    const rule = hasSpecific ? access[operation] : access['*'];
    if (rule === undefined) return;

    // Boolean `true` → allow without requiring a token
    if (typeof rule === 'boolean') {
        if (!rule) {
            throw new AppError(`${label} not allowed`, { status: 401, code: 'ACCESS_DENIED' });
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

    const allowed = await (rule as Function)({ rest, error: fn.error, jwt: func.jwt, token: accessToken });
    if (!allowed) {
        throw new AppError(`${label} not allowed`, { status: 401, code: 'ACCESS_DENIED' });
    }
}

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
                throw new AppError('Tenant `' + tenant_id + '` not found', { status: 400, code: 'TENANT_NOT_FOUND' });
            }

            // Store tenant in request context so nested useRest() calls (hooks, actions) resolve it
            requestCtxStorage.set('tenant_id', tenant_id);

            const col = getCollection(collection, tenant_id)
            if (!col) {
                throw new AppError('Collection `' + collection + '` not found', { status: 400, code: 'COLLECTION_NOT_FOUND' });
            }

            if (!ActionsValues.includes(action as (typeof ActionsValues)[number]) && !Object.hasOwn(col?.actions ?? {}, action)) {
                throw new AppError('Action `' + action + '` not found', { status: 400, code: 'ACTION_NOT_FOUND' });
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
                        cookies: { delete: (name: string) => cookie.deleteCookie(c, name) },
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

                    const authResult = await col.api.auth.onLogin({
                        rest, payload: body?.payload, error: fn.error, jwt: func.jwt,
                        cookies: {
                            set: (name: string, value: string, opts?: any) => cookie.setCookie(c, name, value, opts),
                            get: (name: string) => cookie.getCookie(c, name),
                            delete: (name: string) => cookie.deleteCookie(c, name),
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
            // Faille 7: single implementation via evaluateAccess (checks expired/forged tokens)
            await evaluateAccess(col?.api?.access as any, action, rest, 'Action', c);

            // ── Execute action ──
            if (col.actions?.[action]) {
                response = await col.actions[action]({
                    rest, data: body?.data, error: fn.error,
                    io, jwt: func.jwt, token: accessToken,
                });
            } else {
                const handler = crudHandlers[action];
                if (!handler) throw new AppError('Action `' + action + '` not found', { status: 400, code: 'ACTION_NOT_FOUND' });

                // Strip readOnlyFields for mutations
                if (action === 'insertOne' || action === 'insertMany') {
                    stripReadOnlyData(col, body);
                } else if (action === 'updateOne' || action === 'updateMany') {
                    stripReadOnlyUpdate(col, body);
                }

                response = await handler(rest, collection, body);
            }

            // Strip private fields from response
            if (privateFields.length > 0) {
                response = func.omit(response!, privateFields, fieldOrder);
            }

            return c.json(response);

        } catch (err: any) {
            if (cfg?.debug) console.error(err)
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
            if (!serviceInstance) throw new AppError('Service `' + service + '` not found', { status: 400, code: 'SERVICE_NOT_FOUND' });
            if (!serviceInstance.enabled) throw new AppError('Service `' + service + '` is not enabled', { status: 400, code: 'SERVICE_NOT_ENABLED' });
            if (!serviceInstance.actions?.[action]) throw new AppError('Service `' + service + '` is not defined', { status: 400, code: 'SERVICE_NOT_DEFINED' });

            const rest = new useRest({ internal: false, tenant_id });

            // Access control (same logic as checkFileAccess)
            const serviceAccess = serviceInstance.api?.access as Record<string, boolean | Function> | undefined;
            await evaluateAccess(serviceAccess as any, action, rest, action, c);

            // Re-read accessToken for the action handler
            const accessToken = getAccessToken(c);

            const logStart = Date.now();
            try {
                const response = await serviceInstance.actions[action]({
                    data: body?.data, error: fn.error, io, jwt: func.jwt, token: accessToken, rest,
                });

                await logActivity({ rest, tenant_id, action, collection: service, status: 'success', input: body?.data, result: response, duration: Date.now() - logStart, token: { decoded: accessToken.decoded, value: null, provided: true, expired: false } });
                return c.json(response);
            } catch (err: any) {
                await logActivity({ rest, tenant_id, action, collection: service, status: 'error', input: body?.data, error: { message: err?.message, code: err?.code || 'INTERNAL_SERVICE_ERROR' }, duration: Date.now() - logStart, token: { decoded: accessToken.decoded, value: null, provided: true, expired: false } }).catch(() => {});
                throw err;
            }
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
                throw new AppError('File collection `' + collection + '` not found', { status: 400, code: 'FILE_COLLECTION_NOT_FOUND' });
            }
            await checkFileAccess(colUpload?.api?.access as any, 'upload', tenant_id, c);

            const contentType = c.req.header('Content-Type') || '';
            if (!contentType.includes('multipart/form-data')) {
                throw new AppError('Content-Type must be multipart/form-data', { code: 'INVALID_CONTENT_TYPE', status: 400 });
            }

            // Faille 11: reject oversized bodies BEFORE parseBody buffers them in memory
            const contentLength = Number(c.req.header('Content-Length') ?? 0);
            const maxUploadSize = colUpload.upload?.maxSize ?? 10 * 1024 * 1024; // 10MB default
            // multipart overhead (boundaries/headers) ≈ 64KB max
            if (Number.isFinite(contentLength) && contentLength > 0 && contentLength > maxUploadSize + 64 * 1024) {
                throw new AppError(`Request too large (max ${Math.round(maxUploadSize / 1024 / 1024)}MB)`, {
                    code: 'FILE_TOO_LARGE', status: 413,
                });
            }

            const formData = await c.req.parseBody();
            const fileField = formData['file'] || formData['upload'];
            if (!fileField || !(fileField instanceof File)) {
                throw new AppError('No file provided. Use field name "file" or "upload".', { code: 'FILE_REQUIRED', status: 400 });
            }

            const data: Record<string, any> = {};
            for (const [key, value] of Object.entries(formData)) {
                if (key !== 'file' && key !== 'upload' && !(value instanceof File)) {
                    data[key] = value;
                }
            }

            const result = await handleUpload({ collection, tenant_id, file: fileField, data });
            return c.json(result);
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

            // Faille 18: validate the RAW path before basename (checks were dead code)
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
            c.header('Cache-Control', 'public, max-age=31536000, immutable');
            // Faille 4: SVG served as attachment (no inline execution)
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
        // Faille 6: require a VERIFIED, non-expired token (not just any provided value)
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
