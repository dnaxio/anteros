import { define } from "../../../../index";

// Reproduces the Mongo error `sparse: null is not convertible to bool`:
// `indexOptions.sparse` explicit à null doit être ignoré (jamais envoyé à Mongo),
// et `unique` accepte le style Mongo 1/0 (coercé en vrai booléen).
export default define.Collection({
    slug: "variants",
    fields: [
        { name: "name", type: "string", index: true, indexOptions: { sparse: null as any } },
        { name: "sku", type: "string", unique: 1 },
        { name: "price", type: "number" },
    ],
    api: { access: { "*": true } },
});
