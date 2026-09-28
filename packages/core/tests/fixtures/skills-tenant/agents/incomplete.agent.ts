import { define } from "../../../../index";

/**
 * Fixture — an agent whose skill is malformed (`broken/no-name.md` has no `name`).
 *
 * A broken skill refuses **this agent** at load, and must not hide the others.
 */
export default define.Agent({
    id: "incomplete",
    description: "Carries a skill that does not follow the format.",
    instructions: "Nothing to see here.",
    provider: { model: "claude-test", compatible: "anthropic", apiKey: "fixture-key" },
    skills: ["./broken/no-name.md"],
});
