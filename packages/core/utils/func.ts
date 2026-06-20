import { ObjectId } from 'mongodb';
import type { RestActions } from '../types/rest';
import type { FindOptions } from '../types/mongo';
import type { Collection } from '../types/collection';
import { useRest } from '../database/rest';
import { MongoRest } from '../database/mongodbadapter';
import type { Field } from '../types/field';
import type { ActionsApiList } from '../types/api';
import * as Jose from "jose"
import { cfg } from '../server/config';
import { AppError } from '../lib/error';
type DeepRecord = Record<string, unknown>;


const jwt = {
    sign: async (payload: Record<string, unknown>, options?: {
        expiresIn?: string;
        issuer?: string;
        audience?: string | string[];
        subject?: string;
    }) => {
        let SECRET_ = cfg.server.jwt?.secret || Bun.env.JWT_SECRET
        if (!SECRET_) throw new Error('JWT_SECRET is not set');
        let EXPIRES_IN = cfg.server.jwt?.expiresIn || '1h'

        const secret = new TextEncoder().encode(SECRET_);
        const signer = new Jose.SignJWT(payload)
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime(EXPIRES_IN || '1h')

        if (options?.issuer) signer.setIssuer(options.issuer)
        if (options?.audience) signer.setAudience(options.audience)
        if (options?.subject) signer.setSubject(options.subject)

        const token = await signer.sign(secret);
        return token;
    },
    verify: async (token: string): Promise<{ value: Record<string, unknown> | null, error: string | null }> => {
        try {
            if (!token) throw new Error('Token is required');
            let SECRET_ = cfg.server.jwt?.secret || Bun.env.JWT_SECRET
            if (!SECRET_) throw new Error('JWT_SECRET is not set');
            const secret = new TextEncoder().encode(SECRET_);
            const { payload, protectedHeader } = await Jose.jwtVerify(token, secret);
            return {
                value: payload,
                error: null
            }
        } catch (error) {
            return {
                value: null,
                error: error instanceof Error ? error.message : 'Invalid token'
            }
        }
    }
}


function getDeep(obj: DeepRecord, path: string): unknown {
    return path.split('.').reduce<unknown>((curr, key) =>
        curr && typeof curr === 'object' ? (curr as DeepRecord)[key] : undefined, obj);
}

function setDeep(obj: DeepRecord, path: string, value: unknown): void {
    const keys = path.split('.');
    const lastKey = keys.pop()!;
    const target = keys.reduce<DeepRecord>((curr, key) => {
        if (!(key in curr) || typeof curr[key] !== 'object') {
            curr[key] = {};
        }
        return curr[key] as DeepRecord;
    }, obj);
    target[lastKey] = value;
}

function deleteDeep(obj: DeepRecord, path: string): void {
    const keys = path.split('.');
    const lastKey = keys.pop()!;
    const target = keys.reduce<DeepRecord | undefined>((curr, key) =>
        curr && typeof curr === 'object' ? (curr as DeepRecord)[key] as DeepRecord : undefined, obj);
    if (target && typeof target === 'object') {
        delete target[lastKey];
    }
}

function reorder<T extends DeepRecord>(data: T, fieldOrder: string[]): T {
    const ordered: DeepRecord = {};
    for (const key of fieldOrder) {
        if (key in data) {
            ordered[key] = data[key];
        }
    }
    for (const key of Object.keys(data)) {
        if (!(key in ordered)) {
            ordered[key] = data[key];
        }
    }
    return ordered as T;
}

function omitDeep(obj: DeepRecord, matchers: ((key: string) => boolean)[], fieldOrder?: string[]): DeepRecord {
    for (const key of Object.keys(obj)) {
        if (matchers.some(m => m(key))) {
            delete obj[key];
            continue;
        }
        const value = obj[key];
        if (Array.isArray(value)) {
            obj[key] = value.map(item =>
                item && typeof item === 'object' && !Array.isArray(item)
                    ? omitDeep(item as DeepRecord, matchers, fieldOrder)
                    : item
            );
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
            obj[key] = omitDeep(value as DeepRecord, matchers, fieldOrder);
        }
    }
    return fieldOrder ? reorder(obj, fieldOrder) : obj;
}

function omit<T extends DeepRecord>(data: T | T[], keys: (string | RegExp)[], fieldOrder?: string[]): Partial<T> | Partial<T>[] {
    if (data === null || data === undefined) return data as any;

    const matchers = keys.map(k =>
        k instanceof RegExp
            ? (key: string) => k.test(key)
            : (key: string) => key === k
    );

    if (Array.isArray(data)) {
        return data.map(item => {
            const result = clone(item) as DeepRecord;
            return omitDeep(result, matchers, fieldOrder) as Partial<T>;
        });
    }
    const result = clone(data) as DeepRecord;
    return omitDeep(result, matchers, fieldOrder) as Partial<T>;
}

function pick<T extends DeepRecord>(data: T | T[], keys: string[]): Partial<T> | Partial<T>[] {
    if (Array.isArray(data)) {
        return data.map(item => pick(item, keys) as Partial<T>);
    }
    const result: DeepRecord = {};
    for (const key of keys) {
        const value = getDeep(data, key);
        if (value !== undefined) {
            setDeep(result, key, value);
        }
    }
    return result as Partial<T>;
}

function toJson<T>(data: any): T {
    if (data === null || data === undefined) return data;
    try {
        return JSON.parse(JSON.stringify(data, (key, value) =>
            value instanceof ObjectId ? value.toHexString() : value
        ));
    } catch (error) {
        console.error('toJson failed:', error);
        return data;
    }
}

function stringToBoolean(value: string): boolean {
    // convert string to boolean
    // convert value in lowercase
    value = value.toLowerCase();
    return value === 'true';
}

function isEmpty(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (value === '') return true;
    if (Array.isArray(value) && value.length === 0) return true;
    if (typeof value === 'object' && Object.keys(value).length === 0) return true;
    return false;
}

function cleanDeep<T extends DeepRecord | DeepRecord[]>(data: T): Partial<T> {
    if (Array.isArray(data)) {
        const cleaned = data
            .map(item => cleanDeep(item))
            .filter(item => !isEmpty(item));
        return cleaned as unknown as Partial<T>;
    }

    const result: DeepRecord = {};
    for (const key of Object.keys(data)) {
        let value = data[key];

        if (value !== null && value !== undefined) {
            if (Array.isArray(value)) {
                value = value
                    .map(item => typeof item === 'object' && item !== null ? cleanDeep(item as DeepRecord) : item)
                    .filter(item => !isEmpty(item));
            } else if (typeof value === 'object') {
                value = cleanDeep(value as DeepRecord);
            }

            if (!isEmpty(value)) {
                result[key] = value;
            }
        }
    }
    return result as Partial<T>;
}

function isDate(value: string): boolean {
    if (!value || typeof value !== 'string') return false;
    const trimmed = value.trim();
    // Chaînes 100 % chiffres : seuls timestamps UNIX s (10) ou ms (13) — sinon codes type "170273" seraient des dates via `new Date("170273")`.
    if (/^\d+$/.test(trimmed)) {
        const len = trimmed.length;
        if (len !== 10 && len !== 13) return false;
        const ms = new Date(Number(trimmed)).getTime();
        return !isNaN(ms);
    }
    const date = new Date(trimmed);
    return !isNaN(date.getTime());
}

/** Aligné sur `isDate` : `new Date("1438839831092")` est NaN, il faut passer par `Number`. */
function stringToDate(value: string): Date {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
        const len = trimmed.length;
        if (len === 10 || len === 13) {
            return new Date(Number(trimmed));
        }
    }
    return new Date(trimmed);
}

/** Nombre entier type timestamp UNIX (s ou ms), ex. `1438839831092`. */
function isEpochNumber(value: number): boolean {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    const int = Math.trunc(value);
    if (int !== value) return false;
    const s = String(Math.abs(int));
    if (s.length !== 10 && s.length !== 13) return false;
    return !isNaN(new Date(int).getTime());
}

function deepCopy<T>(value: T): T {
    return clone(value);
}

type FormatToDateResult<T> = T extends string
    ? Date | string
    : T extends (infer U)[]
    ? FormatToDateResult<U>[]
    : T extends object
    ? { [K in keyof T]: FormatToDateResult<T[K]> }
    : T;

/** Options pour filtrer les chemins ; sans options, tout ce qui passe `isDate` est converti en `Date`. */
type FormatToDateOptions = {
    /** Noms de champs (notation pointée) à ne pas convertir ; correspondance exacte ou suffixe (ex. `$set.createdAt`). */
    omitKeys?: string[];
    /** Si défini et non vide : seuls ces champs sont convertis (équivalent à « tout sauf les non-date »). Correspondance exacte ou suffixe de chemin. */
    includeKeys?: string[];
};

function joinFormatToDatePath(parent: string, segment: string | number): string {
    const s = String(segment);
    return parent === '' ? s : `${parent}.${s}`;
}

/** Correspond à un nom de champ schéma (`createdAt`, `user.birthDate`) y compris en profondeur (`$set.createdAt`). */
function pathMatchesFieldKey(path: string, key: string): boolean {
    return path === key || path.endsWith('.' + key);
}

function shouldFormatDateAtPath(path: string, options?: FormatToDateOptions): boolean {
    // Aucune option → convertir partout où `isDate` est vrai
    if (!options) return true;
    if (options.omitKeys?.some((k) => pathMatchesFieldKey(path, k))) return false;
    // Whitelist seulement si includeKeys est un tableau non vide
    if (options.includeKeys && options.includeKeys.length > 0) {
        return options.includeKeys.some((k) => pathMatchesFieldKey(path, k));
    }
    return true;
}

function formatToDate(data: any, options?: FormatToDateOptions, path = ''): any {
    if (data === null || data === undefined) return data;
    if (data instanceof Date) return data;
    if (data instanceof ObjectId) return data;

    if (Array.isArray(data)) {
        return data.map((item, i) => {
            const p = joinFormatToDatePath(path, i);
            return formatToDate(item, options, p);
        });
    }

    if (typeof data === 'object') {
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(data)) {
            const p = joinFormatToDatePath(path, key);
            const value = (data as Record<string, unknown>)[key];
            if (typeof value === 'string' && isDate(value)) {
                if (shouldFormatDateAtPath(p, options)) {
                    result[key] = stringToDate(value);
                } else {
                    result[key] = value;
                }
            } else if (typeof value === 'number' && isEpochNumber(value)) {
                if (shouldFormatDateAtPath(p, options)) {
                    result[key] = new Date(value);
                } else {
                    result[key] = value;
                }
            } else {
                result[key] = formatToDate(value, options, p);
            }
        }
        return result;
    }

    return data;
}

function isObjectId(value: string): boolean {
    let isValid = typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value) && ObjectId.isValid(value);

    return isValid;
}

type FormatToObjectIdResult<T> = T extends string
    ? ObjectId | string
    : T extends (infer U)[]
    ? FormatToObjectIdResult<U>[]
    : T extends object
    ? { [K in keyof T]: FormatToObjectIdResult<T[K]> }
    : T;

function formatToObjectId<T>(value: T): FormatToObjectIdResult<T> {
    if (value === null || value === undefined) {
        return value as FormatToObjectIdResult<T>;
    }



    if (typeof value === 'string') {

        if (isObjectId(value)) {
            return new ObjectId(value) as FormatToObjectIdResult<T>;
        }
        return value as FormatToObjectIdResult<T>;
    }

    if (Array.isArray(value) && typeof value === 'object') {

        return value.map(item => formatToObjectId(item)) as FormatToObjectIdResult<T>;
    }

    if (typeof value === 'object' && !Array.isArray(value)) {

        if (value instanceof ObjectId) {
            return value as FormatToObjectIdResult<T>;
        }

        const result: Record<string, unknown> = {};
        for (const key of Object.keys(value)) {
            result[key] = formatToObjectId((value as Record<string, unknown>)[key]);
        }
        return result as FormatToObjectIdResult<T>;
    }

    return value as FormatToObjectIdResult<T>;
}

export type GenerateRandomOptions = {
    length: number;
    useLetters?: boolean;
    useNumbers?: boolean;
    includeSymbols?: string;
    excludeSymbols?: string;
    startWith?: string;
    endWith?: string;
    toLowerCase?: boolean;
    toUpperCase?: boolean;
    toNumber?: boolean;
}
async function generateRandom(options: GenerateRandomOptions, ctx: {
    col?: Collection,
    rest?: MongoRest,
    field?: Field
}, _attempts = 0): Promise<string | number> {
    if (_attempts > 10) {
        throw new AppError('Unable to generate unique random value after 10 attempts', {
            code: 'RANDOM_GENERATION_FAILED', status: 500
        });
    }
    const {
        length,
        useLetters = false,
        useNumbers = true,
        includeSymbols = '',
        excludeSymbols = '',
        startWith = '',
        endWith = '',
        toLowerCase = false,
        toUpperCase = false,
        toNumber = false
    } = options;

    const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const numbers = '0123456789';

    let charset = '';
    if (useLetters) charset += letters;
    if (useNumbers) charset += numbers;
    if (includeSymbols) charset += includeSymbols;

    if (excludeSymbols) {
        for (const symbol of excludeSymbols) {
            charset = charset.split(symbol).join('');
        }
    }

    if (charset.length === 0) {
        charset = letters + numbers;
    }

    let result = '';

    for (let i = 0; i < length; i++) {
        const randomIndex = Math.floor(Math.random() * charset.length);
        result += charset[randomIndex];
    }

    result = startWith + result + endWith;

    if (toLowerCase) {
        result = result.toLowerCase();
    } else if (toUpperCase) {
        result = result.toUpperCase();
    }

    if (toNumber) {
        return parseInt(result, 10) || 0;
    }



    if (ctx?.col && ctx.field && ctx.rest) {
        let foundItem = await ctx.rest.find(ctx.col.slug, {
            $match: {
                [ctx.field.name]: result
            }
        })
        if (foundItem.length > 0) {
            return generateRandom(options, ctx, _attempts + 1)
        }
    }

    return result;
}


type FormatInputOptions = {
    action?: ActionsApiList;
    col?: Collection
    rest?: MongoRest
}

async function buildInput<T>(data: any | any[], options?: FormatInputOptions): Promise<T> {

    data = toJson(data)
    let currentDate = new Date().toISOString()





    // Field specification formatting
    for (const f of options?.col?.fields || []) {
        let dataValue = data[f.name]
        let fieldName = f.name
        let fieldType = f.type


        /* Set Default Value For Insert */
        if (options?.action?.match(/(insert)/)) {
            if (Object.hasOwn(f, 'defaultValue') && !dataValue) {
                data[fieldName] = f.defaultValue
            }
        }



        // Set Password Hash For action:Insert | action:Update
        if (options?.action?.match(/(insert|update)/)) {



            /* Set Password Hash For Single */
            if (fieldType == 'password' && dataValue) {
                data[fieldName] = Bun.password.hashSync(dataValue)
            }
        }

        // Set Id on relationship fields
        if (fieldType == 'relationship' && dataValue && !f.relation?.hasMany) {
            data[fieldName] = dataValue._id || dataValue;
        }

        if (fieldType == 'relationship' && dataValue && f.relation?.hasMany) {
            data[fieldName] = dataValue.map((item: any) => item._id || item);
        }



        //** Generate Random For Random Fields */
        if (fieldType == 'random' && f.randomOptions && options?.action?.match(/(insert)/)) {
            data[fieldName] = await generateRandom(f.randomOptions, {
                rest: options?.rest,
                col: options?.col,
                field: f
            })
        }

    }
    /* Set Created At And Updated At For action:Insert */
    if (options?.action?.match(/(insert)/)) {
        if (!Array.isArray(data)) {
            data['createdAt'] = currentDate
            data['updatedAt'] = currentDate

        } else {
            data?.map(item => {
                item['createdAt'] = currentDate
                item['updatedAt'] = currentDate
            })
        }
    }


    /* Set Updated At For  action:Update */
    if (options?.action?.match(/(update)/)) {

        data['updatedAt'] = currentDate
    }


    return data
}

function collectDateFieldPathsFromCollection(col: Collection): string[] {
    const paths = new Set<string>();
    for (const f of col.fields) {
        if (f.type === 'date' || f.type === 'datetime-local') {
            paths.add(f.name);
        }
    }
    paths.add('createdAt');
    paths.add('updatedAt');
    return [...paths];
}

function toBson<T>(data: any | any[], options?: FormatInputOptions): T {
    let data_ = formatToObjectId(data);
    const dateOpts: FormatToDateOptions | undefined =
        options?.col !== undefined
            ? { includeKeys: collectDateFieldPathsFromCollection(options.col) }
            : undefined;
    data_ = formatToDate(data_, dateOpts);

    if (Array.isArray(data)) {
        data.length = 0;
        data.push(...data_);
    } else {
        Object.assign(data, data_);
    }
    return data;
}

function buildPipeline(p: FindOptions, options?: {
    col: Collection
}) {

    let pipeline = []
    // $Match
    if (p?.$match) {
        const FORBIDDEN_MATCH_KEYS = ['$where', '$expr', '$accumulator', '$function'];
        const forbiddenFound = hasUnauthorizedKeys(p.$match, FORBIDDEN_MATCH_KEYS);
        if (forbiddenFound.length > 0) {
            throw new AppError('Unauthorized match keys: ' + forbiddenFound.join(', '), {
                code: 'UNAUTHORIZED_MATCH_KEYS',
                status: 400
            });
        }
        pipeline.push({
            $match: p.$match
        })
    }

    // $sort
    if (!p?.$sort?.createdAt) {
        pipeline.push({
            $sort: {
                ...p.$sort,
                createdAt: -1,
            }
        })
    } else {
        pipeline.push({
            $sort: p.$sort
        })
    }

    // $skip
    if (p?.$skip) {
        pipeline.push({
            $skip: p.$skip
        })
    }

    // $limit
    p.$limit = p?.$limit ?? 100
    if (p?.$limit > 0) {
        pipeline.push({
            $limit: p.$limit
        })
    }

    // $include
    if (p?.$include && Array.isArray(p?.$include)) {

        for (const include of p?.$include) {
            if (typeof include === 'string') {
                let f = options?.col.fields.find(f => f.name === include)

                if (!f) {
                    throw new AppError(`Field '${include}' not found in collection '${options?.col.slug}'`, {
                        code: 'INCLUDE_FIELD_NOT_FOUND',
                        status: 400
                    })
                }

                if (f.type !== 'relationship') {
                    throw new AppError(`Field '${include}' is not a relationship type`, {
                        code: 'INCLUDE_FIELD_NOT_RELATIONSHIP',
                        status: 400
                    })
                }

                pipeline.push({
                    $lookup: {
                        from: f?.relation?.to,
                        localField: include || f?.name,
                        foreignField: '_id',
                        as: include
                    }
                })
                if (!f?.relation?.hasMany) {
                    pipeline.push({
                        $unwind: {
                            path: '$' + (include || f?.name),
                            preserveNullAndEmptyArrays: true,
                        }
                    })
                }
            } else {
                let f = options?.col.fields.find(f => f.name === include.localField)

                if (!f) {
                    throw new AppError(`localField '${include.localField}' not found in collection '${options?.col.slug}'`, {
                        code: 'INCLUDE_LOCALFIELD_NOT_FOUND',
                        status: 400
                    })
                }

                if (f.type !== 'relationship') {
                    throw new AppError(`localField '${include.localField}' is not a relationship type`, {
                        code: 'INCLUDE_LOCALFIELD_NOT_RELATIONSHIP',
                        status: 400
                    })
                }

                if (include.from !== f.relation?.to) {
                    throw new AppError(`'from' must be '${f.relation?.to}' for localField '${include.localField}'`, {
                        code: 'INCLUDE_FROM_MISMATCH',
                        status: 400
                    })
                }

                let as = include.as || include.localField

                pipeline.push({
                    $lookup: {
                        from: include.from,
                        localField: include.localField,
                        foreignField: include.foreignField,
                        pipeline: include.pipeline,
                        let: include.let,
                        as: as
                    }
                })
                if (!include.unwind) {
                    pipeline.push({
                        $unwind: {
                            path: '$' + as,
                            preserveNullAndEmptyArrays: true,
                        }
                    })
                }
            }

        }

    }



    // $lookup — must use $include (validated against collection schema)
    if (p?.$lookup) {
        throw new AppError('Direct $lookup is not allowed. Use $include instead.', {
            code: 'UNAUTHORIZED_PIPELINE_KEYS',
            status: 400
        });
    }

    // $graphLookup — not supported via params
    if (p?.$graphLookup) {
        throw new AppError('$graphLookup is not allowed via query params.', {
            code: 'UNAUTHORIZED_PIPELINE_KEYS',
            status: 400
        });
    }

    // $project
    if (p?.$project) {
        pipeline.push({
            $project: protectFieldRenameOnProject(p.$project),
        })
    }



    return pipeline || []
}

function clone<T>(data: T): T {
    let data_ = data;
    // Use structured clone to clone the data
    try {
        data_ = structuredClone(toJson(data_))
    } catch (error) {
        data_ = toJson(data_)
    }
    return data_
}




//slugify function
function slugify(text: string): string {
    return text
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/[\s_]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}


/**
 * Parcourt récursivement `data` (objet ou tableau, profondeur quelconque)
 * et retourne les clés de `keys` qui apparaissent au moins une fois comme
 * nom de propriété propre (own key) d'un objet.
 * @param data - L'objet ou le tableau à inspecter.
 * @param keys - Les clés prohibées à rechercher.
 * @returns Un tableau des clés prohibées trouvées.
 */
function hasUnauthorizedKeys(data: unknown, keys: string[]): string[] {
    const found = new Set<string>();
    const forbidden = new Set(keys);

    function walk(node: unknown): void {
        if (node === null || node === undefined || typeof node !== 'object') {
            return;
        }

        if (Array.isArray(node)) {
            for (const item of node) {
                walk(item);
            }
            return;
        }

        const obj = node as Record<string, unknown>;
        for (const key of Object.keys(obj)) {
            if (forbidden.has(key)) {
                found.add(key);
            }
            walk(obj[key]);
        }
    }

    walk(data);
    return [...found];
}

interface PaginationResult<T> {
    data: T[];
    total: number;
    perPage: number;
    totalPages: number;
    currentPage: number;
    from: number;
    to: number;
    hasNext: boolean;
    hasPrev: boolean;
}

function paginate<T>(array: T[], options: { page?: number; perPage?: number } = {}): PaginationResult<T> {
    const total = array.length;
    const perPage = Math.max(1, options.perPage ?? 25);
    const totalPages = Math.ceil(total / perPage) || 1;
    const currentPage = Math.min(Math.max(1, options.page ?? 1), totalPages);
    const start = (currentPage - 1) * perPage;
    const data = array.slice(start, start + perPage);

    return {
        data,
        total,
        perPage,
        totalPages,
        currentPage,
        from: total === 0 ? 0 : start + 1,
        to: start + data.length,
        hasNext: currentPage < totalPages,
        hasPrev: currentPage > 1,
    };
}


function isAggregationFieldPathRef(value: unknown): value is string {
    return typeof value === 'string' && value.startsWith('$') && !value.startsWith('$$');
}

/** Carte des clés de sortie → ref source pour tout renommage illicite (`out !==` dernier segment du chemin). */
function getProjectFieldRenames(project: unknown): Record<string, string> {
    const renames: Record<string, string> = {};
    if (!project || typeof project !== 'object' || Array.isArray(project)) {
        return renames;
    }
    for (const [outputKey, val] of Object.entries(project as Record<string, unknown>)) {
        if (!isAggregationFieldPathRef(val)) {
            continue;
        }
        const sourcePath = val.slice(1);
        const leaf = sourcePath.includes('.')
            ? sourcePath.slice(sourcePath.lastIndexOf('.') + 1)
            : sourcePath;
        if (outputKey !== leaf) {
            renames[outputKey] = val;
        }
    }
    return renames;
}

/**
 * Vérifie les entrées `$project` qui renomment un champ via une référence de chemin
 * Mongo (valeur string `"$..."`), ex. `{ pw: "$password" }`.
 *
 * On considère qu'il y a « renommage » lorsque la clé de sortie diffère du dernier
 * segment du chemin source (`password` pour `$password`, `email` pour `user.email`).
 * @throws AppError 400 `UNAUTHORIZED_PROJECT_FIELD_RENAME` si un renommage est détecté
 */
function protectFieldRenameOnProject(project: unknown): Record<string, unknown> {
    if (!project || typeof project !== 'object' || Array.isArray(project)) {
        return {};
    }
    const obj = project as Record<string, unknown>;
    const renames = getProjectFieldRenames(obj);
    if (Object.keys(renames).length > 0) {
        throw new AppError('Unauthorized to rename field on $project', {
            status: 400,
            code: 'UNAUTHORIZED_PROJECT_FIELD_RENAME',
        }, { renames });
    }
    return obj;
}


/**
 * Parcourt récursivement un pipeline d'agrégation MongoDB (stages `$facet`,
 * `$lookup.pipeline`, `$unionWith.pipeline`, `$graphLookup.pipeline`).
 */
function walkAggregatePipeline(
    pipeline: unknown,
    visitor: (stage: Record<string, unknown>) => void,
): void {
    if (!Array.isArray(pipeline)) {
        return;
    }
    for (const stage of pipeline) {
        if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
            continue;
        }
        const s = stage as Record<string, unknown>;
        visitor(s);

        if (s.$facet && typeof s.$facet === 'object' && !Array.isArray(s.$facet)) {
            for (const sub of Object.values(s.$facet as Record<string, unknown>)) {
                if (Array.isArray(sub)) {
                    walkAggregatePipeline(sub, visitor);
                }
            }
        }

        if (s.$lookup && typeof s.$lookup === 'object' && !Array.isArray(s.$lookup)) {
            const l = s.$lookup as Record<string, unknown>;
            if (Array.isArray(l.pipeline)) {
                walkAggregatePipeline(l.pipeline, visitor);
            }
        }

        if (s.$unionWith && typeof s.$unionWith === 'object' && !Array.isArray(s.$unionWith)) {
            const u = s.$unionWith as Record<string, unknown>;
            if (Array.isArray(u.pipeline)) {
                walkAggregatePipeline(u.pipeline, visitor);
            }
        }

        if (s.$graphLookup && typeof s.$graphLookup === 'object' && !Array.isArray(s.$graphLookup)) {
            const g = s.$graphLookup as Record<string, unknown>;
            if (Array.isArray(g.pipeline)) {
                walkAggregatePipeline(g.pipeline, visitor);
            }
        }
    }
}


function countAggregatePipelineStages(pipeline: unknown): number {
    let n = 0;
    walkAggregatePipeline(pipeline, () => {
        n++;
    });
    return n;
}


function isSafeAggregatePipeline(pipeline: Array<Record<string, unknown>>): {
    isSafe: boolean;
    forbiddenKeys: string[];
    error: AppError | null;
} {

    // Unauthorized pipeline keys
    const UNAUTHORIZED_PIPELINE_KEYS = ['$out', '$merge', '$function', '$where', '$accumulator'];
    const forbiddenFound = hasUnauthorizedKeys(pipeline, UNAUTHORIZED_PIPELINE_KEYS);
    if (forbiddenFound.length > 0) {
        return {
            isSafe: false,
            forbiddenKeys: forbiddenFound,
            error: new AppError('Unauthorized pipeline keys: ' + forbiddenFound.join(', '), { code: 'UNAUTHORIZED_PIPELINE_KEYS', status: 400 })
        }
    }

    // $project avec renommage : racine + imbriqué ($facet, $lookup.pipeline, …)
    let renameForbiddenKeys: string[] = [];
    let renameError: AppError | null = null;
    walkAggregatePipeline(pipeline, (stage) => {
        if (renameError || !('$project' in stage)) {
            return;
        }
        const p = stage.$project;
        if (p == null || typeof p !== 'object' || Array.isArray(p)) {
            return;
        }
        const renames = getProjectFieldRenames(p);
        if (Object.keys(renames).length > 0) {
            renameForbiddenKeys = Object.keys(renames);
            renameError = new AppError('Unauthorized to rename field on $project', {
                code: 'UNAUTHORIZED_PROJECT_FIELD_RENAME',
                status: 400,
            }, { renames });
        }
    });
    if (renameError) {
        return {
            isSafe: false,
            forbiddenKeys: renameForbiddenKeys,
            error: renameError,
        };
    }



    return {
        isSafe: true,
        forbiddenKeys: [],
        error: null
    }
}

export {
    buildPipeline,
    reorder,
    omit,
    pick,
    toJson,
    stringToBoolean,
    cleanDeep,
    isDate,
    deepCopy,
    clone,
    formatToDate,
    isObjectId,
    formatToObjectId,
    generateRandom,
    buildInput,
    toBson,
    jwt,
    isEmpty,
    slugify,
    paginate,
    hasUnauthorizedKeys,
    protectFieldRenameOnProject,
    walkAggregatePipeline,
    countAggregatePipelineStages,
    isSafeAggregatePipeline,
}

export type { PaginationResult, FormatToDateOptions }
