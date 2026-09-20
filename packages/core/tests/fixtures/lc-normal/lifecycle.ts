// Test fixture — records lifecycle calls on globalThis.
const calls: string[] = [];
(globalThis as any).__lcNormal = calls;

export default {
    _isLifecycle_: true,
    enabled: true,
    destroyTimeout: 200,
    beforeBoot: async ({ replication }: any) => {
        calls.push("beforeBoot");
        // The API is tenant-bound (like `rest`) — no tenant id is passed, and the
        // implicit tenant must match this lifecycle's tenant.
        const seeded = await replication.seed("latest");
        (globalThis as any).__lcReplicationApi =
            typeof replication?.seed === "function" &&
            typeof replication?.reset === "function" &&
            typeof replication?.now === "function" &&
            typeof replication?.state === "function" &&
            seeded?.tenant === "normal";
    },
    afterBoot: async () => { calls.push("afterBoot"); },
    onDestroy: async ({ reason }: any) => { calls.push(`onDestroy:${reason}`); },
};
