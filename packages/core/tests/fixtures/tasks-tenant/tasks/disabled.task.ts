import { define } from "../../../../index";

/** Disabled in code — never registered. */
export default define.Task({
    id: "disabled",
    schedule: "0 12 1 1 *",
    enabled: false,
    run: async () => {},
});
