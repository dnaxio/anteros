// Test fixture — `beforeBoot` / `onDestroy` must still run in replication-only
// mode (the documented place to seed or reset a replication before it starts).
// Each hook drops a marker file the test can assert on.
// (`enabled` mirrors what `define.Lifecycle` sets by default.)
export default {
    _isLifecycle_: true,
    enabled: true,
    beforeBoot: async () => {
        await Bun.write(new URL("./.markers/lifecycle.txt", import.meta.url), "beforeBoot");
    },
    onDestroy: async () => {
        await Bun.write(new URL("./.markers/onDestroy.txt", import.meta.url), "onDestroy");
    },
};
