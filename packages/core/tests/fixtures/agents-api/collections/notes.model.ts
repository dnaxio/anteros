import { define } from "../../../../index";

/**
 * A collection whose hook uses `agents` — proving the LLM registry is injected
 * into the hook context exactly like `rest` and `io`.
 *
 * The observation is published on `globalThis` (the test reads it back): a hook
 * must not stuff arbitrary keys into `meta.data`, the collection schema rejects
 * them (`allowUnknown: false`).
 */
export default define.Collection({
    slug: "notes",
    fields: [{ name: "title", type: "string" }],
    hooks: {
        beforeOperation: define.Hook(async ({ agents, api, rest, meta }) => {
            if (meta.action !== "insertOne") return;
            (globalThis as any).__agentsHookProbe = {
                ids: agents.ids().sort(),
                bound: agents.get("assistant")?.getRest() === rest,
                // The in-process facade, bound to the same `rest`
                slug: api.collection("notes").getSlug(),
                notes: await api.collection("notes").countDocuments(),
            };
        }),
    },
});
