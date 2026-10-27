import { define } from "../../../../../index";

/** Agent of the `ai/` fixture — its tools come from the sibling `.tool.ts`. */
export default define.Agent({
    id: "support",
    description: "Answers support questions, with a co-located tool.",
    instructions: "You are a support agent.",
    provider: { model: "test-model", apiKey: "fixture-key", baseUrl: "http://127.0.0.1:1", options: { retries: 0 } },
});
