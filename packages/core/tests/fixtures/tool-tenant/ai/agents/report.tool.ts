import { define, v } from "../../../../../index";

export default [
    define.Tool({
        id: "chart",
        description: "Builds a chart for a metric",
        inputSchema: v.object({ metric: v.string().required() }),
        execute: async ({ metric }: any) => ({ metric, points: 3 }),
    }),
    // Deliberately not a define.Tool with a description: the loader must skip it.
    { id: "hidden", _isTool_: true, inputSchema: v.object({}), execute: () => null } as any,
];
