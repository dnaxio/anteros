import { define } from "../../../../index";

/**
 * Fixture — an agent whose system prompt carries skills, declared every way a
 * source can be: a glob of a folder, one file, a regex over the tenant, and the
 * `SKILL.md` directory layout.
 *
 * The last two patterns overlap on purpose (`./docs/*.md` and the `docs` regex):
 * a file matched twice is one skill.
 */
export default define.Agent({
    id: "docs",
    description: "Answers from the tenant's own documentation.",
    instructions: "Answer from the documentation you were given.",
    provider: { model: "claude-test", compatible: "anthropic", apiKey: "fixture-key" },
    skills: [
        "./docs/*.md",
        "./guide/ml.md",
        /^docs\/.*\.md$/,
        /^runbooks\/.*$/,
        "./guides/**/SKILL.md",
    ],
});
