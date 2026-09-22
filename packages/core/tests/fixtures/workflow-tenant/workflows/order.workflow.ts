// Test fixture — a valid, enabled workflow with declared context fields.
export default {
    _isWorkflow_: true,
    enabled: true,
    id: "order",
    name: "Orders",
    version: 2,
    context: {
        customerId: { type: "string", index: true },   // → index context.customerId_1
        total: { type: "number", index: -1 },          // → index context.total_-1
        note: { type: "string" },                      // not indexed
    },
    steps: [
        { id: "charge", exec: async ({ data }: any) => ({ charged: data?.ref ?? null }) },
        { id: "notify", exec: async () => ({ notified: true }) },
    ],
};
