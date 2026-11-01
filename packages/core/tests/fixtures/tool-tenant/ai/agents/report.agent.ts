import { define } from "../../../../../index";

/**
 * Loader fixture for the description rule — `report.tool.ts` beside it exports one
 * usable tool and one without a description, which the loader must skip.
 */
export default define.Agent({
    id: "report",
    description: "Reports on charts",
    instructions: "You build charts.",
    provider: { model: "test-model", protocol: "openai", apiKey: "fixture-key" },
});
