import { Glob } from "bun";
import path from "path";
import fs from "fs/promises";
import { cfg } from "../server/config";
import { Agent } from "./agent";
import { InMemoryAgentMemory, MongoAgentMemory, RedisAgentMemory, customAgentMemory, semanticRecall, summarize } from "./agentMemory";
import { importDefinition } from "./load";
import { resolveSkills } from "./skills";
import { closeMcpClients } from "./mcpClient";
import { logger } from "../utils/logger";
import type { useRest } from "../database/rest";
import type { AgentDefinition, AgentTool, TenantAgents } from "../types/agent";

/**
 * Agent loader — `{tenant.dir}/ai/agents/**\/*.agent.ts`, the legacy
 * `{tenant.dir}/agents/**\/*.agent.ts` still read (with a deprecation warning).
 *
 * Tools live **next to the agent**: `support.agent.ts` + `support.tool.ts` in the
 * same directory (a sub-directory works the same way). Each definition is
 * instantiated once per tenant and kept in a process-wide registry keyed by
 * `tenant:agent`. `agents.get('weather')` resolves it at runtime, binding the
 * *calling* `rest` so tools run with the right scope.
 */

const registry = new Map<string, Agent>();
const definitions: AgentDefinition[] = [];

/** Paths scanned, legacy first so the `ai/` definition wins a duplicate id. */
function agentRoots(tenantDir: string): Array<{ dir: string; legacy: boolean }> {
    return [
        { dir: path.join(tenantDir, "agents"), legacy: true },
        { dir: path.join(tenantDir, "ai", "agents"), legacy: false },
    ];
}

/** A deprecation is logged once per tenant and path — `reload()` stays quiet. */
const warned = new Set<string>();
function warnLegacy(tenantId: string, from: string, to: string): void {
    const key = `${tenantId}:${from}`;
    if (warned.has(key)) return;
    warned.add(key);
    logger.warn(`Tenant '${tenantId}': '${from}' is deprecated — move it to '${to}'`);
}

/**
 * Tools declared beside an agent — `<basename>.tool.ts` in the same directory.
 * The file exports one `define.Tool` or an array; `enabled: false` and entries
 * without an `id` are skipped. Tools declared inline on the agent win on a
 * name clash.
 */
async function loadSiblingTools(agentFile: string): Promise<Record<string, AgentTool> | undefined> {
    const base = path.basename(agentFile).replace(/\.agent\.ts$/, "");
    const file = path.join(path.dirname(agentFile), `${base}.tool.ts`);
    if (!(await fs.exists(file))) return undefined;

    const module = await importDefinition(file, "Agent tool");
    const exported = Array.isArray(module?.default) ? module.default : [module?.default];
    const tools: Record<string, AgentTool> = {};

    for (const tool of exported) {
        if (!tool?._isTool_) {
            logger.warn(`'${file}' does not export a define.Tool — ignored`);
            continue;
        }
        if (tool.enabled === false) continue;
        if (!tool.id) {
            logger.warn(`A tool in '${file}' has no id — ignored (define.Tool requires one)`);
            continue;
        }
        tools[tool.id] = tool;
    }

    return Object.keys(tools).length ? tools : undefined;
}

/** Merge file tools under the inline ones — an inline tool is an explicit choice. */
function mergeTools(
    fromFiles: Record<string, AgentTool> | undefined,
    inline: AgentDefinition["tools"],
): AgentDefinition["tools"] {
    if (!fromFiles) return inline;
    if (!inline) return fromFiles;
    const own = Array.isArray(inline)
        ? Object.fromEntries(inline.map((tool) => [tool.id!, tool]))
        : inline;
    return { ...fromFiles, ...own };
}

async function syncAgents(): Promise<void> {
    registry.clear();
    definitions.length = 0;
    // A re-scan reconnects the remote MCP servers (they are cached per URL)
    await closeMcpClients().catch(() => {});
    const memories: Array<{ _tenant_: string; collection: string }> = [];

    for (const tenant of cfg.tenants ?? []) {
        for (const root of agentRoots(tenant.dir)) {
            const agentsPath = path.join(process.cwd(), root.dir);
            if (!(await fs.exists(agentsPath))) continue;
            if (!(await fs.stat(agentsPath)).isDirectory()) continue;
            if (root.legacy) {
                warnLegacy(tenant.id, path.join(tenant.dir, "agents"), path.join(tenant.dir, "ai", "agents"));
            }

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
                    // `skills` are read **once**, here: a run injects the documents into
                    // its prompt, it never touches the filesystem
                    const baseDir = path.join(process.cwd(), tenant.dir);
                    const skills = await resolveSkills(definition.skills, { baseDir, agentId: id });
                    const tools = mergeTools(await loadSiblingTools(file), definition.tools);

                    // A referenced sub-agent brings its own declaration: its `skills` are
                    // resolved here too, so delegating is the same as running it directly
                    // (and still never reads a file at run time)
                    for (const referenced of definition.agents
                        ? (Array.isArray(definition.agents) ? definition.agents : [definition.agents])
                        : []) {
                        if (referenced && !referenced._skills_?.length) {
                            referenced._skills_ = await resolveSkills(referenced.skills, { baseDir, agentId: referenced.id });
                        }
                    }

                    const instance = new Agent({ ...definition, id, tools, _skills_: skills }, { tenant: tenant.id });
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
    /** Re-scan `{tenant.dir}/ai/agents` (and the legacy `agents/`) and rebuild the registry. */
    reload: syncAgents,
    /** `{ total, tenants }` — what the boot banner prints. */
    stats: agentsStats,
    memory: {
        InMemory: InMemoryAgentMemory,
        Mongo: MongoAgentMemory,
        Redis: RedisAgentMemory,
        // Your own storage — scoping and the message cap are applied for you.
        custom: customAgentMemory,
        // A `load`/`save` processor, not a store: recalls past messages by meaning
        // from **your** vector index (`embed`, `search`, `upsert`).
        semanticRecall,
        // A `load` processor, not a store: it compacts a thread with **your** model
        // and prompt. Every store above is a backend; this one shapes the prompt.
        summarize,
    },
};

/** Mongo collections used as agent memory by a tenant — published by the loader. */
function agentMemoryCollections(tenantId: string): string[] {
    return (cfg.agentMemories ?? [])
        .filter((memory) => memory._tenant_ === tenantId)
        .map((memory) => memory.collection);
}

export { syncAgents, createAgents, agentsStats, agents, agentMemoryCollections, InMemoryAgentMemory, MongoAgentMemory, RedisAgentMemory };
