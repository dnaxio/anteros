import { define } from "../../../../../../index";

/** MCP resource exposed by URI. */
export default define.McpResource({
    name: "readme",
    description: "The tenant readme",
    uri: "readme://tenant",
    read: async () => ({ contents: [{ uri: "readme://tenant", text: "hello" }] }),
});
