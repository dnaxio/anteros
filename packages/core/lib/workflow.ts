import { Glob } from "bun"
import path from "path"
import fs from "fs/promises"
import { cfg } from "../server/config"
import { logger } from "../utils/logger"
import { AppError } from "./error"
import { syncTtlRetention } from "../database/ttl"
import type { WorkflowDefinition, WorkflowIndex } from "../types/workflow"
import type { Tenant } from "../types/tenant"
import { getTenant } from "../database/tenant"

/** Every workflow of every tenant, keyed by `{tenant}:{id}` */
const workflows: Map<string, WorkflowDefinition> = new Map();

/**
 * Indexes the engine itself filters on (see `database/workflow.ts`):
 * - `listRuns()` → `find({ workflowId }).sort({ createdAt: -1 })`
 * - `resumeAll()` → `find({ status: { $in: […] } })`
 *
 * Field names match MongoDB's default index naming, so an existing index with
 * the same key is recognised (and never re-created or duplicated).
 */
const ENGINE_INDEXES: Record<string, 1 | -1>[] = [
    { workflowId: 1, createdAt: -1 },
    { status: 1 },
]

/** TTL index used for run retention — only prunes **finished** runs (`completedAt`) */
const RUNS_TTL_INDEX = '_workflow_runs_ttl_'

/**
 * Run retention — **the tenant always wins**, `server.workflows.retention` is
 * the fallback:
 * - `tenant.workflows.retention` set (even `false`) → used as-is
 * - otherwise                                     → `server.workflows.retention`
 * - neither                                       → `undefined` (kept forever)
 */
function resolveWorkflowsRetention(tenant: Tenant): string | false | undefined {
    if (tenant.workflows?.retention !== undefined) return tenant.workflows.retention
    return cfg.server?.workflows?.retention
}

/** MongoDB's default index name for a key spec — `{ a: 1, b: -1 }` → `a_1_b_-1` */
function indexName(key: Record<string, 1 | -1>): string {
    return Object.entries(key).map(([field, direction]) => `${field}_${direction}`).join('_')
}

async function syncWorkflows() {
    workflows.clear()

    // ── Discovery — `{tenant.dir}/workflows/**/*.workflow.ts` ──────────────
    // A broken file (or a broken tenant) must never hide the others.
    for (const tenant of cfg.tenants ?? []) {
        const WORKFLOWS_PATH = path.join(process.cwd(), tenant.dir, 'workflows')
        try {
            if (!(await fs.exists(WORKFLOWS_PATH))) continue
            if (!(await fs.stat(WORKFLOWS_PATH)).isDirectory()) continue

            const glob = new Glob(path.join(WORKFLOWS_PATH, '**/*.workflow.ts'))
            for await (const file of glob.scan('.')) {
                try {
                    const module = await import(file)
                    const definition = module?.default as WorkflowDefinition | undefined
                    if (!definition?._isWorkflow_) continue
                    if (definition.enabled === false) continue
                    if (!definition.id) {
                        console.warn(`⚠ Workflow ignored (no "id"): ${file}`)
                        continue
                    }

                    const key = `${tenant.id}:${definition.id}`
                    if (workflows.has(key)) {
                        console.warn(
                            `⚠ Duplicate workflow id '${definition.id}' for tenant '${tenant.id}' — ${file} overrides the previous definition`,
                        )
                    }
                    workflows.set(key, { ...definition, _tenant_: tenant.id })
                } catch (err: any) {
                    console.error(`Failed to load workflow '${file}':`, err?.message)
                }
            }
        } catch (err: any) {
            console.error(`Failed to load workflows for tenant '${tenant.id}':`, err?.message)
        }
    }

    logger.file('workflows: loaded', {
        total: workflows.size,
        tenants: [...new Set([...workflows.values()].map((wf) => wf._tenant_))],
    })

    // Indexes are a background concern: boot never waits for an index build.
    ensureWorkflowIndexes().catch((err) => console.error('Failed to create workflow indexes:', err?.message))
}

/**
 * Create the indexes `_workflows_` needs — the engine's query fields, the
 * `context` fields declared by the workflows, and any explicit `indexes`.
 * Only the missing ones are built (`background: true`), and a failure is
 * logged, never fatal.
 */
async function ensureWorkflowIndexes(): Promise<void> {
    for (const tenant of cfg.tenants ?? []) {
        const db = getTenant(tenant.id)?.database?.db
        if (!db) continue

        // Desired indexes: engine queries first, then what the workflows declare
        const desired = new Map<string, { key: Record<string, 1 | -1>; options: any }>()
        for (const key of ENGINE_INDEXES) {
            desired.set(indexName(key), { key, options: { background: true } })
        }

        for (const wf of workflows.values()) {
            if (wf._tenant_ !== tenant.id) continue

            // `context: { field: { index: true | 1 | -1 } }`
            for (const [field, config] of Object.entries(wf.context ?? {})) {
                const direction = config.index === true || config.index === 1 ? 1 : config.index === -1 ? -1 : 0
                if (!direction) continue
                const key = { [`context.${field}`]: direction } as Record<string, 1 | -1>
                desired.set(indexName(key), { key, options: { background: true } })
            }

            // `indexes: [{ key, name?, unique?, sparse? }]` — compound and friends
            for (const index of wf.indexes ?? []) {
                if (!index?.key || !Object.keys(index.key).length) continue
                // Never send `null`/`undefined` on the wire: Mongo rejects `unique: null`
                desired.set(index.name ?? indexName(index.key), {
                    key: index.key,
                    options: {
                        background: true,
                        ...(index.name ? { name: index.name } : {}),
                        ...(index.unique !== undefined ? { unique: index.unique } : {}),
                        ...(index.sparse !== undefined ? { sparse: index.sparse } : {}),
                    },
                })
            }
        }

        try {
            // `listIndexes()` requires the collection to exist — create it first,
            // like the file-collection loader does (`_workflows_` is only written
            // when a workflow actually runs).
            const exists = await db.listCollections({ name: '_workflows_' }).toArray()
            if (!exists.length) await db.createCollection('_workflows_')

            const collection = db.collection('_workflows_')
            const existing = new Set(
                (await collection.listIndexes().toArray()).map((index: any) => index.name),
            )

            for (const [name, { key, options }] of desired) {
                if (existing.has(name)) continue
                await collection.createIndex(key as any, options)
                logger.file('workflows: index created', { tenant: tenant.id, index: name })
            }

            // Retention of finished runs — opt-in (`completedAt` is only set when a
            // run finishes, so running/paused/failed runs are never pruned)
            const retention = resolveWorkflowsRetention(tenant)
            if (retention !== undefined) {
                await syncTtlRetention(db, {
                    collection: '_workflows_',
                    index: RUNS_TTL_INDEX,
                    field: 'completedAt',
                    retention,
                    label: 'Workflows',
                })
            }
        } catch (err: any) {
            console.error(`Failed to create workflow indexes for tenant '${tenant.id}':`, err?.message)
        }
    }
}

/**
 * Validate — and coerce — the `context` of a run against the workflow's own
 * declaration: this is what the `type` of a context field is for. Undeclared
 * keys are kept as-is (the declaration is a contract on what you declare, not a
 * closed schema). Dates sent as ISO strings are stored as real `Date`s, so the
 * indexes on `context.*` stay typed.
 */
function validateWorkflowContext(wf: WorkflowDefinition, context: any): any {
    if (!wf.context || context === undefined || context === null || typeof context !== 'object') {
        return context
    }

    const out: Record<string, any> = { ...context }
    const errors: string[] = []

    for (const [field, spec] of Object.entries(wf.context)) {
        const value = out[field]
        if (value === undefined || value === null) continue

        switch (spec.type) {
            case 'string':
                if (typeof value !== 'string') errors.push(`'${field}' must be a string (received ${typeof value})`)
                break
            case 'number':
                if (typeof value !== 'number' || Number.isNaN(value)) errors.push(`'${field}' must be a number (received ${typeof value})`)
                break
            case 'date': {
                const date = value instanceof Date ? value : new Date(String(value))
                if (Number.isNaN(date.getTime())) errors.push(`'${field}' must be a date (Date or ISO string)`)
                else out[field] = date
                break
            }
        }
    }

    if (errors.length) {
        throw new AppError(`Invalid workflow context: ${errors.join('; ')}`, {
            code: 'WORKFLOW_CONTEXT_INVALID',
            status: 400,
        })
    }
    return out
}

function getWorkflow(id: string, tenantId: string): WorkflowDefinition | undefined {
    return workflows.get(`${tenantId}:${id}`)
}

/** What was loaded — used by the boot banner and logs */
function workflowStats(): { total: number; tenants: string[] } {
    return {
        total: workflows.size,
        tenants: [...new Set([...workflows.values()].map((wf) => wf._tenant_!))],
    }
}

export { syncWorkflows, ensureWorkflowIndexes, validateWorkflowContext, resolveWorkflowsRetention, getWorkflow, workflowStats, RUNS_TTL_INDEX as WORKFLOW_RUNS_TTL_INDEX }
