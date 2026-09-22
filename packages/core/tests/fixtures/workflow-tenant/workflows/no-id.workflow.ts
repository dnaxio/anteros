// Test fixture — no `id`: must be ignored (with a warning), not registered
// under a bogus `undefined` key.
export default {
    _isWorkflow_: true,
    name: "Anonymous",
    steps: [{ id: "run", exec: async () => ({ ok: true }) }],
};
