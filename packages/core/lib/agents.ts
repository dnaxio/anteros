import { Glob } from "bun";
import path from "path";
import fs from "fs/promises";
import { cfg } from "../server/config";
import { Agent, InMemoryAgentMemory } from "./agent";
import { importDefinition } from "./load";
import { logger } from "../utils/logger";
import type { useRest } from "../database/rest";
import type { AgentDefinition, TenantAgents } from "../types/agent";

/**
 * Agent loader — `{tenant.dir}/agents/**\/*.agent.ts`.
 *
 * Each definition is instantiated once per tenant and kept in a process-wide
 * registry keyed by `tenant:agent`. `rest.agents.get('weather')` resolves it at
 * runtime, binding the *calling* `rest` so tools run with the right scope.
 */

const registry = new Map<string, Agent>();
const definitions: AgentDefinition[] = [];

const SUFFIX = /\.agent\.ts$/;

function defaultId(file: string): string {
    return path.basename(file).replace(SUFFIX, "");
}

async function syncAgents(): Promise<void> {
    registry.clear();
    definitions.length = 0;

    for (const tenant of cfg.tenants ?? []) {
        const agentsPath = path.join(process.cwd(), tenant.dir, "agents");
        if (!(await fs.exists(agentsPath))) continue;
        if (!(await fs.stat(agentsPath)).isDirectory()) continue;

        const glob = new Glob(path.join(agentsPath, "**/*.agent.ts"));
        for await (const file of glob.scan(".")) {
            const module = await importDefinition(file, "Agent");
            const definition: AgentDefinition | undefined = module?.default;
            if (!definition?._isAgent_) continue;
            if (definition.enabled === false) continue;

            const id = definition.id ?? defaultId(file);
            if (!id) {
                console.error(`Agent '${file}' has no id and could not be named from its file — skipped`);
                continue;
            }

            const key = `${tenant.id}:${id}`;
            const existing = registry.get(key);
            if (existing) {
                logger.warn(`Duplicate agent id '${id}' for tenant '${tenant.id}' — '${file}' replaces the previous definition`);
            }

            try {
                const instance = new Agent({ ...definition, id }, { tenant: tenant.id });
                registry.set(key, instance);
                definitions.push(instance.getConfig());
            } catch (err: any) {
                console.error(`Failed to load agent '${id}' of tenant '${tenant.id}': ${err?.message}`);
            }
        }
    }

    cfg.agents = definitions;
}

/**
 * The agents declared by a tenant, ready to run.
 *
 * When a `rest` is given (always the case through `rest.agents`), the returned
 * instances are bound to it — so a tool's `ctx.rest` is the caller's scope
 * (the request's, in a route), not a detached client.
 */
function createAgents(tenantId: string, rest?: InstanceType<typeof useRest> | any): TenantAgents {
    const prefix = `${tenantId}:`;
    const bind = (agent: Agent): Agent => {
        if (rest) agent.setRest(rest);
        return agent;
    };
    const entries = (): Array<[string, Agent]> =>
        [...registry.entries()].filter(([key]) => key.startsWith(prefix));

    return {
        get: (id) => {
            const agent = registry.get(`${prefix}${id}`);
            return agent ? bind(agent) : undefined;
        },
        has: (id) => registry.has(`${prefix}${id}`),
        ids: () => entries().map(([key]) => key.slice(prefix.length)),
        list: () => entries().map(([, agent]) => bind(agent)),
        reload: syncAgents,
    };
}

/** Boot banner counters. */
function agentsStats(): { total: number; tenants: string[] } {
    const tenants = new Set([...registry.keys()].map((key) => key.slice(0, key.indexOf(":"))));
    return { total: registry.size, tenants: [...tenants] };
}

export { syncAgents, createAgents, agentsStats, InMemoryAgentMemory };
