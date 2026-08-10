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
        const SECRET_ = cfg.server.jwt?.secret || Bun.env.JWT_SECRET
        if (!SECRET_) throw new Error('JWT_SECRET is not set');
        // Per-call expiresIn wins over the global config (default: 7d)
        const EXPIRES_IN = options?.expiresIn || cfg.server.jwt?.expiresIn || '7d'

        const secret = new TextEncoder().encode(SECRET_);
        const signer = new Jose.SignJWT(payload)
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime(EXPIRES_IN)

        if (options?.issuer) signer.setIssuer(options.issuer)
        if (options?.audience) signer.setAudience(options.audience)
        if (options?.subject) signer.setSubject(options.subject)

        const token = await signer.sign(secret);
        return token;
    },
    verify: async (token: string): Promise<{ value: Record<string, unknown> | null, error: string | null, expired: boolean }> => {
        try {
            if (!token) throw new Error('Token is required');
            let SECRET_ = cfg.server.jwt?.secret || Bun.env.JWT_SECRET
            if (!SECRET_) throw new Error('JWT_SECRET is not set');
            const secret = new TextEncoder().encode(SECRET_);
            const { payload, protectedHeader } = await Jose.jwtVerify(token, secret);
            return {
                value: payload,
                error: null,
                expired: false,
            }
        } catch (error: any) {
            // Reliable expiry detection via jose error code (not string matching)
            const isExpired = error?.code === 'ERR_JWT_EXPIRED'
                || /expired|expiration/i.test(error?.message ?? '');
            return {
                value: null,
                error: error instanceof Error ? error.message : 'Invalid token',
                expired: isExpired,
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

/**
 * Convertit la dot-notation MongoDB en structure imbriquée pour la validation Joi.
 * Ex: { "address.zip": "BP28", "items.0.name": "x" } → { address: { zip }, items: [{ name }] }
 * Les clés opérateurs ($inc, $push…) sont laissées telles quelles.
 */
function unflattenKeys(input: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
        // Opérateurs Mongo → laisser tel quel (interdits dans $set de toute façon)
        if (key.startsWith('$')) {
            result[key] = value;
            continue;
        }
        const parts = key.split('.');
        let target: any = result;
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i]!;
            const nextPart = parts[i + 1]!;
            const isArrayIndex = /^\d+$/.test(nextPart);
            if (typeof target[part] !== 'object' || target[part] === null) {
                target[part] = isArrayIndex ? [] : {};
            }
            target = target[part];
        }
        const last = parts[parts.length - 1]!;
        // Fusion si les deux côtés sont des objets (ex. "a.b" + a: { c })
        if (
            target[last] &&
            typeof target[last] === 'object' &&
            !Array.isArray(target[last]) &&
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value)
        ) {
            target[last] = { ...(target[last] as object), ...(value as object) };
        } else {
            target[last] = value;
        }
    }
    return result;
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

/**
 * Vérifie si une string est une date ISO 8601 valide.
 * Les timestamps numériques (ex: "1704067200") ne sont PAS convertis ici —
 * ils passent par `isEpochNumber` quand la valeur est un `number`.
 */
function isDate(value: string): boolean {
    if (!value || typeof value !== 'string') return false;
    const trimmed = value.trim();

    // ISO 8601 : YYYY-MM-DD avec heure optionnelle
    if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(trimmed)) {
        return false;
    }

    const date = new Date(trimmed);
    return !isNaN(date.getTime());
}

/** Convertit une string ISO 8601 en Date. */
function stringToDate(value: string): Date {
    return new Date(value.trim());
}

/**
 * Nombre entier type timestamp UNIX (s ou ms).
 * Restreint à ≥ an 2000 pour éviter les faux positifs (ex: numéros de téléphone).
 */
function isEpochNumber(value: number): boolean {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    const int = Math.trunc(value);
    if (int !== value) return false;
    const s = String(Math.abs(int));
    if (s.length === 10) {
        // Secondes UNIX : ≥ 2000-01-01
        if (int < 946684800) return false;
        return !isNaN(new Date(int * 1000).getTime());
    }
    if (s.length === 13) {
        // Millisecondes UNIX : ≥ 2000-01-01
        if (int < 946684800000) return false;
        return !isNaN(new Date(int).getTime());
    }
    return false;
}

function deepCopy<T>(value: T): T {
    // structuredClone preserves Date / RegExp / Map / Set / typed arrays
    // (clone() uses toJson, which JSON-serializes and loses those types).
    // Falls back to clone() for values structuredClone cannot handle.
    try {
        return structuredClone(value);
    } catch {
        return clone(value);
    }
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

/**
 * Correspond à un nom de champ schéma (`createdAt`, `user.birthDate`)
 * y compris en profondeur (`$set.createdAt`) ou derrière un opérateur
 * MongoDB (`createdAt.$lte`, `$match.createdAt.$gte`).
 */
function pathMatchesFieldKey(path: string, key: string): boolean {
    // Strip trailing MongoDB operator segments: createdAt.$lte → createdAt
    const cleanPath = path.replace(/\.\$[a-z]+$/i, '');
    return cleanPath === key || cleanPath.endsWith('.' + key);
}

function shouldFormatDateAtPath(path: string, options?: FormatToDateOptions): boolean {
    // Aucune option → convertir partout où `isDate` est vrai
    if (!options) return true;

    // Contexte d'opérateur MongoDB ($lte, $gte, $eq, $in, $nin, $exists, etc.)
    // → toujours convertir : un opérateur sur une date n'a de sens qu'avec un vrai Date
    // On vérifie si un segment du chemin commence par '$' (ex: createdAt.$lte, $in.0)
    if (path.split('.').some((seg) => /^\$[a-z]+$/i.test(seg))) return true;

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

    // String racine (ex: item de tableau $in) — vérifier avant la branche objet
    if (typeof data === 'string' && isDate(data)) {
        return shouldFormatDateAtPath(path, options) ? stringToDate(data) : data;
    }

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
                    // 10 chiffres = secondes (×1000), 13 chiffres = millisecondes (déjà en ms)
                    const absVal = Math.abs(Math.trunc(value));
                    const asMs = String(absVal).length === 10 ? value * 1000 : value;
                    result[key] = new Date(asMs);
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

    // Pass through primitives and Date instances untouched
    if (value instanceof Date) {
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
    /** Préfixe (string fixe ou fonction qui reçoit la valeur générée). Ex: `(v) => 'BP-' + v` */
    startWith?: string | ((value: string) => string);
    /** Suffixe (string fixe ou fonction qui reçoit la valeur générée). Ex: `(v) => v + '-X'` */
    endWith?: string | ((value: string) => string);
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

    // String → préfixe/suffixe classique. Fonction → elle reçoit la valeur
    // et retourne le résultat final (pas de re-concaténation pour éviter la duplication).
    if (typeof startWith === 'function') {
        result = startWith(result);
    } else {
        result = startWith + result;
    }

    if (typeof endWith === 'function') {
        result = endWith(result);
    } else {
        result = result + endWith;
    }

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
            if (Object.hasOwn(f, 'defaultValue') && (dataValue === undefined || dataValue === null)) {
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

function toBson<T>(data: any | any[], _options?: FormatInputOptions): T {
    let data_ = formatToObjectId(data);

    // Build omitKeys for fields that should NOT be date-converted (random, number, integer)
    const omitKeys: string[] = [];
    for (const f of _options?.col?.fields ?? []) {
        if (f.type === 'random' || f.type === 'number' || f.type === 'integer') {
            omitKeys.push(f.name);
        }
    }
    data_ = formatToDate(data_, { omitKeys: omitKeys.length > 0 ? omitKeys : undefined });

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
        // Faille 13: bound $regex (ReDoS) and $in/$nin (memory DoS)
        boundMatchOperators(p.$match);
        pipeline.push({
            $match: p.$match
        })
    }

    // $sort — Faille 14: values must be 1 or -1
    if (p?.$sort) {
        for (const [key, dir] of Object.entries(p.$sort)) {
            if (dir !== 1 && dir !== -1) {
                throw new AppError(`Invalid $sort direction for '${key}' (expected 1 or -1)`, {
                    code: 'INVALID_SORT_DIRECTION',
                    status: 400
                });
            }
        }
    }

    // $skip — Faille 14: must be a safe non-negative integer
    if (p?.$skip !== undefined && p?.$skip !== null) {
        if (!Number.isSafeInteger(p.$skip) || p.$skip < 0) {
            throw new AppError('Invalid $skip (expected a non-negative integer)', {
                code: 'INVALID_SKIP',
                status: 400
            });
        }
    }
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

    // $skip (validated above)
    if (p?.$skip) {
        pipeline.push({
            $skip: p.$skip
        })
    }

    // $limit — 0 means "no limit" (the $limit stage is omitted);
    // any positive safe integer is allowed (no 1000 cap)
    p.$limit = p?.$limit ?? 100
    if (!Number.isSafeInteger(p.$limit) || p.$limit < 0) {
        throw new AppError(`Invalid $limit (expected a non-negative integer; 0 = no limit)`, {
            code: 'INVALID_LIMIT',
            status: 400
        });
    }
    if (p.$limit > 0) {
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

                // Faille 3: never trust client-supplied $lookup sub-pipeline — scan it
                if (include.pipeline && Array.isArray(include.pipeline)) {
                    const check = isSafeAggregatePipeline(include.pipeline as Array<Record<string, unknown>>)
                    if (!check.isSafe) {
                        throw check.error ?? new AppError('Unauthorized $include pipeline', {
                            code: 'UNAUTHORIZED_PIPELINE_KEYS',
                            status: 400
                        })
                    }
                }

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

/**
 * Faille 13: bounds dangerous $match operators to prevent ReDoS ($regex) and memory DoS ($in).
 * Walks nested objects/arrays ($and, $or, $nor, dotted fields).
 */
const MAX_REGEX_LENGTH = 1000;
const MAX_IN_ARRAY_SIZE = 10000;

function boundMatchOperators(node: unknown): void {
    if (node === null || node === undefined) return;

    if (Array.isArray(node)) {
        for (const item of node) {
            boundMatchOperators(item);
        }
        return;
    }

    if (typeof node === 'object') {
        const obj = node as Record<string, unknown>;
        for (const [key, value] of Object.entries(obj)) {
            if (key === '$regex' && typeof value === 'string') {
                if (value.length > MAX_REGEX_LENGTH) {
                    throw new AppError(`$regex pattern too long (max ${MAX_REGEX_LENGTH} chars)`, {
                        code: 'REGEX_TOO_LONG',
                        status: 400
                    });
                }
            } else if ((key === '$in' || key === '$nin') && Array.isArray(value)) {
                if (value.length > MAX_IN_ARRAY_SIZE) {
                    throw new AppError(`$in/$nin too large (max ${MAX_IN_ARRAY_SIZE} items)`, {
                        code: 'ARRAY_OPERATOR_TOO_LARGE',
                        status: 400
                    });
                }
            }
            boundMatchOperators(value);
        }
    }
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

	/** Vérifie qu'une chaîne est un slug valide (lettres minuscules, chiffres, tirets simples) */
	function isSlug(value: string): boolean {
	    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
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


function isSafeAggregatePipeline(pipeline: Array<Record<string, unknown>>, allowedCollections?: string[]): {
    isSafe: boolean;
    forbiddenKeys: string[];
    error: AppError | null;
} {

    // Unauthorized pipeline keys — Faille 12: include cross-collection exfiltration stages
    const UNAUTHORIZED_PIPELINE_KEYS = [
        '$out', '$merge', '$function', '$where', '$accumulator',
        '$unionWith', '$collStats', '$indexStats', '$planCacheStats',
        '$currentOp', '$listLocalSessions', '$listSessions', '$changeStream',
    ];
    const forbiddenFound = hasUnauthorizedKeys(pipeline, UNAUTHORIZED_PIPELINE_KEYS);
    if (forbiddenFound.length > 0) {
        return {
            isSafe: false,
            forbiddenKeys: forbiddenFound,
            error: new AppError('Unauthorized pipeline keys: ' + forbiddenFound.join(', '), { code: 'UNAUTHORIZED_PIPELINE_KEYS', status: 400 })
        }
    }

    // Faille 12: restrict $lookup / $graphLookup targets to declared tenant collections
    if (allowedCollections && allowedCollections.length > 0) {
        const badTargets: string[] = [];
        walkAggregatePipeline(pipeline, (stage) => {
            const lookup = (stage as any).$lookup;
            if (lookup?.from && !allowedCollections.includes(lookup.from)) {
                badTargets.push(lookup.from);
            }
            const graph = (stage as any).$graphLookup;
            if (graph?.from && !allowedCollections.includes(graph.from)) {
                badTargets.push(graph.from);
            }
        });
        if (badTargets.length > 0) {
            return {
                isSafe: false,
                forbiddenKeys: badTargets,
                error: new AppError('Unauthorized $lookup target collection: ' + [...new Set(badTargets)].join(', '), { code: 'UNAUTHORIZED_LOOKUP_TARGET', status: 400 })
            };
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
    unflattenKeys,
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
    isSlug,
    paginate,
    hasUnauthorizedKeys,
    protectFieldRenameOnProject,
    walkAggregatePipeline,
    countAggregatePipelineStages,
    isSafeAggregatePipeline,
}

export type { PaginationResult, FormatToDateOptions }
