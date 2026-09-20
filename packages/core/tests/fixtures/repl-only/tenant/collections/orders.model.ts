// Test fixture — a replicable collection (plain object + marker, no import needed).
export default {
    _isCollection_: true,
    _isTimeSerie_: false,
    type: "document",
    slug: "orders",
    fields: [
        { name: "ref", type: "string" },
        { name: "total", type: "number" },
    ],
    api: { access: { "*": true } },
    // Opt this collection into the data replication engine
    replication: { enabled: true },
};
