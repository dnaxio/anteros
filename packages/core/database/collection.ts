import { Glob } from "bun"
import { cfg } from "../server/config"
import path from "path"
import fs from "fs/promises"
import type { Collection } from "../types/collection"
import type { IndexDescription } from "mongodb"
import type { Field } from "../types/field"
import { getTenant } from "./tenant"
import { buildSchema } from "./schema"
import type { FileCollection } from "../types/file"

/**
 * Mongo index options must be real booleans: `unique`/`sparse`/… accept
 * `1`/`0`/`true`/`false` but NEVER `null`/`undefined` (otherwise the server
 * throws `The field 'sparse' has value null, which is not convertible to bool`).
 * Coerce truthiness (`1` → `true`, `0` → `false`) and drop nullish values entirely.
 */
const BOOLEAN_INDEX_OPTIONS = ['unique', 'sparse', 'background', 'hidden'];
function applyIndexOptions(spec: IndexDescription, options?: Field['indexOptions']): IndexDescription {
    for (const [k, v] of Object.entries(options ?? {})) {
        if (v === undefined || v === null) continue; // never send null/undefined on the wire
        (spec as unknown as Record<string, unknown>)[k] = BOOLEAN_INDEX_OPTIONS.includes(k) ? !!v : v;
    }
    return spec;
}

async function syncCollections() {
    try {

        const collections: Collection[] = []
        for (let tenant of cfg.tenants ?? []) {
            const TENANT_PATH = path.join(process.cwd(), tenant.dir)
            const COLLECTIONS_PATH = path.join(TENANT_PATH, 'collections')
            let exist = await fs.exists(COLLECTIONS_PATH)
            if (!exist) continue;
            const isDirectory = await (await fs.stat(COLLECTIONS_PATH)).isDirectory()

            if (isDirectory) {
                const glob = new Glob(path.join(COLLECTIONS_PATH, '**/*.model.ts'))
                for await (let file of glob.scan('.')) {
                    let collectionModule = await import(file)
                    if (collectionModule?.default?._isCollection_) {
                        collections.push({
                            ...collectionModule?.default,
                            _tenant_: tenant.id
                        })
                    }
                }
            }
        }

        // construction des schema arktype pour les collections
        for (let collection of collections) {
            collection._schema_ = buildSchema(collection)
            collection._schemaPartial_ = buildSchema(collection, { partial: true })
        }

        initializeOnDatabase(collections).catch(err => {
            console.error('Initialize collections on database failed', err?.message)
        })
        cfg.collections = collections

    } catch (err: any) {
        console.error(cfg.debug ? err : err?.message)
    }
}




async function initializeOnDatabase(collections: Collection[]) {
    for (let collection of collections) {
        try {
            const tenant = getTenant(collection._tenant_!)
            const db = tenant?.database?.db
            if (db && collection) {

                // create collection on database
                if (!collection?._isTimeSerie_) {
                    await db.createCollection(collection.slug)
                }

                // Fetch existing indexes once — used to skip already-created
                // indexes: never force re-creation of an index that already
                // exists (avoids the "same name but different options" error)
                const col = db.collection(collection.slug);
                const existingIndexes = await col.listIndexes().toArray();
                const existingNames = new Set(existingIndexes.map((idx) => idx.name));
                const existingKeys = new Set(
                    existingIndexes.map((idx) => JSON.stringify(Object.keys(idx.key ?? {}).sort()))
                );

                // create default index on collection (skip if it already exists)
                let specsTimeStamps = {
                    createdAt: -1,
                    updatedAt: -1
                }
                const defaultIndexName = 'createdAt_-1_updatedAt_-1';
                if (!existingNames.has(defaultIndexName)) {
                    await col.createIndex(specsTimeStamps)
                }



                // creation d'index sur les champs
                let specsFieldsIndexes: IndexDescription[] = []
                for (let field of collection?.fields || []) {
                    field.indexOptions = field.indexOptions ?? {}
                    if ((field.type == 'random' && Object.keys(field.randomOptions ?? {}).length) || field.unique) {
                        field.index = field.index ?? true
                        field.indexOptions.unique = true
                    }

                    if (field?.index) {
                        let indexValue: number | string = 1;

                        // Honor explicit indexType first
                        if (field.indexType) {
                            indexValue = field.indexType;
                        } else if (typeof field.index === 'number') {
                            indexValue = field.index;
                        } else if (field.type === 'geojson.Point' || field.type === 'geojson.LineString' || field.type === 'geojson.Polygon') {
                            indexValue = '2dsphere';
                        } else {
                            let includesStringType: Field['type'][] = ['string', 'email', 'enum', 'url', 'random', 'slug', 'relationship', 'uuid', 'password'];
                            let includesDateType: Field['type'][] = ['date', 'datetime-local'];
                            if (includesStringType.includes(field.type)) {
                                indexValue = 1;
                            } else if (includesDateType.includes(field.type)) {
                                indexValue = -1;
                            }
                        }

                        // !! : field.unique peut être 1/0 (Mongo-style) → coercer en vrai booléen
                        let isSparse = !!(field.type === 'random'
                            || (field.unique && field.required !== true));

                        specsFieldsIndexes.push(applyIndexOptions({
                            key: {
                                [field.name]: indexValue as any
                            },
                            unique: !!field.unique, // 1/0/true/false → real boolean
                            sparse: isSparse,
                        }, field.indexOptions)) // explicit overrides win — sanitized

                    }



                }

                // Only create indexes that don't already exist on the database
                // (match by name OR by key pattern — never force re-creation)
                const missingIndexes = specsFieldsIndexes.filter((spec) => {
                    const keySignature = JSON.stringify(Object.keys(spec.key ?? {}).sort());
                    return !existingNames.has(spec.name!) && !existingKeys.has(keySignature);
                });
                if (missingIndexes.length) {
                    await col.createIndexes(missingIndexes)
                }

                // Purge orphan indexes (fields removed from schema)
                if (collection.purgeOrphanIndexes) {
                    const expectedKeys = new Set(specsFieldsIndexes.map((idx) =>
                        JSON.stringify(Object.keys(idx.key!).sort())
                    ));
                    for (const idx of existingIndexes) {
                        if (idx.name === '_id_') continue; // built-in
                        const idxKeys = JSON.stringify(Object.keys(idx.key!).sort());
                        if (!expectedKeys.has(idxKeys)) {
                            await col.dropIndex(idx.name!);
                            console.log(`🧹 Dropped orphan index: ${collection.slug}.${idx.name}`.gray);
                        }
                    }
                }
            }

        } catch (err: any) {
            console.error(`col: ${collection?.slug||''}`,err?.message)

        }
    }
}

function getCollection(collectionName: string, tenantId: string): Collection | null {

    let col = cfg.collections?.find(collection => collection.slug == collectionName && collection._tenant_ == tenantId)

    if (col) {
        return col
    }

    // Chercher aussi dans les file collections
    let fileCol = cfg.fileCollections?.find(fc => fc.slug == collectionName && fc._tenant_ == tenantId)
    if (fileCol) {
        return {
            slug: fileCol.slug,
            type: 'file',
            fields: fileCol.fields ?? [],
            api: fileCol.api as any,
            hooks: fileCol.hooks as any,
            _tenant_: fileCol._tenant_,
            _schema_: fileCol._schema_,
            _schemaPartial_: fileCol._schemaPartial_,
        }
    }

    return null
}


function getCollectionKeys(collection: Collection): string[] {
    return collection.fields.map(field => field.name)
}



export {
    syncCollections,
    getCollection,
    getCollectionKeys
}
