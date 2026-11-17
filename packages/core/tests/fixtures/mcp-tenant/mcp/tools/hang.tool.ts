import { define, v } from "../../../../../index";

/** Never answers — the MCP client's call deadline (#56) is what must stop it. */
export default define.McpTool({
    name: "hang",
    description: "Accepts the call and never answers.",
    inputSchema: v.object({}),
    exec: () => new Promise(() => { /* deliberately never settles */ }),
});
