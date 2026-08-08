import { define, v } from "../../../../../index";

export default define.McpTool({
    name: "badge",
    description: "Returns an image content block (protocol passthrough)",
    inputSchema: v.object({}),
    exec: async () => {
        return {
            content: [{
                type: "image",
                data: "aGVsbG8=", // "hello" base64
                mimeType: "image/png",
            }],
        };
    },
});
