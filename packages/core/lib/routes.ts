import { Glob } from "bun"
import { cfg } from "../server/config"
import path from "path"
import fs from "fs/promises"


async function loadRoutes() {

    try {
        let routes = []
        for (let tenant of cfg.tenants ?? []) {
            const TENANT_PATH = path.join(process.cwd(), tenant.dir)
            const ROUTES_PATH = path.join(TENANT_PATH, 'routes')
            let exist = await fs.exists(ROUTES_PATH)
            if (!exist) continue;
            const isDirectory = await (await fs.stat(ROUTES_PATH)).isDirectory()
            if (isDirectory && tenant.routes?.prefix) {
                const glob = new Glob(path.join(ROUTES_PATH, '**/*.route.ts'))
                for await (let file of glob.scan('.')) {
                    let routeModule = await import(file)
                    if (routeModule?.default?._isRoute_ && routeModule?.default?.path && routeModule?.default?.method && routeModule?.default?.enabled) {
                        routes.push({
                            ...routeModule?.default,
                            prefix: tenant.routes?.prefix,
                            _tenant_: tenant.id,
                            _prefix_: tenant.routes?.prefix,
                        })
                    }
                }
            }
        }

        cfg.routes = routes

    } catch (err: any) {
        console.error(err?.message)
    }


}

export {
    loadRoutes
}