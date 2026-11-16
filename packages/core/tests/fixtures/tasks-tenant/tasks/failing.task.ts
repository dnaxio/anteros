import { define } from "../../../../index";

/** Fails on purpose — the scheduler must record the error, not crash. */
export default define.Task({
    id: "failing",
    schedule: "0 11 1 1 *",
    timezone: "UTC",
    run: async () => {
        throw new Error("boom");
    },
});
