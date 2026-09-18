import { define } from "@anteros/core"

/**
 * Example collection — exposed at `POST /api/{{tenant}}/items/:action`
 * (`find`, `findOne`, `insertOne`, `updateOne`, `deleteOne`, …).
 *
 * Docs: https://github.com/dnaxio/anteros
 */
export default define.Collection({
  slug: "items",

  api: {
    // Wide open while you are building — tighten this before production.
    access: { "*": true },
  },

  fields: [
    { name: "name", type: "string", required: true },
    { name: "description", type: "string" },
    { name: "done", type: "boolean", defaultValue: false },
  ],
})
