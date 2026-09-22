import { define } from "../../../../index";

/** No `id` on purpose — the file name becomes the agent id (`support`). */
export default define.Agent({
    instructions: "You are a support agent.",
    provider: { model: "claude-test", compatible: "anthropic", apiKey: "fixture-key" },
});
