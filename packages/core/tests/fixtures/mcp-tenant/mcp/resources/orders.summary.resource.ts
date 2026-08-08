import { define } from "../../../../../index";

// Static resource — fixed URI
export default define.McpResource({
    name: "orders-summary",
    description: "Summary of orders",
    uri: "orders://summary",
    read: async ({ params }) => {
        return {
            contents: [{
                uri: "orders://summary",
                mimeType: "application/json",
                text: JSON.stringify({ total: 42, pending: 7, params }),
            }],
        };
    },
});
