import { define, v } from "../../../../../index";

export default define.McpTool({
    name: "echo",
    description: "Echoes the message back to the caller",
    inputSchema: v.object({
        msg: v.string().required().description("The message to echo"),
        times: v.number().integer().min(1).max(5).default(1),
    }),
    exec: async ({ args }) => {
        // Protocol format: { content: [...] }
        return {
            content: [{
                type: "text",
                text: JSON.stringify({ echoed: args.msg, times: args.times, at: new Date().toISOString() }),
            }],
        };
    },
});
