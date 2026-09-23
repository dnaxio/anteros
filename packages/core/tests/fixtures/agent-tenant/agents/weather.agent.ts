import { define, v } from "../../../../index";

/**
 * Loader fixture — `{tenant.dir}/agents/**\/*.agent.ts`.
 * No call is ever made against the provider here: only the loader is exercised.
 */
export default define.Agent({
    id: "weather",
    name: "Weather Agent",
    description: "Answers weather questions with a tool call",
    instructions: "You are a concise weather assistant.",
    provider: { model: "test-model", compatible: "openai", apiKey: "fixture-key" },
    tools: {
        forecast: define.Tool({
            id: "forecast",
            description: "Current weather for a city",
            inputSchema: v.object({ city: v.string().required() }),
            execute: async ({ city }) => ({ city, celsius: 21 }),
        }),
    },
});
