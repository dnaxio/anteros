// Test fixture — a declared collection that opted into replication.
export default {
    _isCollection_: true,
    _isTimeSerie_: false,
    type: "document",
    slug: "orders",
    fields: [{ name: "title", type: "string" }],
    replication: { enabled: true },
};
