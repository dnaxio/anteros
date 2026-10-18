// Test fixture — a namespace WITHOUT a declared `scope` (the #34 case), whose
// `all` rule also proves the access rule receives `{ namespace, body }`.
export default {
    _isVars_: true,
    namespace: "open",
    vars: { token: "s3cret" },
    api: {
        access: {
            all: (ctx: any) => ctx.namespace === "open" && !!ctx.body,
            set: true,
            get: true,
            entries: true,
            clear: true,
            del: true,
        },
    },
    replication: { enabled: false },
};
