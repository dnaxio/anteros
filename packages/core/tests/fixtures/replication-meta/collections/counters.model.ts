// Test fixture — a collection whose replication key is a **number** (not a date).
// The delete guard must still match on the destination.
export default {
    _isCollection_: true,
    _isTimeSerie_: false,
    type: "document",
    slug: "counters",
    fields: [
        { name: "seq", type: "number" },
        { name: "title", type: "string" },
    ],
    replication: { enabled: true, key: "seq" },
};
