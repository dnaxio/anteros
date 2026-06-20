import { Glob } from "bun"
import { cfg } from "../server/config"
import path from "path"
import fs from "fs/promises"
import type { Script } from "../types/scripts"
import { useRest } from "../database/rest"
import { asyncContextStorage, requestCtxStorage } from "./asyncContextStorage"


async function runScripts() {
    let scripts: (Script & { rest: InstanceType<typeof useRest> })[] = []
    for (let tenant of cfg.tenants ?? []) {
        const TENANT_PATH = path.join(process.cwd(), tenant.dir)
        const SCRIPTS_PATH = path.join(TENANT_PATH, 'scripts')
        let exist = await fs.exists(SCRIPTS_PATH)
        if (!exist) continue;
        const isDirectory = await (await fs.stat(SCRIPTS_PATH)).isDirectory()
        if (isDirectory) {
            const glob = new Glob(path.join(SCRIPTS_PATH, '**/*.run.ts'))
            for await (let file of glob.scan('.')) {
                let scriptModule = await import(file)
                if (scriptModule?.default?._isScript_ && scriptModule?.default?.enabled) {
                    scripts.push({
                        ...scriptModule?.default,
                        rest: new useRest({
                            tenant_id: tenant.id,
                        })
                    })
                }
            }
        }
    }

    for (let script of scripts) {
        asyncContextStorage.run(new Map(), async () => {
            requestCtxStorage.set('trace', { id: crypto.randomUUID() })
            requestCtxStorage.set('internal', true)

            await script.exec({
                rest: script.rest
            })
        })
    }
}
export {
    runScripts
}