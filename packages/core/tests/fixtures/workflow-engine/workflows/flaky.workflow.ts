// Test fixture — a step that fails until `data.failUntil` attempts are reached,
// with retries. Used to prove a transient failure does not roll the saga back.
const state = ((globalThis as any).__wfEngine ??= { log: [], attempts: {} });

export default {
    _isWorkflow_: true,
    id: "flaky",
    name: "Flaky",
    version: 1,
    steps: [
        {
            id: "unstable",
            retries: 2,
            backoffMs: 1,
            exec: async ({ data }: any) => {
                const n = (state.attempts.unstable = (state.attempts.unstable ?? 0) + 1);
                state.log.push(`flaky:attempt:${n}`);
                if (n <= (data?.failUntil ?? 0)) throw new Error(`transient failure ${n}`);
                return { attempts: n };
            },
        },
    ],
};
