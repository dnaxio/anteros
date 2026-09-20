// Test fixture — must NOT run in replication-only mode (no `runScripts`).
export default {
    _isScript_: true,
    enabled: true,
    exec: async () => {
        await Bun.write(new URL("../.markers/script.txt", import.meta.url), "ran");
    },
};
