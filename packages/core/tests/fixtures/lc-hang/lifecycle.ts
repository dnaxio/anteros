// Test fixture — `onDestroy` never resolves (used to test destroyTimeout).
const calls: string[] = [];
(globalThis as any).__lcHang = calls;

export default {
    _isLifecycle_: true,
    enabled: true,
    destroyTimeout: 100,
    onDestroy: async () => {
        calls.push("onDestroy:start");
        await new Promise(() => { /* never resolves */ });
    },
};
