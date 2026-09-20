// Test fixture — a `define.Vars` definition (plain object + marker).
export default {
    _isVars_: true,
    namespace: "config",
    scope: { name: "company", type: "relationship", relation: { to: "companies" } },
    meta: [
        { name: "note", type: "string" },
        { name: "expiresAt", type: "datetime-local" },
    ],
    vars: {
        licence: "RDX00",
        maxUsers: { type: "number", defaultValue: 100 },
        session: { type: "string", ttl: "1h" },
    },
    api: {
        access: {
            "*": true,
            set: true,
        },
    },
    // Opt this namespace into replication (per-namespace filter on `ns`).
    replication: { enabled: true },
};
