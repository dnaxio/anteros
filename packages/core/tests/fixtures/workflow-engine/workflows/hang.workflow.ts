// Test fixture — a step that outlives its `timeout` (150ms vs 1s by default).
export default {
    _isWorkflow_: true,
    id: "hang",
    name: "Hang",
    version: 1,
    steps: [
        {
            id: "hang",
            timeout: "150ms",
            exec: async ({ data }: any) => {
                await new Promise((resolve) => setTimeout(resolve, data?.ms ?? 1000));
                return { done: true };
            },
        },
    ],
};
