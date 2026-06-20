import { Glob } from "bun"
import { cfg } from "../server/config"
import path from "path"
import fs from "fs/promises"
import { useRest } from "../database/rest"


async function loadServices() {
    try {
        let services = []
        for (let tenant of cfg.tenants ?? []) {
            const TENANT_PATH = path.join(process.cwd(), tenant.dir)
            const SERVICES_PATH = path.join(TENANT_PATH, 'services')
            let exist = await fs.exists(SERVICES_PATH)
            if (!exist) continue;
            const isDirectory = await (await fs.stat(SERVICES_PATH)).isDirectory()
            if (isDirectory) {
                const glob = new Glob(path.join(SERVICES_PATH, '**/*.service.ts'))
                for await (let file of glob.scan('.')) {
                    let serviceModule = await import(file)
                    if (serviceModule?.default?._isService_) {
                        services.push({
                            ...serviceModule?.default,
                            _tenant_: tenant.id,
                            rest: new useRest({
                                tenant_id: tenant.id,
                            })
                        })
                    }
                }
            }
        }

        cfg.services = services

    } catch (err: any) {
        console.error(err?.message)
    }


}

export {
    loadServices
}