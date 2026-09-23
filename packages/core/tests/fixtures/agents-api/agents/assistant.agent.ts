import { define, v, agents } from "../../../../index";

/**
 * HTTP-API fixture — exposed through `POST /api/:tenant_id/agents/:agent/:action`.
 *
 * The provider endpoint comes from the environment so the test can point it at
 * its own fake provider (the port is chosen by the OS).
 */
export default define.Agent({
    id: "assistant",
    name: "Assistant",
    description: "Fixture agent for the HTTP API",
    instructions: "You are a fixture agent.",
    provider: {
        model: "test-model",
        compatible: "openai",
        apiKey: "test-key",
        baseUrl: Bun.env.AGENT_API_TEST_URL ?? "http://127.0.0.1:1",
        options: { retries: 0 },
    },
    maxSteps: 3,
    memory: new agents.memory.InMemory(),
    tools: {
        echo: define.Tool({
            id: "echo",
            description: "Echoes the given text",
            inputSchema: v.object({ text: v.string().required() }),
            execute: async ({ text }) => ({ echoed: text }),
        }),
    },
    api: {
        access: {
            // public metadata — no token needed
            info: true,
            generate: (ctx) => !!ctx.token.value,
            stream: (ctx) => !!ctx.token.value,
            object: (ctx) => !!ctx.token.value,
            history: (ctx) => !!ctx.token.value,
            threads: (ctx) => !!ctx.token.value,
            clear: (ctx) => !!ctx.token.value,
        },
        object: {
            schema: v.object({ city: v.string().required(), celsius: v.number().required() }),
        },
    },
});
