import { define, v } from "@anteros/core"

/**
 * Example MCP tool — exposed to LLM clients at `POST /api/{{tenant}}/mcp`
 * (Model Context Protocol, Streamable HTTP).
 *
 * `inputSchema` uses the same Joi instance (`v`) as collections, and `exec`
 * returns the MCP `CallToolResult` shape.
 */
export default define.McpTool({
  name: "items-summary",
  description: "Count the items and return the most recent ones",

  inputSchema: v.object({
    limit: v.number().integer().min(1).max(20).default(5),
  }),

  exec: async ({ rest, args }) => {
    const [total, latest] = await Promise.all([
      rest.countDocuments("items"),
      rest.find("items", { $sort: { createdAt: -1 }, $limit: args.limit }),
    ])

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ total, latest }, null, 2),
        },
      ],
    }
  },
})
