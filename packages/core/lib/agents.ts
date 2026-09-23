import { Glob } from "bun";
import path from "path";
import fs from "fs/promises";
import { cfg } from "../server/config";
import { Agent } from "./agent";
import { InMemoryAgentMemory, MongoAgentMemory, RedisAgentMemory } from "./agentMemory";
import { importDefinition } from "./load";
import { logger } from "../utils/logger";
import type { useRest } from "../database/rest";
import type { AgentDefinition, TenantAgents } from "../types/agent";

/**
 * Agent loader — `{tenant.dir}/agents/**\/*.agent.ts`.
 *
 * Each definition is instantiated once per tenant and kept in a process-wide
 * registry keyed by `tenant:agent`. `agents.get('weather')` resolves it at
 * runtime, binding the *calling* `rest` so tools run with the right scope.
 */

const registry = new Map<string, Agent>();
const definitions: AgentDefinition[] = [];

async function syncAgents(): Promise<void> {
    registry.clear();
    definitions.length = 0;
    const memories: Array<{ _tenant_: string; collection: string }> = [];

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

            // `id` and `description` are required — the `Agent` constructor refuses a
            // definition without them, and a broken file never hides the others
            const id = definition.id!;

            const key = `${tenant.id}:${id}`;
            const existing = registry.get(key);
            if (existing) {
                logger.warn(`Duplicate agent id '${id}' for tenant '${tenant.id}' — '${file}' replaces the previous definition`);
            }

            try {
                const instance = new Agent({ ...definition, id }, { tenant: tenant.id });
                registry.set(key, instance);
                definitions.push(instance.getConfig());

                // A store says which collections it writes to (a Mongo memory does):
                // published on `cfg` so the replication engine copies them, exactly
                // like a declared collection — the tenant chooses the name.
                for (const collection of instance.getMemory()?.collections?.() ?? []) {
                    if (!memories.some((m) => m._tenant_ === tenant.id && m.collection === collection)) {
                        memories.push({ _tenant_: tenant.id, collection });
                    }
                }
            } catch (err: any) {
                console.error(`Failed to load agent '${id}' of tenant '${tenant.id}': ${err?.message}`);
            }
        }
    }

    cfg.agents = definitions;
    cfg.agentMemories = memories;
}

/**
 * The agents declared by a tenant, ready to run.
 *
 * When a `rest` is given (always the case through the `agents` member of a
 * context), every call
 * returns a **copy** bound to it. The registry instance is shared by every
 * caller — binding it in place would let one request's client (and its Mongo
 * session, hence its transaction) leak into another request running at the same
 * time. A copy shares the declaration (instructions, tools, memory), so nothing
 * else changes.
 */
function createAgents(tenantId: string, rest?: InstanceType<typeof useRest> | any): TenantAgents {
    const prefix = `${tenantId}:`;
    const bind = (agent: Agent): Agent => rest
        ? new Agent(agent.getConfig(), { rest, tenant: agent.getTenant() })
        : agent;
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

/**
 * Process-wide agent registry, importable from **anywhere** — including a place
 * with no `rest` at hand: module scope, a global middleware, a `Bun.cron`, a
 * `Bun.serve` of your own.
 *
 * ```ts
 * import { agents } from '@anteros/core'
 *
 * const support = agents.get('v1', 'support')
 * await support.generate('Where is my order?')
 * ```
 *
 * Prefer the `agents` member of a context whenever there is one (a script, a
 * service action, a hook, a socket, a lifecycle hook, a workflow step, a route,
 * an MCP tool): the tenant is implicit and the **calling** client is bound, so the
 * agent's tools run with the right scope. Without a `rest`, pass one as the third
 * argument (`agents.get(tenantId, id, rest)`) or the tools run without a database
 * client.
 */
const agents = {
    /** The agent, bound to `rest` when provided — `undefined` if it does not exist. */
    get: (tenantId: string, id: string, rest?: InstanceType<typeof useRest>): Agent | undefined =>
        createAgents(tenantId, rest).get(id),
    has: (tenantId: string, id: string): boolean => registry.has(`${tenantId}:${id}`),
    /** Declared agent ids of a tenant. */
    ids: (tenantId: string): string[] => createAgents(tenantId).ids(),
    list: (tenantId: string, rest?: InstanceType<typeof useRest>): Agent[] => createAgents(tenantId, rest).list(),
    /** Tenant-scoped registry — the same object a context receives as `agents`. */
    use: createAgents,
    /** Re-scan `{tenant.dir}/agents` and rebuild the registry. */
    reload: syncAgents,
    /** `{ total, tenants }` — what the boot banner prints. */
    stats: agentsStats,
    memory: {
        InMemory: InMemoryAgentMemory,
        Mongo: MongoAgentMemory,
        Redis: RedisAgentMemory,
    },
};

/** Mongo collections used as agent memory by a tenant — published by the loader. */
function agentMemoryCollections(tenantId: string): string[] {
    return (cfg.agentMemories ?? [])
        .filter((memory) => memory._tenant_ === tenantId)
        .map((memory) => memory.collection);
}

export { syncAgents, createAgents, agentsStats, agents, agentMemoryCollections, InMemoryAgentMemory, MongoAgentMemory, RedisAgentMemory };
