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
        console.error(err?.message)
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

                // create default index on collection
                let specsTimeStamps = {
                    createdAt: -1,
                    updatedAt: -1
                }
                await db.collection(collection.slug).createIndex(specsTimeStamps)
                // console.log('index created on collection', collection.slug, index)



                // creation d'index sur les champs
                let specsFieldsIndexes: IndexDescription[] = []
                for (let field of collection?.fields || []) {
                    field.indexOptions = field.indexOptions ?? {}
                    if ((field.type == 'random' && Object.keys(field.randomOptions ?? {}).length) || field.unique) {
                        field.index = field.index ?? true
                        field.indexOptions.unique = true
                    }

                    if (field?.index) {
                        let indexValue: Boolean | number = field.index;
                        let includesStringType: Field['type'][] = ['string', 'email', 'enum', 'url', 'random'];
                        let includesDateType: Field['type'][] = ['date', 'datetime-local'];
                        if (typeof indexValue == "boolean" && includesStringType.includes(field.type)) {
                            indexValue = 1
                        }

                        if (typeof indexValue == "boolean" && includesDateType.includes(field.type)) {
                            indexValue = -1
                        }
                        specsFieldsIndexes.push({
                            key: {
                                [field.name]: indexValue as number
                            },
                            unique: field.unique ?? false,
                            sparse: field.type == 'random' ? true : false,
                            ...field.indexOptions,
                        })

                    }



                }
                if (specsFieldsIndexes.length) {
                    await db.collection(collection.slug).createIndexes(specsFieldsIndexes)
                }
            }

        } catch (err: any) {
            console.error(err?.message)

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
