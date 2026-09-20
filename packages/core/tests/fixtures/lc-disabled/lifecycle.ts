// Test fixture — disabled lifecycle (must be skipped).
const calls: string[] = [];
(globalThis as any).__lcDisabled = calls;

export default {
    _isLifecycle_: true,
    enabled: false,
    beforeBoot: async () => { calls.push("beforeBoot"); },
    afterBoot: async () => { calls.push("afterBoot"); },
    onDestroy: async () => { calls.push("onDestroy"); },
};
