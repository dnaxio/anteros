import type { Hono } from "hono"
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
    'findOneAndUpdate',
    'runService',
    'upload',
    'auth',
    'login',
    'logout',
    'aggregate',
] as const;



// ─── File access helper ────────────────────────────────────────────────────

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

    // No matching rule at all → deny
    if (!hasWildcard && !hasSpecific) {
        throw new AppError('Access denied', { status: 401, code: 'ACCESS_DENIED' });
    }

    // Specific rule takes precedence over wildcard
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
    const t = c.get('token');
    const accessToken = { value: t?.value ?? null, decoded: t?.decoded ?? null, provided: t?.provided ?? false, expired: t?.expired ?? false };

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

function initializeApi(app: Hono<{ Variables: HonoVariables }>) {

    // Crud API

    // tenant middlewares (scoped to their tenant only)
    const tenantMiddlewares = getTenantMiddlewares();
    for (const mw of tenantMiddlewares) {
        app.use(async (c, next) => {
            const url = new URL(c.req.url);
            const segments = url.pathname.split('/').filter(Boolean);
            const tenantInUrl = segments[1]; // /api/:tenant/... or /services/:tenant/... etc.

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
        collectionType?: string;
        status: string;
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

    app.post(API_PREFIX, async (c) => {
        let isMultipartOrFormData = false;
        let response: any;
        let body: any;
        let parseBody: any;
        let rest: InstanceType<typeof useRest>;
        let canAccessToAction: boolean | undefined;

        try {
            const ContentType = c.req.header('Content-Type');
            const { action, collection, tenant_id } = c.req.param() as { action: typeof ActionsValues[number], collection: string, tenant_id: string };
            const { cleanDeep, useCache } = c.req.query() as ApiOptions;



            // Control request params
            if (!tenant_id) {
                throw new AppError('Tenant ID is required', { status: 400, code: 'TENANT_ID_REQUIRED' });
            }

            if (!collection) {
                throw new AppError('Collection is required', { status: 400, code: 'COLLECTION_REQUIRED' });
            }

            if (!action) {
                throw new AppError('Action is required', { status: 400, code: 'ACTION_REQUIRED' });
            }



            // Content Type
            if (ContentType?.includes('application/x-www-form-urlencoded') || ContentType?.includes('multipart/form-data')) {
                isMultipartOrFormData = true;
                try {
                    parseBody = await c.req.parseBody({ all: true });
                } catch {
                    throw new AppError('Invalid form data', { status: 400, code: 'INVALID_FORM_DATA' });
                }
            }
            if (ContentType?.includes('application/json')) {
                isMultipartOrFormData = false;
                try {
                    body = await c.req.json();
                } catch {
                    throw new AppError('Invalid JSON body', { status: 400, code: 'INVALID_JSON_BODY' });
                }
            }



            if (!cfg.tenants.find(t => t.id === tenant_id)) {
                throw new AppError('Tenant `' + tenant_id + '` not found', { status: 400, code: 'TENANT_NOT_FOUND' });
            }


            // Collection
            let col = getCollection(collection, tenant_id)
            if (!col) {
                throw new AppError('Collection `' + collection + '` not found', { status: 400, code: 'COLLECTION_NOT_FOUND' });
            }

            //console.log('Has action:', col?.actions?.hasOwnProperty(action))

            if (!ActionsValues.includes(action as (typeof ActionsValues)[number]) && !Object.hasOwn(col?.actions ?? {}, action)) {
                throw new AppError('Action `' + action + '` not found', { status: 400, code: 'ACTION_NOT_FOUND' });
            }

            const fieldOrder = ['_id', ...col.fields.map(f => f.name)];
            const privateFields = col.api?.privateFields || [];


            // Rest Instance
            rest = new useRest({
                internal: false,
                tenant_id: tenant_id,
                useHook: true,
            })

            // Logout Action
            if (action == 'logout') {
                const logStart = Date.now()
                try {
                    if (!col?.api?.auth?.enabled) {
                        throw new AppError('Auth is not enabled', { status: 400, code: 'AUTH_NOT_ENABLED' });
                    }
                    if (!col?.api?.auth?.onLogout) {
                        throw new AppError('Auth onLogout is not defined', { status: 400, code: 'AUTH_HANDLER_NOT_DEFINED' });
                    }
                    await col.api?.auth?.onLogout({
                        rest: rest,
                        payload: body?.payload,
                        error: fn.error,
                        jwt: func.jwt,
                        req: {
                            cookies: {
                                delete: (name: string) => {
                                    cookie.deleteCookie(c, name)
                                },
                            }
                        }
                    })

                    await logActivity({
                        rest, tenant_id, action: 'logout', collection,
                        status: 'success',
                        input: { payload: body?.payload },
                        duration: Date.now() - logStart,
                    })

                    return c.json({ message: 'Logout successful', ok: true })
                } catch (err: any) {
                    await logActivity({
                        rest, tenant_id, action: 'logout', collection,
                        status: 'error',
                        input: { payload: body?.payload },
                        error: { message: err?.message, code: err?.code || 'INTERNAL_API_ERROR' },
                        duration: Date.now() - logStart,
                    }).catch(() => {})
                    throw err
                }
            }



            // Login Action
            if (action == 'login') {
                const logStart = Date.now()
                try {
                    if (!col?.api?.auth?.enabled) {
                        throw new AppError('Auth is not enabled', { status: 400, code: 'AUTH_NOT_ENABLED' });
                    }
                    if (!col?.api?.auth?.onLogin) {
                        throw new AppError('Auth onLogin is not defined', { status: 400, code: 'AUTH_HANDLER_NOT_DEFINED' });
                    }
                    const authResult = await col.api?.auth?.onLogin({
                            rest: rest,
                            payload: body?.payload,
                            error: fn.error,
                            jwt: func.jwt,
                            req: {
                                cookies: {
                                    set: (name: string, value: string, options?: {
                                        httpOnly?: boolean;
                                        secure?: boolean;
                                        maxAge?: number;
                                        path?: string;
                                        domain?: string;
                                        sameSite?: 'lax' | 'strict' | 'none';
                                    }) => {
                                        cookie.setCookie(c, name, value, options)
                                    },
                                    get: (name: string) => {
                                        return cookie.getCookie(c, name)
                                    },
                                    delete: (name: string) => {
                                        cookie.deleteCookie(c, name)
                                    },

                                }
                            }

                        })



                        if (!authResult || typeof authResult === 'function' || !('token' in authResult)) {
                            throw new AppError('Invalid login response', { status: 401, code: 'INVALID_LOGIN' });
                        }

                        if (!authResult.token) {
                            throw new AppError('Invalid token assigned', { status: 401, code: 'INVALID_TOKEN_ASSIGNED' });
                        }

                        const { value, error } = await func.jwt.verify(authResult.token)
                        if (error) {
                            throw new AppError('Invalid token', { status: 401, code: 'INVALID_TOKEN' });
                        }

                    await logActivity({
                        rest, tenant_id, action: 'login', collection,
                        status: 'success',
                        input: { payload: body?.payload },
                        result: { message: 'Login successful' },
                        duration: Date.now() - logStart,
                        token: { decoded: value, value: null, provided: true, expired: false },
                    })

                    return c.json({ token: authResult.token, data: authResult.data })
                } catch (err: any) {
                    await logActivity({
                        rest, tenant_id, action: 'login', collection,
                        status: 'error',
                        input: { payload: body?.payload },
                        error: { message: err?.message, code: err?.code || 'INTERNAL_API_ERROR' },
                        duration: Date.now() - logStart,
                    }).catch(() => {})
                    throw err
                }
            }

            // check access for sensitive actions
            const t = c.get('token');
            const accessToken = { value: t?.value ?? null, decoded: t?.decoded ?? null, provided: t?.provided ?? false, expired: t?.expired ?? false };

            // For all actions
            if (Object.hasOwn(col?.api?.access ?? {}, '*') && !col?.api?.access?.[action]) {

                if (typeof col?.api?.access?.['*'] === 'function') {
                    canAccessToAction = await col?.api?.access?.['*']({ rest: rest, error: fn.error, jwt: func.jwt, token: accessToken })
                }
                if (typeof col?.api?.access?.['*'] === 'boolean') {

                    canAccessToAction = col?.api?.access?.['*']
                }
                if (canAccessToAction !== true) {
                    throw new AppError('Access denied', { status: 401, code: 'ACCESS_DENIED' });
                }
            }

            // For specific actions
            if (Object.hasOwn(col?.api?.access ?? {}, action) && col?.api?.access) {
                if (typeof col?.api?.access?.[action] === 'function') {
                    canAccessToAction = await col?.api?.access?.[action]({ rest: rest, error: fn.error, jwt: func.jwt, token: accessToken })
                } else {
                    canAccessToAction = col?.api?.access?.[action]
                }
                if (canAccessToAction !== true) {
                    throw new AppError('Access denied', { status: 401, code: 'ACCESS_DENIED' });
                }
            }

            if (canAccessToAction !== true) {
                throw new AppError('Unauthorized', { status: 401, code: 'ACCESS_DENIED_TO_PERFORM_THIS_ACTION' });
            }



            if (Object.hasOwn(col?.actions ?? {}, action) && col?.actions?.[action]) {
                response = await col.actions?.[action]({ rest: rest, data: body?.data, error: fn.error })
            } else if (action == 'aggregate') {
                /* Aggregate */
                response = await rest.aggregate(collection, body?.pipeline || [])
            } else if (action == 'find') {
                /* Find */
                response = await rest.find(collection, body?.params || {})
            } else if (action == 'findOne') {
                /* Find One */
                response = await rest.findOne(collection, body?.id, body?.params || {})
            } else if (action == 'insertOne') {
                /* Insert One */
                if (col.api?.readOnlyFields?.length) {
                    body.data = func.omit(body.data, col.api?.readOnlyFields)
                }
                response = await rest.insertOne(collection, body?.data)
            } else if (action == 'insertMany') {
                /* Insert Many */
                if (col.api?.readOnlyFields?.length) {
                    body.data = func.omit(body.data, col.api?.readOnlyFields)
                }
                response = await rest.insertMany(collection, body?.data)
            } else if (action == 'updateOne') {
                /* Update One */
                if (col.api?.readOnlyFields?.length) {
                    body.update = func.omit(body.update, col.api?.readOnlyFields)
                }
                response = await rest.updateOne(collection, body?.id || body?._id, body?.update || {})
            } else if (action == 'updateMany') {
                /* Update Many */
                if (col.api?.readOnlyFields?.length) {
                    body.update = func.omit(body.update, col.api?.readOnlyFields)
                }
                response = await rest.updateMany(collection, body?.ids || body?._ids || [], body?.update || {})
            } else if (action == 'findOneAndUpdate') {
                /* Find One And Update */
                if (col.api?.readOnlyFields?.length) {
                    body.update = func.omit(body.update, col.api?.readOnlyFields)
                }
                response = await rest.findOneAndUpdate(collection, body?.filter || {}, body?.update || {}, body?.options || {})
            } else if (action == 'deleteOne') {
                /* Delete One */
                response = await rest.deleteOne(collection, body?.id || body?._id)
            } else if (action == 'deleteMany') {
                /* Delete Many */
                response = await rest.deleteMany(collection, body?.ids || body?._ids || [])
            }


            /* Private Fields */
            if (privateFields.length > 0) {
                response = func.omit(response!, privateFields, fieldOrder)
            }

            return c.json(response)


        } catch (err: any) {
            console.error(err?.message || err)
            const isAppError = err instanceof AppError;
            const status = isAppError ? Number(err.status) : 500;
            return c.json({
                message: isAppError ? err.message : 'Internal server error',
                code: isAppError ? err.code : 'INTERNAL_SERVER_ERROR',
                meta: isAppError ? err.meta : undefined,
            }, status as any);
        }

    })


    // Service API
    app.post(SERVICE_PREFIX, async (c) => {
        try {
            const ContentType = c.req.header('Content-Type');
            let isMultipartOrFormData = false;
            let response: any;
            let body: any;
            let parseBody: any;
            let rest: InstanceType<typeof useRest>;

            // Content Type
            if (ContentType?.includes('application/x-www-form-urlencoded') || ContentType?.includes('multipart/form-data')) {
                isMultipartOrFormData = true;
                try {
                    parseBody = await c.req.parseBody({ all: true });
                } catch {
                    throw new AppError('Invalid form data', { status: 400, code: 'INVALID_FORM_DATA' });
                }
            }
            if (ContentType?.includes('application/json')) {
                isMultipartOrFormData = false;
                try {
                    body = await c.req.json();
                } catch {
                    throw new AppError('Invalid JSON body', { status: 400, code: 'INVALID_JSON_BODY' });
                }
            }

            const { service, tenant_id } = c.req.param() as { service: string, tenant_id: string };
            if (!tenant_id) {
                throw new AppError('Tenant ID is required', { status: 400, code: 'TENANT_ID_REQUIRED' });
            }
            if (!service) {
                throw new AppError('Service is required', { status: 400, code: 'SERVICE_REQUIRED' });
            }

            let serviceInstance = cfg.services?.find(s => s.name === service && s._tenant_ === tenant_id) as Service;
            const { action } = c.req.param() as { action: string };
            if (!serviceInstance) {
                throw new AppError('Service `' + service + '` not found', { status: 400, code: 'SERVICE_NOT_FOUND' });
            }
            if (!serviceInstance.enabled) {
                throw new AppError('Service `' + service + '` is not enabled', { status: 400, code: 'SERVICE_NOT_ENABLED' });
            }
            if (!Object.hasOwn(serviceInstance.actions, action) || !serviceInstance.actions?.[action]) {
                throw new AppError('Service `' + service + '` is not defined', { status: 400, code: 'SERVICE_NOT_DEFINED' });
            }

            // Token verification
            const t = c.get('token');
            const accessToken = { value: t?.value ?? null, decoded: t?.decoded ?? null, provided: t?.provided ?? false, expired: t?.expired ?? false };

            if (accessToken.expired) {
                throw new AppError('Token expired', { status: 401, code: 'TOKEN_EXPIRED' });
            }
            if (!accessToken.value) {
                throw new AppError('Authentication required', { status: 401, code: 'AUTH_REQUIRED' });
            }

            rest = new useRest({
                internal: false,
                tenant_id: tenant_id,
            })

            // Access control
            let canAccessToService: boolean | undefined;

            if (Object.hasOwn(serviceInstance?.api?.access ?? {}, '*') && !serviceInstance?.api?.access?.[action]) {
                if (typeof serviceInstance?.api?.access?.['*'] === 'function') {
                    canAccessToService = await serviceInstance.api.access['*']({ rest, error: fn.error, jwt: func.jwt, token: accessToken });
                }
                if (typeof serviceInstance?.api?.access?.['*'] === 'boolean') {
                    canAccessToService = serviceInstance.api.access['*'];
                }
                if (!canAccessToService) {
                    throw new AppError('Access denied', { status: 401, code: 'ACCESS_DENIED' });
                }
            }

            if (Object.hasOwn(serviceInstance?.api?.access ?? {}, action) && serviceInstance?.api?.access) {
                if (typeof serviceInstance?.api?.access?.[action] === 'function') {
                    canAccessToService = await serviceInstance.api.access[action]({ rest, error: fn.error, jwt: func.jwt, token: accessToken });
                } else {
                    canAccessToService = serviceInstance.api.access[action];
                }
                if (!canAccessToService) {
                    throw new AppError('Access denied', { status: 401, code: 'ACCESS_DENIED' });
                }
            }

            if (canAccessToService !== true) {
                throw new AppError('Unauthorized', { status: 401, code: 'ACCESS_DENIED_TO_PERFORM_THIS_ACTION' });
            }

            const logStart = Date.now()

            try {
                response = await serviceInstance.actions?.[action]({
                    data: body?.data,
                    error: fn.error,
                    io: io,
                    jwt: func.jwt,
                    token: accessToken,
                    rest,
                })

                await logActivity({
                    rest, tenant_id, action, collection: service,
                    status: 'success',
                    input: body?.data,
                    result: response,
                    duration: Date.now() - logStart,
                    token: { decoded: accessToken.decoded, value: null, provided: true, expired: false },
                })

                return c.json(response)
            } catch (err: any) {
                await logActivity({
                    rest, tenant_id, action, collection: service,
                    status: 'error',
                    input: body?.data,
                    error: { message: err?.message, code: err?.code || 'INTERNAL_SERVICE_ERROR' },
                    duration: Date.now() - logStart,
                    token: { decoded: accessToken.decoded, value: null, provided: true, expired: false },
                }).catch(() => {})
                throw err
            }
        } catch (err: any) {
            console.error(err?.message || err)
            const isAppError = err instanceof AppError;
            const status = isAppError ? Number(err.status) : 500;
            return c.json({
                message: isAppError ? err.message : 'Internal server error',
                code: isAppError ? err.code : 'INTERNAL_SERVER_ERROR',
                meta: isAppError ? err.meta : undefined,
            }, status as any);
        }
    })


  // Upload API
  app.post(UPLOAD_PREFIX, async (c) => {
    try {
      const { tenant_id, collection } = c.req.param() as { tenant_id: string; collection: string };

      if (!cfg.tenants.find(t => t.id === tenant_id)) {
        throw new AppError('Tenant `' + tenant_id + '` not found', { status: 400, code: 'TENANT_NOT_FOUND' });
      }

      // Check access
      const colUpload = getFileCollection(collection, tenant_id);
      if (!colUpload) {
        throw new AppError('File collection `' + collection + '` not found', { status: 400, code: 'FILE_COLLECTION_NOT_FOUND' });
      }
      await checkFileAccess(colUpload?.api?.access as any, 'upload', tenant_id, c);

      const contentType = c.req.header('Content-Type') || '';
      if (!contentType.includes('multipart/form-data')) {
        throw new AppError('Content-Type must be multipart/form-data', {
          code: 'INVALID_CONTENT_TYPE', status: 400,
        });
      }

      const formData = await c.req.parseBody();
      const fileField = formData['file'] || formData['upload'];
      if (!fileField || !(fileField instanceof File)) {
        throw new AppError('No file provided. Use field name "file" or "upload".', {
          code: 'FILE_REQUIRED', status: 400,
        });
      }

      // Extract custom fields from form data (exclude file keys)
      const data: Record<string, any> = {};
      for (const [key, value] of Object.entries(formData)) {
        if (key !== 'file' && key !== 'upload' && !(value instanceof File)) {
          data[key] = value;
        }
      }

      const result = await handleUpload({
        collection,
        tenant_id,
        file: fileField,
        data,
      });

      return c.json(result);
    } catch (err: any) {
      const isAppError = err instanceof AppError;
      const status = isAppError ? Number(err.status) : 500;
      return c.json({
        message: isAppError ? err.message : 'Internal server error',
        code: isAppError ? err.code : 'INTERNAL_SERVER_ERROR',
      }, status as any);
    }
  })

  // Serve files
  app.get(FILES_PREFIX, async (c) => {
    try {
      const { tenant_id, collection } = c.req.param() as { tenant_id: string; collection: string };

      if (!cfg.tenants.find(t => t.id === tenant_id)) {
        throw new AppError('Tenant `' + tenant_id + '` not found', { status: 400, code: 'TENANT_NOT_FOUND' });
      }

      // Check access
      const colServe = getFileCollection(collection, tenant_id);
      if (!colServe) {
        throw new AppError('File collection `' + collection + '` not found', { status: 400, code: 'FILE_COLLECTION_NOT_FOUND' });
      }
      await checkFileAccess(colServe?.api?.access as any, 'read', tenant_id, c);

      const filename = basename(c.req.param('file') as string);
      if (!filename || filename.startsWith('.') || filename.includes('..') || filename.includes('/')) {
        throw new AppError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' });
      }
      const fileId = filename.replace(/\.[^.]+$/, ''); // remove extension to get the ID

      // Parse optional transformation query params
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

      return c.newResponse(result.stream);
    } catch (err: any) {
      const isAppError = err instanceof AppError;
      const status = isAppError ? Number(err.status) : 500;
      return c.json({
        message: isAppError ? err.message : 'Internal server error',
        code: isAppError ? err.code : 'INTERNAL_SERVER_ERROR',
      }, status as any);
    }
  })

  // Delete file
  app.delete(FILES_PREFIX, async (c) => {
    try {
      const { tenant_id, collection } = c.req.param() as { tenant_id: string; collection: string };

      if (!cfg.tenants.find(t => t.id === tenant_id)) {
        throw new AppError('Tenant `' + tenant_id + '` not found', { status: 400, code: 'TENANT_NOT_FOUND' });
      }

      // Check access
      const colDelete = getFileCollection(collection, tenant_id);
      if (!colDelete) {
        throw new AppError('File collection `' + collection + '` not found', { status: 400, code: 'FILE_COLLECTION_NOT_FOUND' });
      }
      await checkFileAccess(colDelete?.api?.access as any, 'delete', tenant_id, c);

      const filename = basename(c.req.param('file') as string);
      if (!filename || filename.startsWith('.') || filename.includes('..') || filename.includes('/')) {
        throw new AppError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' });
      }
      const fileId = filename.replace(/\.[^.]+$/, '');

      await handleDelete(tenant_id, collection, fileId, filename);

      return c.json({ message: 'File deleted', ok: true });
    } catch (err: any) {
      const isAppError = err instanceof AppError;
      const status = isAppError ? Number(err.status) : 500;
      return c.json({
        message: isAppError ? err.message : 'Internal server error',
        code: isAppError ? err.code : 'INTERNAL_SERVER_ERROR',
      }, status as any);
    }
  })

  // Public config endpoint — filtered by tenant (auth required)
  app.get('/_dnax/config/:tenant_id', (c) => {
      const t = c.get('token');
      if (!t?.value) {
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
  })

}


export {
    initializeApi
}
