import { define } from "../../../../index";

/** Written by the fixture task — proves `rest` in a run targets the tenant. */
export default define.Collection({
    slug: "task_runs",
    fields: [
        { name: "task", type: "string" },
        { name: "tenant", type: "string" },
        { name: "trigger", type: "string" },
        { name: "at", type: "date" },
    ],
});
