
import type { Tenant } from "../types/tenant";
import type { MongoClientOptions, Db, ClientSession, UpdateOptions, UpdateFilter, Document, DeleteResult, ChangeStreamOptions, ChangeStream, ChangeStreamDocument, AnyBulkWriteOperation, BulkWriteOptions, BulkWriteResult, UpdateResult } from "mongodb";
import { MongoClient, ObjectId, AggregationCursor } from "mongodb";
import type { FindOptions, findOneOptions } from "../types/mongo";
import { sessionCtxStorage, asyncContextStorage, requestCtxStorage } from "../lib/asyncContextStorage";
import * as func from "../utils/func"
import { AppError, fn } from "../lib/error";
import { createWorkflow } from "./workflow";
import { getTenant } from "./tenant";
import { getCollection, getCollectionKeys } from "./collection"
import type { RestActions, BulkUpdateOperation, RestOptions, CursorOptions } from "../types/rest";
import type Joi from "joi";
import type { Collection } from "../types/collection";
import { CheckBulkWriteOperations, CheckIfCollectionExists, CheckIfId, CheckInsertData, CheckIfArrayOfIds, CheckFilter, LogSlowQuery } from "./decorator";
import type { ActionsApiList, updateApiOptions } from "../types/api";
import type { ActivityInput } from "../types/activity";
import * as os from 'node:os';
import { cfg } from '../server/config';
import { io } from '../server/io';
import type { Service } from '../types/service';

class MongoRest {
    client!: MongoClient;
    #isConnected: boolean = false;
    #internal: boolean = true;
    db!: Db;
    tenant_id!: string;
    #tenant!: Tenant;
    session!: ClientSession | undefined;
    #database?: {
        uri: string;
        options?: MongoClientOptions;
    };
    #useHook: boolean;
    #useCustomApi: boolean;
    constructor(options: RestOptions) {
        this.#internal = options.internal ?? true;
        this.#database = options.database;
        this.#useHook = options.useHook ?? true;
        this.#useCustomApi = options.useCustomApi ?? true;
        if (options.session) {
            this.session = options.session;
        }
        // Resolve tenant: explicit tenant_id, else from request context
        let tenantId = options.tenant_id;
        if (!tenantId) {
            tenantId = requestCtxStorage.get<string>('tenant_id');
        }
        let tenant = getTenant(tenantId ?? '-')
        if (tenant) {
            this.#tenant = tenant;
            this.tenant_id = tenant.id;
            this.db = tenant.database.db as Db;
            this.client = tenant.database.client as MongoClient;
        }
    }


    private _validate(options: { collection: string, action?: ActionsApiList, data?: any, update?: UpdateFilter<any> }): any {
        let col = getCollection(options.collection, this.#tenant.id)
        let schema = col?._schema_
        let partialSchema = col?._schemaPartial_
        let validationResult: Joi.ValidationResult<any> | undefined = undefined


        if (!col) throw new AppError(`collection '${options?.collection || ''}' not found`, {
            code: 'COLLECTION_NOT_FOUND',
            status: 500
        })


        if (!options.action) throw new AppError(`action '${options?.action || ''}' not found or required`, {
            code: 'ACTION_REQUIRED',
            status: 500
        })


        if (schema && partialSchema) {


            if (options?.data) {
                if (options.action == 'insertMany') {
                    const sanitized: any[] = [];
                    for (let i = 0; i < options.data.length; i++) {
                        validationResult = schema.validate(options.data[i], { allowUnknown: false })
                        if (validationResult?.error) {
                            throw new AppError(validationResult.error.message, {
                                code: 'VALIDATION_ERROR',
                                status: 400
                            })
                        }
                        sanitized.push(validationResult.value)
                    }
                    return sanitized;
                }

                if (options.action == 'insertOne') {
                    validationResult = schema.validate(options.data, { allowUnknown: false })
                    if (validationResult?.error) {
                        throw new AppError(validationResult.error.message, {
                            code: 'VALIDATION_ERROR',
                            status: 400
                        })
                    }
                    // Return sanitized value (Joi defaults applied, unknown keys handled)
                    return validationResult.value;
                }
            }


            if (options?.update) {
                if ((options.action == 'insertOne' || options.action == 'insertMany') && options.update?.$set) {
                    validationResult = partialSchema.validate(options.update.$set, { allowUnknown: false })
                }

                if (options.action == "findOneAndUpdate" && options.update.$set) {
                    validationResult = partialSchema.validate(options.update.$set, { allowUnknown: false })
                }

                if (options.action == "findOneAndUpdate" && options.update.$setOnInsert) {
                    validationResult = partialSchema.validate(options.update.$setOnInsert, { allowUnknown: false })
                }

                // Faille 9: updateOne/updateMany — unflatten dot-notation ("address.zip") before Joi validation
                if ((options.action == 'updateOne' || options.action == 'updateMany') && options.update?.$set) {
                    const unflattened = func.unflattenKeys(options.update.$set)
                    validationResult = partialSchema.validate(unflattened, { allowUnknown: false })
                    if (validationResult?.error) {
                        throw new AppError(validationResult.error.message, {
                            code: 'VALIDATION_ERROR',
                            status: 400
                        })
                    }
                    // Write sanitized (nested) value back — MongoDB accepts nested objects
                    if (validationResult.value) {
                        options.update.$set = validationResult.value
                    }
                }

                if (validationResult?.error) {
                    throw new AppError(validationResult.error.message, {
                        code: 'VALIDATION_ERROR',
                        status: 400
                    })
                }
                return validationResult?.value;
            }

        }

        // No schema or nothing to sanitize → pass the raw data through
        return options.data;
    }

    async #logActivity(data: {
        action: string,
        collection: string,
        input?: any,
        result?: any,
        error?: { message: string, code: string },
        duration: number,
    }) {
        const ctxMeta = requestCtxStorage.get<Record<string, any>>('meta')
        const traceCtx = requestCtxStorage.get<{ id: string; comment?: string; tag?: string; version?: string }>('trace')
        const token = requestCtxStorage.get<{ value: string | null, decoded: Record<string, unknown> | null, provided: boolean, expired: boolean }>('token')

        const traceId = traceCtx?.id ?? crypto.randomUUID()
        const trace: ActivityInput['trace'] = {
            id: traceId,
            comment: traceCtx?.comment,
            tag: traceCtx?.tag,
            version: traceCtx?.version,
        }

        const { request: requestMeta, ...restMeta } = ctxMeta ?? {}

        const meta: any = {
            ...restMeta,
            platform: restMeta?.platform ?? os.platform(),
            core_version: cfg.version ?? restMeta?.core_version,
        }

        // Determine collection type
        const colMeta = cfg.collections?.find(c => c.slug === data.collection && c._tenant_ === this.tenant_id)
            ?? cfg.fileCollections?.find(c => c.slug === data.collection && c._tenant_ === this.tenant_id)
        const collectionType = colMeta && 'type' in colMeta ? colMeta.type : colMeta ? 'file' : undefined

        const activity: ActivityInput = {
            internal: requestCtxStorage.get<boolean>('internal') ?? this.#internal,
            trace,
            request: requestMeta,
            meta,
            operation: {
                tenant: this.tenant_id,
                action: data.action,
                collection: data.collection,
                collectionType,
                status: data.error ? 'error' : 'success',
                input: data.input,
                result: data.result,
                error: data.error ?? null,
                duration: data.duration,
                transaction: this.session?.inTransaction?.() ?? false,
                token: token ? { decoded: token.decoded, value: null, provided: token.provided ?? true, expired: token.expired ?? false } : undefined,
            },
            ts: new Date(),
        }

        await this.audit.addActivities([activity])
    }

    async #executeWithAudit<T>(
        action: string,
        collection: string,
        input: any,
        fn: () => Promise<T>
    ): Promise<T> {
        const start = Date.now()
        try {
            const result = await fn()
            const duration = Date.now() - start
            this.#logActivity({ action, collection, input, result, duration })
            return result
        } catch (err: any) {
            const duration = Date.now() - start
            this.#logActivity({ action, collection, input, error: { message: err?.message, code: err?.code || 'INTERNAL_API_ERROR' }, duration })
            throw err instanceof AppError ? err : new AppError(err?.message || 'Internal server error', { code: 'INTERNAL_API_ERROR', status: 500 })
        }
    }

    async connect(options?: {
        uri?: string;
        options?: MongoClientOptions;
    }): Promise<{ client: MongoClient, db: Db }> {
        try {

            if (!this.#isConnected && this.#database) {
                this.client = new MongoClient(options?.uri ?? this.#database.uri, {
                    ...options?.options || this.#database.options,
                })
                await this.client.connect()
                this.db = this.client.db();
                this.#isConnected = true;
            }
            return {
                client: this.client,
                db: this.db,
            }
        } catch (err: any) {
            console.error('MongoDB connection failed', err?.message);
            throw new Error(err?.message);
        }
    }

    @CheckIfCollectionExists()
    async watch(collection: string, pipeline: any[], options: ChangeStreamOptions): Promise<ChangeStream> {
        const col = getCollection(collection, this.#tenant.id) as Collection
        const isSafe = func.isSafeAggregatePipeline(pipeline);
        if (!isSafe.isSafe) {
            throw isSafe.error;
        }
        pipeline = await func.buildInput(pipeline)
        pipeline = func.toBson(pipeline, { col })
        return await this.db.collection(collection).watch(pipeline, {
            allowDiskUse: true,
            session: this.session,
            ...options
        })
    }

    @LogSlowQuery()
    @CheckIfCollectionExists()
    async aggregate(collection: string, pipeline: any[]): Promise<Document[]> {
        const action = 'aggregate' as ActionsApiList
        try {

            const col = getCollection(collection, this.#tenant.id) as Collection
            // Faille 12: restrict $lookup targets to this tenant's declared collections
            const allowedCollections = [
                ...(cfg.collections ?? [])
                    .filter(c => c._tenant_ === this.tenant_id)
                    .map(c => c.slug),
                ...(cfg.fileCollections ?? [])
                    .filter(fc => fc._tenant_ === this.tenant_id)
                    .map(fc => fc.slug),
                '_activities_', '_locks_', '_workflows_',
            ];
            const isSafe = func.isSafeAggregatePipeline(pipeline, allowedCollections);
            if (!isSafe.isSafe) {
                throw isSafe.error;
            }
            pipeline = func.toBson(pipeline, { col })
            const meta: any = { action, collection, pipeline }
            if (col.hooks?.beforeOperation) {
                await col.hooks.beforeOperation({ rest: this, io, action, meta })
            }

            let result = await this.db.collection(collection).aggregate(pipeline, {
                session: this.session,
                allowDiskUse: true,
            }).toArray()
            result = func.toJson(result)
            meta.result = result

            await col.hooks?.afterOperation?.({ rest: this, io, action, meta })

            return result as any[]
        } catch (err: any) {
            throw err instanceof AppError ? err : new AppError(err?.message || 'Internal server error', { code: 'INTERNAL_API_ERROR', status: 500 })
        }
    }

    /**
     * Apply cursor methods (batchSize, maxTimeMS). comment/hint are passed
     * through the aggregate() options (not available on AggregationCursor in v7).
     */
    #applyCursorOptions(cursor: AggregationCursor, options: CursorOptions) {
        if (options.batchSize) cursor.batchSize(options.batchSize)
        if (options.maxTimeMS) cursor.maxTimeMS(options.maxTimeMS)
    }

    /**
     * Stream `find`-style results one by one — JSON-converted docs, cursor auto-closed.
     * Iterates everything (no default $limit, unlike find() which caps at 100).
     *
     * With `{ withCount: true }`, a background `countDocuments` runs in parallel
     * and each yielded item becomes `{ count, doc }` — the total + the document.
     *
     * @example
     * for await (const doc of rest.findStream('orders', { $match: { status: 'paid' } }, { batchSize: 500 })) { … }
     * for await (const d of rest.findStream('orders', { $match: { status: 'paid' } }, { withCount: true })) {
     *   console.log(d.count, d.doc); // total + document
     * }
     * for await (const u of rest.findStream<User>('users', { $match: { active: true } }, {
     *   map: (u) => ({ id: u._id, name: u.name }),
     *   signal: controller.signal,
     * })) { … }
     * // Page mode: { pageSize } yields { count, docs, hasNext() } batches
     * for await (const page of rest.findStream('orders', { $match: { status: 'paid' } }, { pageSize: 50 })) {
     *   console.log(page.count, page.docs.length, page.hasNext());
     * }
     */
    @CheckIfCollectionExists()
    async *findStream<T = any>(collection: string, params: FindOptions = {}, options: CursorOptions = {}): AsyncGenerator<any> {
        const pageSize = options.pageSize;
        // Page mode counts by default (opt-out with withCount: false); per-doc mode counts only when withCount: true
        const withCount = pageSize ? options.withCount !== false : options.withCount === true;
        // Background total count (runs in parallel with the iteration)
        const countPromise = withCount
            ? this.countDocuments(collection, params.$match ?? {})
            : null;
        const col = getCollection(collection, this.#tenant.id) as Collection
        let pipeline = func.buildPipeline({ ...params, $limit: params.$limit ?? 0 }, { col: col })
        pipeline = await func.buildInput(pipeline, { rest: this })
        pipeline = func.toBson(pipeline, { col })
        const cursor = this.db.collection(collection).aggregate(pipeline, {
            session: this.session,
            allowDiskUse: true,
            comment: options.comment,
            hint: options.hint,
        }) as AggregationCursor
        this.#applyCursorOptions(cursor, options)
        // Resolve the count ONCE before iterating — the value is reused on every yield
        const count = countPromise ? await countPromise : null
        try {
            if (pageSize) {
                // ── Page mode: batches of `pageSize` → { count?, docs, hasNext() } ──
                while (await cursor.hasNext()) {
                    if (options.signal?.aborted) break
                    const docs: any[] = []
                    for (let i = 0; i < pageSize && await cursor.hasNext(); i++) {
                        let value: any = func.toJson(await cursor.next())
                        if (options.map) value = options.map(value as T)
                        docs.push(value)
                    }
                    const hasMore = await cursor.hasNext()
                    yield {
                        ...(withCount ? { count } : {}),
                        docs,
                        hasNext: () => hasMore,
                    }
                }
            } else {
                // ── Per-doc mode: doc or { count, doc } ──
                for await (const doc of cursor) {
                    if (options.signal?.aborted) break
                    let value: any = func.toJson(doc)
                    if (options.map) value = options.map(value as T)
                    if (options.withCount) {
                        yield { count, doc: value }
                    } else {
                        yield value
                    }
                }
            }
        } finally {
            await cursor.close().catch(() => {})
        }
    }

    /**
     * Stream `aggregate` results one by one (same safety checks as `aggregate`) —
     * JSON-converted docs, cursor auto-closed.
     *
     * @example
     * for await (const doc of rest.aggregateStream('orders', [{ $match: { status: 'paid' } }], { batchSize: 500 })) { … }
     * for await (const d of rest.aggregateStream('orders', [{ $group: { _id: '$status', n: { $sum: 1 } } }], { withCount: true })) {
     *   console.log(d.count, d.doc); // total pipeline results + each doc
     * }
     */
    @CheckIfCollectionExists()
    async *aggregateStream<T = any>(collection: string, pipeline: any[] = [], options: CursorOptions = {}): AsyncGenerator<any> {
        const col = getCollection(collection, this.#tenant.id) as Collection
        const allowedCollections = [
            ...(cfg.collections ?? []).filter((c) => c._tenant_ === this.tenant_id).map((c) => c.slug),
            ...(cfg.fileCollections ?? []).filter((fc) => fc._tenant_ === this.tenant_id).map((fc) => fc.slug),
            '_activities_', '_locks_', '_workflows_',
        ];
        const isSafe = func.isSafeAggregatePipeline(pipeline, allowedCollections);
        if (!isSafe.isSafe) {
            throw isSafe.error;
        }
        pipeline = func.toBson(pipeline, { col })
        // Background total count of the pipeline OUTPUT (via a $count stage) —
        // parallel with the iteration; best-effort (fails silently for $out/$merge)
        const countPromise = options.withCount
            ? this.db.collection(collection).aggregate([...pipeline, { $count: 'count' }], {
                session: this.session,
                allowDiskUse: true,
            }).toArray().then((r) => (r[0]?.count as number) ?? 0).catch(() => 0)
            : null;
        const cursor = this.db.collection(collection).aggregate(pipeline, {
            session: this.session,
            allowDiskUse: true,
            comment: options.comment,
            hint: options.hint,
        }) as AggregationCursor
        this.#applyCursorOptions(cursor, options)
        // Resolve the count ONCE before iterating — the value is reused on every yield
        const count = countPromise ? await countPromise : null
        try {
            for await (const doc of cursor) {
                if (options.signal?.aborted) break
                let value: any = func.toJson(doc)
                if (options.map) value = options.map(value as T)
                if (options.withCount) {
                    yield { count, doc: value }
                } else {
                    yield value
                }
            }
        } finally {
            await cursor.close().catch(() => {})
        }
    }

    @LogSlowQuery()
    @CheckIfCollectionExists()
    async find(collection: string, params: FindOptions = {}, options = {}): Promise<Document[]> {
        const action = 'find' as ActionsApiList
        try {
            const col = getCollection(collection, this.#tenant.id) as Collection
            let pipeline = func.buildPipeline(params, { col: col })
            pipeline = await func.buildInput(pipeline, { rest: this })
            pipeline = func.toBson(pipeline, { col })

            const meta: any = { action, collection, params, options }
            if (col.hooks?.beforeOperation) {
                await col.hooks.beforeOperation({ rest: this, io, action, meta })
            }

            let result = await this.db.collection(collection).aggregate(pipeline, {
                session: this.session,
                allowDiskUse: true
            }).toArray()
            result = func.toJson(result)
            meta.result = result

            if (col.hooks?.afterOperation) {
                await col.hooks.afterOperation({ rest: this, io, action, meta })
            }

            return result as any[]
        } catch (err: any) {
            throw err instanceof AppError ? err : new AppError(err?.message || 'Internal server error', { code: 'INTERNAL_API_ERROR', status: 500 })
        }
    }

    @LogSlowQuery()
    @CheckIfCollectionExists()
    async findOne(collection: string, _id: string, params?: findOneOptions): Promise<any> {
        const action = 'findOne' as ActionsApiList
        try {
            const col = getCollection(collection, this.#tenant.id) as Collection
            let pipeline = func.buildPipeline({
                ...params,
                $match: { _id },
                $limit: 1
            }, { col: col })
            pipeline = await func.buildInput(pipeline, { rest: this })
            pipeline = func.toBson(pipeline, { col })

            const meta: any = { action, collection, params, id: _id }
            if (col.hooks?.beforeOperation) {
                await col.hooks.beforeOperation({ rest: this, io, action, meta })
            }

            let result = (await this.db.collection(collection).aggregate(pipeline, {
                session: this.session,
                allowDiskUse: true
            }).toArray()).at(0) ?? null
            result = func.toJson(result)
            meta.result = result

            if (col.hooks?.afterOperation) {
                await col.hooks.afterOperation({ rest: this, io, action, meta })
            }

            return result
        } catch (err: any) {
            throw err instanceof AppError ? err : new AppError(err?.message || 'Internal server error', { code: 'INTERNAL_API_ERROR', status: 500 })
        }
    }

    @LogSlowQuery()
    @CheckIfCollectionExists()
    @CheckInsertData('insertOne')
    async insertOne<T>(collection: string, data: T): Promise<T & { _id: string }> {
        const action = 'insertOne' as ActionsApiList
        return this.#executeWithAudit(action, collection, { data }, async () => {
            const col = getCollection(collection, this.#tenant.id) as Collection

            data = await func.buildInput(data as T, {
                action: action, col: col, rest: this
            })

            const meta: any = { action, collection, data }
            if (col.hooks?.beforeOperation) {
                await col.hooks.beforeOperation({ rest: this, io, action, meta })
            }
            // Validate AFTER hooks (they may fill required fields or apply Joi defaults)
            meta.data = this._validate({ collection, action: action, data: meta.data })

            await this.db.collection(collection).insertOne(func.toBson(meta.data, { col }) as any, {
                session: this.session,
            })

            const result: T & { _id: string } = func.toJson(meta.data as T & { _id: string })
            meta.result = result
            if (col?.hooks?.afterOperation) {
                await col.hooks.afterOperation({ rest: this, io, action, meta })
            }

            return result
        })
    }

    @LogSlowQuery()
    @CheckIfCollectionExists()
    @CheckInsertData('insertMany')
    async insertMany<T>(collection: string, data: T[]): Promise<(T & { _id: string })[]> {
        const action = 'insertMany' as ActionsApiList
        return this.#executeWithAudit(action, collection, { count: data.length }, async () => {
            const col = getCollection(collection, this.#tenant.id) as Collection
            let dataInput: T[] = []

            for (let d of data) {
                d = await func.buildInput(d as T, {
                    action: action,
                    col,
                    rest: this
                })
                dataInput.push(d)
            }

            const meta: any = { action, collection, data: dataInput }
            if (col.hooks?.beforeOperation) {
                await col.hooks.beforeOperation({ rest: this, io, action, meta })
            }
            // Validate AFTER hooks (they may fill required fields or apply Joi defaults)
            meta.data = this._validate({ collection, action: action, data: meta.data })

            await this.db.collection(collection).insertMany(func.toBson(meta.data, { col }) as any, {
                session: this.session,
            })

            const result: (T & { _id: string })[] = func.toJson(meta.data as (T & { _id: string })[])
            meta.result = result

            if (col.hooks?.afterOperation) {
                await col.hooks.afterOperation({ rest: this, io, action, meta })
            }

            return result as (T & { _id: string })[]
        })
    }

    @LogSlowQuery()
    @CheckIfCollectionExists()
    @CheckIfId('updateOne')
    async updateOne(collection: string, _id: string, update: UpdateFilter<any>) {
        const action = 'updateOne' as ActionsApiList
        return this.#executeWithAudit(action, collection, { id: _id, update }, async () => {
            const col = getCollection(collection, this.#tenant.id) as Collection

            if (update.$set) {
                update.$set = await func.buildInput(update.$set, { action: action, col: col })
            }

            update = await func.buildInput(update)
            this._validate({ collection, action: action, update: update })
            update = func.toBson(update, { col })

            const meta: any = { action, collection, update, id: _id }
            if (col.hooks?.beforeOperation) {
                await col.hooks.beforeOperation({ rest: this, io, action, meta })
            }

            const data = await this.db.collection(collection).findOneAndUpdate(
                { _id: new ObjectId(_id) },
                { ...(update as any) },
                { session: this.session, returnDocument: 'after' }
            )

            const result = func.toJson(data)
            meta.result = result

            if (col.hooks?.afterOperation) {
                await col.hooks.afterOperation({ rest: this, io, action, meta })
            }

            return result
        })
    }

    @LogSlowQuery()
    @CheckIfCollectionExists()
    @CheckFilter()
    async findOneAndUpdate(collection: string, filter: Document, update: UpdateFilter<any>, options?: updateApiOptions): Promise<Document | null> {
        const action = 'findOneAndUpdate' as ActionsApiList
        return this.#executeWithAudit(action, collection, { filter, update, options }, async () => {
            const col = getCollection(collection, this.#tenant.id) as Collection



            if (update.$set) {
                update.$set = await func.buildInput(update.$set, { action: action, col: col })
            }

            update.$setOnInsert = await func.buildInput(update.$setOnInsert || {}, {
                action: 'insertOne',
                col: col
            })

            update.$set = func.omit(update.$set, ['updatedAt'])
            update.$setOnInsert = func.omit(update.$setOnInsert, ['updatedAt'])

            update.$currentDate = {
                updatedAt: true,
            }


            // clean Deep on filter
            if (options?.cleanDeep) {
                filter = func.cleanDeep(filter)
            }

            // if filter is empty, throw error
            if (func.isEmpty(filter)) {
                throw new AppError('Filter is empty', { code: 'FILTER_EMPTY', status: 400 })
            }


            this._validate({ collection, action: action, update: update.$set })
            this._validate({ collection, action: action, update: update.$setOnInsert })
            update = func.toBson(update, { col })
            filter = func.toBson(filter, { col })

            const meta: any = { action, collection, filter, update }
            if (col.hooks?.beforeOperation) {
                await col.hooks.beforeOperation({ rest: this, io, action, meta })
            }

            const data = await this.db.collection(collection).findOneAndUpdate(
                filter,
                {
                    ...(update as any),

                },
                { session: this.session, returnDocument: 'after', upsert: options?.upsert ?? false }
            )

            const result = func.toJson(data)
            meta.result = result

            if (col.hooks?.afterOperation) {
                await col.hooks.afterOperation({ rest: this, io, action, meta })
            }

            return result as Document | null
        })
    }

    @LogSlowQuery()
    @CheckIfCollectionExists()
    @CheckIfArrayOfIds('updateMany')
    async updateMany(collection: string, _ids: string[], update: UpdateFilter<any>): Promise<UpdateResult> {
        const action = 'updateMany' as ActionsApiList
        return this.#executeWithAudit(action, collection, { ids: _ids, update }, async () => {
            const col = getCollection(collection, this.#tenant.id) as Collection

            if (update.$set) {
                update.$set = await func.buildInput(update.$set, { action: action, col: col })
            }
            update = await func.buildInput(update)
            this._validate({ collection, action: action, update: update })
            update = func.toBson(update, { col })

            const meta: any = { action, collection, update, ids: _ids }
            if (col.hooks?.beforeOperation) {
                await col.hooks.beforeOperation({ rest: this, io, action, meta })
            }

            const result = await this.db.collection(collection).updateMany(
                { _id: { $in: _ids.map(id => new ObjectId(id)) } },
                { ...(update as any) },
                { session: this.session }
            )
            meta.result = result

            if (col.hooks?.afterOperation) {
                await col.hooks.afterOperation({ rest: this, io, action, meta })
            }

            return result as UpdateResult
        })
    }

    @LogSlowQuery()
    @CheckIfCollectionExists()
    @CheckIfId('deleteOne')
    async deleteOne(collection: string, _id: string) {
        const action = 'deleteOne' as ActionsApiList
        return this.#executeWithAudit(action, collection, { id: _id }, async () => {
            const col = getCollection(collection, this.#tenant.id) as Collection

            const meta: any = { action, collection, id: _id }
            if (col.hooks?.beforeOperation) {
                await col.hooks.beforeOperation({ rest: this, io, action, meta })
            }

            let result = await this.db.collection(collection).findOneAndDelete(
                { _id: new ObjectId(_id) },
                { session: this.session }
            )
            result = func.toJson(result)
            meta.result = result

            if (col.hooks?.afterOperation) {
                await col.hooks.afterOperation({ rest: this, io, action, meta })
            }

            return result
        })
    }


    @LogSlowQuery()
    @CheckIfCollectionExists()
    @CheckIfArrayOfIds('deleteMany')
    async deleteMany(collection: string, _ids: string[]): Promise<DeleteResult> {
        const action = 'deleteMany' as ActionsApiList
        return this.#executeWithAudit(action, collection, { ids: _ids }, async () => {
            const col = getCollection(collection, this.#tenant.id) as Collection

            const meta: any = { action, collection, ids: _ids }
            if (col.hooks?.beforeOperation) {
                await col.hooks.beforeOperation({ rest: this, io, action, meta })
            }

            let result: DeleteResult = await this.db.collection(collection).deleteMany(
                { _id: { $in: _ids.map(id => new ObjectId(id)) } },
                { session: this.session }
            )
            result = func.toJson(result) as DeleteResult
            meta.result = result

            if (col.hooks?.afterOperation) {
                await col.hooks.afterOperation({ rest: this, io, action, meta })
            }

            return result
        })
    }


    @LogSlowQuery()
    @CheckIfCollectionExists()
    @CheckBulkWriteOperations()
    async bulkWrite(collection: string, operations: AnyBulkWriteOperation[], options?: BulkWriteOptions): Promise<BulkWriteResult> {
        const action = 'bulkWrite' as ActionsApiList
        return this.#executeWithAudit(action, collection, { count: operations.length }, async () => {
            for (let operation of operations) {
                const col = getCollection(collection, this.#tenant.id) as Collection

                if ('insertOne' in operation) {
                    operation.insertOne.document = func.toBson(
                        await func.buildInput(operation.insertOne.document, { action: 'insertOne', col }),
                        { col },
                    )
                }
                if ('updateOne' in operation) {
                    operation.updateOne.filter = func.toBson(
                        await func.buildInput(operation.updateOne.filter, { action: 'updateOne', col }),
                        { col },
                    )
                    const updateOneDoc = operation.updateOne.update as UpdateFilter<Document>
                    if (updateOneDoc.$set) {
                        updateOneDoc.$set = await func.buildInput(updateOneDoc.$set, { action: 'updateOne', col })
                    }
                    operation.updateOne.update = func.toBson(operation.updateOne.update, { col })
                }
                if ('updateMany' in operation) {
                    operation.updateMany.filter = func.toBson(
                        await func.buildInput(operation.updateMany.filter, { action: 'updateMany', col }),
                        { col },
                    )
                    const updateManyDoc = operation.updateMany.update as UpdateFilter<Document>
                    if (updateManyDoc.$set) {
                        updateManyDoc.$set = await func.buildInput(updateManyDoc.$set, { action: 'updateMany', col })
                    }
                    operation.updateMany.update = func.toBson(operation.updateMany.update, { col })
                }
                if ('replaceOne' in operation) {
                    operation.replaceOne.replacement = func.toBson(
                        await func.buildInput(operation.replaceOne.replacement, { action: 'replaceOne', col }),
                        { col },
                    )
                }
                if ('deleteOne' in operation) {
                    operation.deleteOne.filter = func.toBson(
                        await func.buildInput(operation.deleteOne.filter, { action: 'deleteOne', col }),
                        { col },
                    )
                }
                if ('deleteMany' in operation) {
                    operation.deleteMany.filter = func.toBson(
                        await func.buildInput(operation.deleteMany.filter, { action: 'deleteMany', col }),
                        { col },
                    )
                }
            }

            const result = await this.db.collection(collection).bulkWrite(operations, {
                session: this.session,
                ...options,
            })

            return result
        })
    }


    @LogSlowQuery()
    @CheckIfCollectionExists()
    async bulkUpdate(collection: string, operations: BulkUpdateOperation[], options?: BulkWriteOptions): Promise<BulkWriteResult> {
        const action = 'bulkUpdate' as ActionsApiList
        return this.#executeWithAudit(action, collection, { count: operations.length }, async () => {
            const col = getCollection(collection, this.#tenant.id) as Collection

            for (const operation of operations) {
                if ('updateOne' in operation) {
                    const update = operation.updateOne.update as UpdateFilter<Document>
                    if (update.$set) {
                        update.$set = await func.buildInput(update.$set, { action: 'updateOne', col })
                    }
                    operation.updateOne.update = func.toBson(operation.updateOne.update, { col })
                }
                if ('updateMany' in operation) {
                    const update = operation.updateMany.update as UpdateFilter<Document>
                    if (update.$set) {
                        update.$set = await func.buildInput(update.$set, { action: 'updateMany', col })
                    }
                    operation.updateMany.update = func.toBson(operation.updateMany.update, { col })
                }
            }

            const result = await this.db.collection(collection).bulkWrite(operations, {
                session: this.session,
                ...options,
            })

            return result
        })
    }



    @LogSlowQuery()
    @CheckIfCollectionExists()
    async countDocuments(collection: string, query: any = {}): Promise<number> {
        const action = 'countDocuments' as ActionsApiList
        return this.#executeWithAudit(action, collection, { query }, async () => {
            // ⚠️ must pass the filter — countDocuments() without args counts the whole collection
            return await this.db.collection(collection).countDocuments(query)
        })
    }

    @CheckIfCollectionExists()
    async dropCollection(collection: string) {
        const action = 'dropCollection' as ActionsApiList
        return this.#executeWithAudit(action, collection, undefined, async () => {
            return await this.db.collection(collection).drop()
        })
    }

    @CheckIfCollectionExists()
    async dropIndex(collection: string, index: string) {
        const action = 'dropIndex' as ActionsApiList
        return this.#executeWithAudit(action, collection, { index }, async () => {
            return await this.db.collection(collection).dropIndex(index)
        })
    }

    @CheckIfCollectionExists()
    async dropIndexes(collection: string) {
        const action = 'dropIndexes' as ActionsApiList
        return this.#executeWithAudit(action, collection, undefined, async () => {
            return await this.db.collection(collection).dropIndexes()
        })
    }

    async runAction<T = any>(collection: string, action: string, data?: any): Promise<T> {
        const col = getCollection(collection, this.#tenant.id)
        if (!col) {
            throw new AppError(`Collection '${collection}' not found`, { code: 'COLLECTION_NOT_FOUND', status: 500 })
        }

        if (!Object.hasOwn(col?.actions ?? {}, action)) {
            throw new AppError(`Action '${action}' not found on collection '${collection}'`, { code: 'ACTION_NOT_FOUND', status: 500 })
        }

        const token = requestCtxStorage.get<{ value: string | null, decoded: Record<string, unknown> | null, provided: boolean, expired: boolean }>('token')

        return await col.actions?.[action]?.({
            rest: this,
            io,
            data,
            error: fn.error,
            jwt: func.jwt,
            token: token ?? { value: null, decoded: null, provided: false, expired: false },
        } as any)
    }

    async runService<T = any>(service: string, action: string, data?: any): Promise<T> {
        const serviceInstance = cfg.services?.find(s => s.name === service && s._tenant_ === this.tenant_id) as Service | undefined
        if (!serviceInstance) {
            throw new AppError(`Service '${service}' not found`, { code: 'SERVICE_NOT_FOUND', status: 500 })
        }
        if (!serviceInstance.enabled) {
            throw new AppError(`Service '${service}' is not enabled`, { code: 'SERVICE_NOT_ENABLED', status: 500 })
        }
        if (!Object.hasOwn(serviceInstance.actions, action) || !serviceInstance.actions?.[action]) {
            throw new AppError(`Action '${action}' not found on service '${service}'`, { code: 'SERVICE_ACTION_NOT_FOUND', status: 500 })
        }

        const token = requestCtxStorage.get<{ value: string | null, decoded: Record<string, unknown> | null, provided: boolean, expired: boolean }>('token')

        return await serviceInstance.actions?.[action]?.({
            data,
            error: fn.error,
            io,
            jwt: func.jwt,
            token: token ?? { value: null, decoded: null, provided: false, expired: false },
            rest: this,
        } as any)
    }

    async stats() {
        try {
            return await this.db.stats()
        } catch (err: any) {
            throw err instanceof AppError ? err : new AppError(err?.message || 'Internal server error', { code: 'INTERNAL_API_ERROR', status: 500 })
        }
    }

    /**
     * List workflow runs from the _workflows_ collection with filtering.
     * Works like find() but targets the _workflows_ collection by default.
     */
    async workflows(params: FindOptions = {}): Promise<Document[]> {
        try {
            let pipeline = func.buildPipeline(params)
            pipeline = await func.buildInput(pipeline, { rest: this })
            pipeline = func.toBson(pipeline)

            let result = await this.db.collection('_workflows_').aggregate(pipeline, {
                session: this.session,
                allowDiskUse: true,
            }).toArray()
            result = func.toJson(result)
            return result as any[]
        } catch (err: any) {
            throw err instanceof AppError ? err : new AppError(err?.message || 'Internal server error', { code: 'INTERNAL_API_ERROR', status: 500 })
        }
    }

    startTransaction() {
        if (!this.session) this.session = this.startSession()
        this.session.startTransaction()
    }

    async commitTransaction() {
        if (this.session) {
            await this.session.commitTransaction()
            await this.session.endSession()
            this.session = undefined as any
        }
    }

    async abortTransaction() {
        if (this.session) {
            const session = this.session
            try {
                await session.abortTransaction()
            } finally {
                await session.endSession()
                this.session = undefined as any
            }
        }
    }


    startSession(): ClientSession {
        let session = this.client.startSession()
        this.session = session
        return session
    }

    async endSession(): Promise<void> {
        if (this.session) {
            await this.session.endSession()
            this.session = undefined as any
        }
    }

    startTrace(traceId?: string, extra?: { comment?: string; tag?: string; version?: string }) {
        requestCtxStorage.set('trace', {
            id: traceId ?? crypto.randomUUID(),
            comment: extra?.comment,
            tag: extra?.tag,
            version: extra?.version,
        })
    }

    unsetTrace() {
        requestCtxStorage.delete('trace')
    }

    get audit() {
        return {
            addActivities: async (activities: ActivityInput[]) => {
                await this.db.collection('_activities_').insertMany(activities)
                    .then(e => e)
                    .catch(err => {
                        console.error('Error inserting activities', err)
                    })
            },
            getActivities: async (opts = {
                $match: {},
                $limit: 100
            }) => {

                let pipeline = func.buildPipeline(opts)
                return await this.db.collection('_activities_').aggregate(pipeline).toArray()
            }
        }
    }

    /**
     * Acquire a distributed lock for this tenant.
     * Uses MongoDB atomic findOneAndUpdate with upsert.
     * Only one node in a cluster can hold the lock at a time.
     * Returns true if the lock was acquired, false otherwise.
     */
    async lock(name: string, ttlMs = 300_000): Promise<void> {
        const now = Date.now();
        const expiresAt = now + ttlMs;
        const id = `${this.tenant_id}:${name}`;

        try {
            const result = await this.db.collection('_locks_').findOneAndUpdate(
                { _id: id as any, expiresAt: { $lt: now } },
                { $set: { tid: this.tenant_id, name, acquiredAt: now, expiresAt } },
                { upsert: true, returnDocument: 'after' }
            );
            if (!result) {
                throw new AppError(`Lock '${name}' is already held by another node`, {
                    code: 'LOCK_ACQUISITION_FAILED',
                    status: 409
                });
            }
        } catch (err: any) {
            if (err instanceof AppError) throw err;
            // E11000 duplicate key = another node holds a valid lock
            if (err?.code === 11000) {
                throw new AppError(`Lock '${name}' is already held by another node`, {
                    code: 'LOCK_ACQUISITION_FAILED',
                    status: 409
                });
            }
            throw err;
        }
    }

    /**
     * Release a distributed lock.
     */
    async unlock(name: string): Promise<void> {
        await this.db.collection('_locks_').deleteOne({
            tid: this.tenant_id,
            name,
        });
    }

    /**
     * Workflow engine — run, pause, resume, cancel workflows.
     * Usage: rest.workflow.run('transfert', data)
     */
    get workflow() {
        return createWorkflow(this.tenant_id);
    }

}

export { MongoRest }
