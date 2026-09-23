import { define, agents } from "../../../../index";

/**
 * The collection this tenant names for its agent memory. The loader publishes it
 * (`cfg.agentMemories`), so the replication engine copies it like a declared
 * collection — `replication.exclude: ['memory']` is the opt-out.
 */
export const AGENT_THREADS = "agent_threads";

export default define.Agent({
    id: "chat",
    description: "Fixture agent whose memory lives in a tenant-named collection.",
    instructions: "Fixture agent — no model call is ever made in these tests.",
    provider: { model: "test-model", compatible: "openai", apiKey: "fixture" },
    memory: new agents.memory.Mongo({ collection: AGENT_THREADS }),
});
