import { define } from "../../../../index";

/** Declares no `api` at all — every action must be denied (secure by default). */
export default define.Agent({
    id: "private",
    description: "Not exposed over HTTP.",
    instructions: "You are a private agent.",
    provider: {
        model: "test-model",
        compatible: "openai",
        apiKey: "test-key",
        baseUrl: Bun.env.AGENT_API_TEST_URL ?? "http://127.0.0.1:1",
        options: { retries: 0 },
    },
});
