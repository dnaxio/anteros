import { Glob } from "bun"
import { cfg } from "../server/config"
import path from "path"
import fs from "fs/promises"
import { logger } from "../utils/logger"
import type { McpTool, McpResource } from "../types/mcp"
import { importDefinition } from "./load"

/**
 * Load MCP tools & resources from each tenant's AI folder:
 *   {tenant.dir}/ai/mcp/tools/**\/*.tool.ts         → tools
 *   {tenant.dir}/ai/mcp/resources/**\/*.resource.ts  → resources
 *
 * The legacy `{tenant.dir}/mcp/` layout is still read, with one deprecation
 * warning per tenant; the `ai/` definition wins when both declare the same name.
 */
async function syncMcpTools() {
    try {
        /** Keyed by `tenant:name`, so a migrated file replaces its old copy. */
        const tools = new Map<string, McpTool>()
        const resources = new Map<string, McpResource>()

        for (let tenant of cfg.tenants ?? []) {
            const TENANT_PATH = path.join(process.cwd(), tenant.dir)

            // Legacy first: an `ai/mcp` file of the same name replaces it.
            const roots = [
                { dir: path.join(TENANT_PATH, 'mcp'), legacy: true },
                { dir: path.join(TENANT_PATH, 'ai', 'mcp'), legacy: false },
            ]

            for (const root of roots) {
                let exist = await fs.exists(root.dir)
                if (!exist) continue
                const isDirectory = await (await fs.stat(root.dir)).isDirectory()
                if (!isDirectory) continue
                if (root.legacy) {
                    logger.warn(
                        `Tenant '${tenant.id}': '${path.join(tenant.dir, 'mcp')}' is deprecated — ` +
                        `move it to '${path.join(tenant.dir, 'ai', 'mcp')}'`,
                    )
                }

                // tools: <root>/tools/**/*.tool.ts
                const TOOLS_PATH = path.join(root.dir, 'tools')
                if (await fs.exists(TOOLS_PATH)) {
                    const toolsGlob = new Glob(path.join(TOOLS_PATH, '**/*.tool.ts'))
                    for await (let file of toolsGlob.scan('.')) {
                        let module = await importDefinition(file, 'MCP tool')
                        if (module?.default?._isMcpTool_ && module?.default?.enabled !== false) {
                            const tool = { ...module.default, _tenant_: tenant.id } as McpTool
                            tools.set(`${tenant.id}:${tool.name}`, tool)
                        }
                    }
                }

                // resources: <root>/resources/**/*.resource.ts
                const RESOURCES_PATH = path.join(root.dir, 'resources')
                if (await fs.exists(RESOURCES_PATH)) {
                    const resourcesGlob = new Glob(path.join(RESOURCES_PATH, '**/*.resource.ts'))
                    for await (let file of resourcesGlob.scan('.')) {
                        let module = await importDefinition(file, 'MCP resource')
                        if (module?.default?._isMcpResource_ && module?.default?.enabled !== false) {
                            const resource = { ...module.default, _tenant_: tenant.id } as McpResource
                            resources.set(`${tenant.id}:${resource.name}`, resource)
                        }
                    }
                }
            }
        }

        cfg.mcpTools = [...tools.values()]
        cfg.mcpResources = [...resources.values()]

    } catch (err: any) {
        console.error(err?.message)
    }
}

export {
    syncMcpTools
}
