import { Glob } from "bun"
import { cfg } from "../server/config"
import path from "path"
import fs from "fs/promises"
import type { McpTool, McpResource } from "../types/mcp"

/**
 * Load MCP tools & resources from each tenant's `mcp/` folder:
 *   {tenant.dir}/mcp/tools/**\/*.tool.ts        → tools
 *   {tenant.dir}/mcp/resources/**\/*.resource.ts → resources
 */
async function syncMcpTools() {
    try {
        const tools: McpTool[] = []
        const resources: McpResource[] = []
        for (let tenant of cfg.tenants ?? []) {
            const TENANT_PATH = path.join(process.cwd(), tenant.dir)
            const MCP_PATH = path.join(TENANT_PATH, 'mcp')
            let exist = await fs.exists(MCP_PATH)
            if (!exist) continue;
            const isDirectory = await (await fs.stat(MCP_PATH)).isDirectory()
            if (!isDirectory) continue;

            // tools: mcp/tools/**/*.tool.ts
            const TOOLS_PATH = path.join(MCP_PATH, 'tools')
            if (await fs.exists(TOOLS_PATH)) {
                const toolsGlob = new Glob(path.join(TOOLS_PATH, '**/*.tool.ts'))
                for await (let file of toolsGlob.scan('.')) {
                    let module = await import(file)
                    if (module?.default?._isMcpTool_ && module?.default?.enabled !== false) {
                        tools.push({ ...module?.default, _tenant_: tenant.id })
                    }
                }
            }

            // resources: mcp/resources/**/*.resource.ts
            const RESOURCES_PATH = path.join(MCP_PATH, 'resources')
            if (await fs.exists(RESOURCES_PATH)) {
                const resourcesGlob = new Glob(path.join(RESOURCES_PATH, '**/*.resource.ts'))
                for await (let file of resourcesGlob.scan('.')) {
                    let module = await import(file)
                    if (module?.default?._isMcpResource_ && module?.default?.enabled !== false) {
                        resources.push({ ...module?.default, _tenant_: tenant.id })
                    }
                }
            }
        }

        cfg.mcpTools = tools
        cfg.mcpResources = resources

    } catch (err: any) {
        console.error(err?.message)
    }
}

export {
    syncMcpTools
}
