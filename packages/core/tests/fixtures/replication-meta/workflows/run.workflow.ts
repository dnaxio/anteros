// Test fixture — a workflow whose runs must follow the data to the destination.
export default {
    _isWorkflow_: true,
    id: "run",
    name: "Run",
    version: 1,
    steps: [{ id: "one", exec: async () => ({ ok: true }) }],
};
