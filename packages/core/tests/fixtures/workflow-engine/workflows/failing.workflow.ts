// Test fixture — `b` always fails, `a` must be compensated (once, never twice).
// Also proves the step ctx `rest` is a real tenant client.
const state = ((globalThis as any).__wfEngine ??= { log: [], attempts: {} });

export default {
    _isWorkflow_: true,
    id: "failing",
    name: "Failing",
    version: 1,
    steps: [
        {
            id: "a",
            exec: async ({ rest }: any) => {
                state.log.push(`failing:a:rest=${typeof rest?.find === "function" ? "client" : "engine"}`);
                // A sub-workflow, through the client handed to the step
                await rest.workflow.run("simple", { echo: "sub" });
                state.log.push("failing:a:sub-workflow-done");
                return { a: 1 };
            },
        },
        { id: "b", exec: async () => { state.log.push("failing:b"); throw new Error("boom-b"); } },
        { id: "c", exec: async () => { state.log.push("failing:c"); return { c: 1 }; } },
    ],
    compensations: [
        {
            id: "undo-a",
            depend: ["a"],
            exec: async () => {
                state.attempts["undo-a"] = (state.attempts["undo-a"] ?? 0) + 1;
                state.log.push(`failing:undo-a:${state.attempts["undo-a"]}`);
            },
        },
    ],
};
