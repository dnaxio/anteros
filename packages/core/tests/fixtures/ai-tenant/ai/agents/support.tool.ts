import { define, v } from "../../../../../index";

/** Loaded automatically for `support.agent.ts` (same directory, same basename). */
export default define.Tool({
    id: "greet",
    description: "Greets the caller",
    inputSchema: v.object({ name: v.string().required() }),
    execute: async ({ name }: any) => ({ hello: name }),
});
