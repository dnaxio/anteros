import { define } from "../../../../index";

/** An invalid schedule — the loader skips it, the other tasks keep loading. */
export default define.Task({
    id: "invalid",
    schedule: "not a cron",
    run: async () => {},
});
