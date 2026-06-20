import { Glob } from "bun"
import { cfg } from "../server/config"
import path from "path"
import fs from "fs/promises"
import type { Context, Next } from "hono"
import type { TenantMiddlewareConfig, GlobalMiddlewareConfig } from "../types/middleware"

const globalMiddlewares: GlobalMiddlewareConfig[] = [];
const tenantMiddlewares: TenantMiddlewareConfig[] = [];

async function loadTenantsMiddlewares() {
    try {
        globalMiddlewares.length = 0;
        tenantMiddlewares.length = 0;

        // Global middlewares (loaded from project root `middlewares/`)
        const GLOBAL_PATH = path.join(process.cwd(), 'middlewares')
        const globalExists = await fs.exists(GLOBAL_PATH)
        if (globalExists && (await (await fs.stat(GLOBAL_PATH)).isDirectory())) {
            const globalGlob = new Glob(path.join(GLOBAL_PATH, '**/*.middleware.ts'))
            for await (let file of globalGlob.scan('.')) {
                let module = await import(file)
                if (module?.default?._isGlobalMiddleware_ && module.default.enabled !== false) {
                    globalMiddlewares.push({
                        ...module.default,
                        name: module.default.name || path.basename(file, '.middleware.ts'),
                    })
                }
            }
        }

        // Tenant-scoped middlewares (loaded from each tenant's `middlewares/`)
        for (let tenant of cfg.tenants ?? []) {
            const TENANT_PATH = path.join(process.cwd(), tenant.dir)
            const MIDDLEWARES_PATH = path.join(TENANT_PATH, 'middlewares')
            let exist = await fs.exists(MIDDLEWARES_PATH)
            if (!exist) continue;
            const isDirectory = await (await fs.stat(MIDDLEWARES_PATH)).isDirectory()
            if (!isDirectory) continue;

            const glob = new Glob(path.join(MIDDLEWARES_PATH, '**/*.middleware.ts'))
            for await (let file of glob.scan('.')) {
                let module = await import(file)
                if (module?.default?._isTenantMiddleware_ && module.default.enabled !== false) {
                    tenantMiddlewares.push({
                        ...module.default,
                        name: module.default.name || path.basename(file, '.middleware.ts'),
                        _tenant_: tenant.id,
                    })
                }
            }
        }
    } catch (err: any) {
        console.error('Failed to load tenant middlewares:', err?.message)
    }
}

function getGlobalMiddlewares(): GlobalMiddlewareConfig[] {
    return globalMiddlewares;
}

function getTenantMiddlewares(): TenantMiddlewareConfig[] {
    return tenantMiddlewares;
}

export { loadTenantsMiddlewares, getGlobalMiddlewares, getTenantMiddlewares }
