import { define } from "../../../../index";

// Reproduces the Mongo error `sparse: null is not convertible to bool`:
// an explicit `indexOptions.sparse: null` must be ignored (never sent to Mongo),
// and `unique` accepts the Mongo 1/0 style (coerced to a real boolean).
export default define.Collection({
    slug: "variants",
    fields: [
        { name: "name", type: "string", index: true, indexOptions: { sparse: null as any } },
        { name: "sku", type: "string", unique: 1 },
        { name: "price", type: "number" },
    ],
    api: { access: { "*": true } },
});
