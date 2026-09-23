import { define } from "../../../../index";

/** A second agent of the fixture tenant — no tool, no memory. */
export default define.Agent({
    id: "support",
    description: "Answers support questions.",
    instructions: "You are a support agent.",
    provider: { model: "claude-test", compatible: "anthropic", apiKey: "fixture-key" },
});
