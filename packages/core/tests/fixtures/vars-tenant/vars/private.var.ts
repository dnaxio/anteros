// Test fixture — a namespace WITHOUT `api.access` (must be denied over HTTP),
// and which explicitly opts OUT of replication.
export default {
    _isVars_: true,
    namespace: "private",
    vars: { secret: "shh" },
    // Framework collections are replicated by default: opting out is explicit
    replication: { enabled: false },
};
