import { define, v } from "../../../../../../index";

/** MCP tool served by the tenant's MCP endpoint. */
export default define.McpTool({
    name: "echo",
    description: "Echoes the given text",
    inputSchema: v.object({ text: v.string().required() }),
    exec: async ({ args }) => ({ content: [{ type: "text", text: String(args.text) }] }),
});
