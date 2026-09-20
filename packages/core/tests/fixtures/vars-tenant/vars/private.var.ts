// Test fixture — a namespace WITHOUT `api.access` (must be denied over HTTP).
export default {
    _isVars_: true,
    namespace: "private",
    vars: { secret: "shh" },
};
