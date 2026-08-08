import { define, v } from "../../../../../index";

// Template resource — dynamic URI (params extracted from the URI)
export default define.McpResource({
    name: "users-by-id",
    description: "Fetch a user by id",
    uri: "users://{id}",
    mimeType: "application/json",
    read: async ({ params, uri }) => {
        return {
            contents: [{
                uri,
                mimeType: "application/json",
                text: JSON.stringify({ id: params.id, name: `User ${params.id}` }),
            }],
        };
    },
});
