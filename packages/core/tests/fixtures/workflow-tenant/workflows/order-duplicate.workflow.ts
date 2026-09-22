// Test fixture — same `id` as order.workflow.ts: the duplicate must be reported
// and only one definition kept (never two entries, never a crash). The context
// declaration is identical on purpose: whichever file wins, the indexes exist.
export default {
    _isWorkflow_: true,
    id: "order",
    name: "Orders (duplicate definition)",
    context: {
        customerId: { type: "string", index: true },
        total: { type: "number", index: -1 },
    },
    steps: [{ id: "charge", exec: async () => ({ charged: false }) }],
};
