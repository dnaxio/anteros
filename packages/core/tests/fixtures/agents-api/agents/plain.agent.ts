import { define } from "../../../../index";

/**
 * Public agent — `generate` is allowed without a token. Declares no memory and
 * no `api.object`, to exercise `AGENT_NO_MEMORY` / `AGENT_NO_OBJECT_SCHEMA`.
 */
export default define.Agent({
    id: "plain",
    description: "A plain agent with no memory and no object schema.",
    instructions: "You are a plain agent.",
    provider: {
        model: "test-model",
        compatible: "openai",
        apiKey: "test-key",
        baseUrl: Bun.env.AGENT_API_TEST_URL ?? "http://127.0.0.1:1",
        options: { retries: 0 },
    },
    api: {
        // public on purpose: `object` also needs a rule so the *missing schema*
        // error can be exercised (otherwise the action is denied first)
        access: { generate: true, object: true },
    },
});
