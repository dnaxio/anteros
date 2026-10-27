import { define, v } from "../../../../../../index";

/** Loaded for `billing.agent.ts`, in the same sub-directory. */
export default define.Tool({
    id: "refund",
    description: "Refunds an order",
    inputSchema: v.object({ order: v.string().required() }),
    execute: async ({ order }: any) => ({ order, status: "refunded" }),
});
