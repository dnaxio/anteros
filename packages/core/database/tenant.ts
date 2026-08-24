import type { Tenant } from "../types/tenant";
import { cfg } from "../server/config";
import { useRest } from "./rest";
async function syncTenants() {
    try {
        for await (let tenant of cfg.tenants ?? []) {
          let rest = new useRest({
            tenant_id: tenant.id,
            database: {
                    uri: tenant.database.uri,
                    options: {
                        timeoutMS: 2000,
                        ...tenant.database.options,
                    },
                }
            })
            const { client, db } = await rest.connect()
            tenant.database.client = client
            tenant.database.db = db
        }
    } catch (err: any) {
        console.error('Error bootstrapping tenants', cfg.debug ? err : err?.message)
        process.exit(1)
    }
}

function getTenant(tenantId: string): Tenant | null {
    let findTenant = cfg.tenants?.find(tenant => tenant.id == tenantId)
    if (findTenant) {
        return findTenant
    }
    return null
}

export {
    syncTenants,
    getTenant
}
