import { Glob } from "bun"
import { cfg } from "../server/config"
import path from "path"
import fs from "fs/promises"
import type { FileCollection } from "../types/file"
import { getTenant } from "./tenant"

async function syncFileCollections() {
    try {
        const fileCollections: FileCollection[] = []
        for (let tenant of cfg.tenants ?? []) {
            const TENANT_PATH = path.join(process.cwd(), tenant.dir)
            const FILES_PATH = path.join(TENANT_PATH, 'files')
            let exist = await fs.exists(FILES_PATH)
            if (!exist) continue;
            const isDirectory = await (await fs.stat(FILES_PATH)).isDirectory()

            if (isDirectory) {
                // Charger les fichiers *.file.ts
                const globFiles = new Glob(path.join(FILES_PATH, '**/*.file.ts'))
                for await (let file of globFiles.scan('.')) {
                    let fileModule = await import(file)
                    if (fileModule?.default?._isFileCollection_) {
                        fileCollections.push({
                            ...fileModule?.default,
                            _tenant_: tenant.id
                        })
                    }
                }

                // Charger aussi les fichiers *.model.ts avec _isFileCollection_
                const globModels = new Glob(path.join(FILES_PATH, '**/*.model.ts'))
                for await (let file of globModels.scan('.')) {
                    let fileModule = await import(file)
                    if (fileModule?.default?._isFileCollection_) {
                        fileCollections.push({
                            ...fileModule?.default,
                            _tenant_: tenant.id
                        })
                    }
                }
            }
        }

        cfg.fileCollections = fileCollections

        initializeFileCollectionsOnDatabase(fileCollections).catch(err => {
            console.error('Initialize file collections on database failed', err?.message)
        })

    } catch (err: any) {
        console.error(err?.message)
    }
}

async function initializeFileCollectionsOnDatabase(files: FileCollection[]) {
    for (const fileCollection of files) {
        try {
            const tenant = getTenant(fileCollection._tenant_!)
            const db = tenant?.database?.db
            if (!db) continue;

            // Créer la collection si elle n'existe pas
            const collections = await db.listCollections({ name: fileCollection.slug }).toArray()
            if (collections.length === 0) {
                await db.createCollection(fileCollection.slug)
            }

            // Créer les indexes par défaut
            await db.collection(fileCollection.slug).createIndexes([
                { key: { filename: 1 } },
                { key: { name: 1 } },
                { key: { mimetype: 1 } },
                { key: { createdAt: -1, updatedAt: -1 } },
            ])

        } catch (err: any) {
            console.error(`Initialize file collection '${fileCollection.slug}' failed`, err?.message)
        }
    }
}

function getFileCollection(collectionName: string, tenantId: string): FileCollection | null {
    let col = cfg.fileCollections?.find(c => c.slug == collectionName && c._tenant_ == tenantId)
    if (col) return col
    return null
}

export {
    syncFileCollections,
    getFileCollection,
    initializeFileCollectionsOnDatabase
}
