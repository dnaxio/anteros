import { define } from "../../../../index";

/** A route reading the LLM registry **and the in-process facade** from its context. */
export default define.Route({
    method: "GET",
    path: "/probe",
    handler: async ({ agents, api, rest }) => Response.json({
        agents: agents.ids().sort(),
        hasAssistant: !!agents.get("assistant"),
        // `api` groups the same calls as `rest` — bound and namespaced
        slug: api.collection("notes").getSlug(),
        notes: await api.collection("notes").countDocuments(),
        sameAsRest: (await api.collection("notes").find()) .length === (await rest.find("notes")).length,
        agentBound: api.agent("assistant")?.getRest() === rest,
        unknownAgent: api.agent("ghost"),
        vars: typeof api.vars.get,
        serviceRun: typeof api.service("probe").run,
        serviceCall: await api.service("probe").run("echo", { from: "route" }),
        fileUrl: api.files.url("invoices", "f1.pdf", { width: 800 }),
    }),
});
