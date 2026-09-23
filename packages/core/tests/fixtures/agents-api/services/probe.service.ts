import { define } from "../../../../index";

/** A service action reading the LLM registry and the facade from its context. */
export default define.Service({
    name: "probe",
    enabled: true,
    actions: {
        check: async ({ agents, api, rest }) => ({
            agents: agents.ids().sort(),
            hasAssistant: !!agents.get("assistant"),
            bound: agents.get("assistant")?.getRest() === rest,
            tenant: rest.tenant_id,
            // `api.service(name).run` is the grouped `rest.runService`
            nested: await api.service("probe").run("echo", { from: "api" }),
            varType: typeof api.vars.get,
        }),
        echo: async ({ data }) => data,
    },
});
