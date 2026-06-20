import { Glob } from "bun"
import { cfg } from "../server/config"
import path from "path"
import fs from "fs/promises"
import type { WorkflowDefinition } from "../types/workflow"
import { getTenant } from "../database/tenant"

const workflows: Map<string, WorkflowDefinition> = new Map();

async function syncWorkflows() {
    try {
        workflows.clear();
        for (let tenant of cfg.tenants ?? []) {
            const TENANT_PATH = path.join(process.cwd(), tenant.dir)
            const WORKFLOWS_PATH = path.join(TENANT_PATH, 'workflows')
            let exist = await fs.exists(WORKFLOWS_PATH)
            if (!exist) continue;
            const isDirectory = await (await fs.stat(WORKFLOWS_PATH)).isDirectory()
            if (!isDirectory) continue;

            const glob = new Glob(path.join(WORKFLOWS_PATH, '**/*.workflow.ts'))
            for await (let file of glob.scan('.')) {
                let module = await import(file)
                if (module?.default?._isWorkflow_) {
                    const wf: WorkflowDefinition = { ...module.default, _tenant_: tenant.id }
                    workflows.set(`${tenant.id}:${wf.id}`, wf)
                }
            }
        }

        // Créer les indexes sur _workflows_ pour les contextes définis
        for (const [key, wf] of workflows) {
          const tenantId = key.split(':')[0]
          if (!wf.context || !tenantId) continue
          const tenant = getTenant(tenantId)
          const db = tenant?.database?.db
          if (!db) continue

          for (const [field, config] of Object.entries(wf.context)) {
            const direction = config.index === true || config.index === 1 ? 1 : config.index === -1 ? -1 : 0
            if (direction === 0) continue

            try {
              const indexKey = `context.${field}`
              await db.collection('_workflows_').createIndex({ [indexKey]: direction })
            } catch (err: any) {
              console.error(`Failed to create index on _workflows_.${field}:`, err?.message)
            }
          }
        }
    } catch (err: any) {
        console.error('Failed to sync workflows:', err?.message)
    }
}

function getWorkflow(id: string, tenantId: string): WorkflowDefinition | undefined {
    return workflows.get(`${tenantId}:${id}`)
}

export { syncWorkflows, getWorkflow }
