// Test fixture — three steps, the middle one slow: lets a test pause or cancel
// the run while it is executing (and check that the last step never runs).
const state = ((globalThis as any).__wfEngine ??= { log: [], attempts: {} });

export default {
    _isWorkflow_: true,
    id: "slow",
    name: "Slow",
    version: 1,
    steps: [
        { id: "fast", exec: async () => { state.log.push("slow:fast"); return { fast: true }; } },
        {
            id: "slow",
            exec: async ({ data }: any) => {
                state.log.push("slow:slow:start");
                await new Promise((resolve) => setTimeout(resolve, data?.ms ?? 300));
                state.log.push("slow:slow:end");
                return { slow: true };
            },
        },
        { id: "last", exec: async () => { state.log.push("slow:last"); return { last: true }; } },
    ],
};
