import { z } from "zod";
import { define, v } from "../index";

/**
 * Compile-time contract of `define.Tool` — checked by `tsc`, not by `bun test`.
 *
 * Every `@ts-expect-error` fails the type-check when the error disappears, so a
 * regression in the exported types is caught even though nothing runs.
 */

// The description is required: a tool the model cannot understand is not usable.
// @ts-expect-error — `description` is missing
define.Tool({ id: "no-description", execute: () => 1 });

// A zod schema types the handler's input (`z.output`).
const typed = define.Tool({
    id: "typed",
    description: "Typed by its schema",
    inputSchema: z.object({ city: z.string(), days: z.number().optional() }),
    execute: ({ city, days }) => city.toUpperCase() + (days ?? 0),
});
// @ts-expect-error — `city` is a string, not a number
typed.execute!({ city: 42 }, {} as any);

// Joi cannot infer types, so an explicit parameter does the job.
const explicit = define.Tool<{ city: string }>({
    id: "explicit",
    description: "Explicit input type",
    inputSchema: v.object({ city: v.string().required() }),
    execute: ({ city }) => city.length,
});
// @ts-expect-error — `city` is a string, not a number
explicit.execute!({ city: 1 }, {} as any);
