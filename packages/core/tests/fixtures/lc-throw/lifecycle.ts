// Test fixture — `beforeBoot` throws.
export default {
    _isLifecycle_: true,
    enabled: true,
    beforeBoot: async () => { throw new Error("boom"); },
};
