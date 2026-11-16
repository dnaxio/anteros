import { define } from "../../../../index";

/** A task that records each run — the test reads `task_runs` back. */
export default define.Task({
    id: "report",
    description: "Writes a marker for every run.",
    schedule: "0 10 1 1 *",
    timezone: "UTC",
    run: async ({ rest, tenant, trigger }) => {
        await rest.insertOne("task_runs", {
            task: "report",
            tenant: tenant.id,
            trigger,
            at: new Date(),
        });
    },
});
