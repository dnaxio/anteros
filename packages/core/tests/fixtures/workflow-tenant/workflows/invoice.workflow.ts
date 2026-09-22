// Test fixture — a second valid workflow, with a different `version` so tests
// can assert on a definition that is not the duplicated `order`.
export default {
    _isWorkflow_: true,
    id: "invoice",
    name: "Invoices",
    version: 3,
    context: {
        companyId: { type: "string", index: true },   // → index context.companyId_1
        processedAt: { type: "date" },                 // validated + coerced to a Date
    },
    // Beyond `context.index`: compound, unique, sparse, named
    indexes: [
        { key: { "context.companyId": 1, status: 1 } },
        { key: { "context.batchId": 1 }, unique: true, sparse: true, name: "uniq_batch" },
    ],
    steps: [
        { id: "generate", exec: async ({ data }: any) => ({ generated: data?.ref ?? null }) },
        { id: "send", exec: async () => ({ sent: true }) },
    ],
};
