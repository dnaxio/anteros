// Test fixture — one step, always succeeds. Shared in-process state:
// `globalThis.__wfEngine = { log: string[], attempts: Record<string, number> }`
const state = ((globalThis as any).__wfEngine ??= { log: [], attempts: {} });

export default {
    _isWorkflow_: true,
    id: "simple",
    name: "Simple",
    version: 1,
    steps: [
        {
            id: "one",
            exec: async ({ data }: any) => {
                state.log.push("simple:one");
                return { echo: data?.echo ?? null };
            },
        },
    ],
};
