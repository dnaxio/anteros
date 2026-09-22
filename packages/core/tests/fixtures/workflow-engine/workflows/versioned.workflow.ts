// Test fixture — used to check the resume version guard: the test mutates
// `version` on the registered definition after a run has started.
const state = ((globalThis as any).__wfEngine ??= { log: [], attempts: {} });

export default {
    _isWorkflow_: true,
    id: "versioned",
    name: "Versioned",
    version: 1,
    steps: [
        {
            id: "v",
            exec: async () => {
                state.log.push("versioned:v");
                return { ok: true };
            },
        },
    ],
};
