// Test fixture — `enabled: false` must not be registered.
export default {
    _isWorkflow_: true,
    enabled: false,
    id: "nightly",
    name: "Nightly",
    steps: [{ id: "run", exec: async () => ({ ok: true }) }],
};
