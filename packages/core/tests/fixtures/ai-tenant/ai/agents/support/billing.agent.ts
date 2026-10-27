import { define } from "../../../../../../index";

/** Its own sub-directory — the sibling tool is resolved there. */
export default define.Agent({
    id: "billing",
    description: "Handles refunds.",
    instructions: "You handle billing.",
    provider: { model: "test-model", apiKey: "fixture-key", baseUrl: "http://127.0.0.1:1", options: { retries: 0 } },
});
