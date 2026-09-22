import type Joi from "joi";

/**
 * Schema helpers shared by the MCP server and the agent runtime.
 *
 * A tenant declares its schemas in Joi (the collection field DSL, `v`), but the
 * outside world speaks JSON Schema: the MCP protocol and every model provider
 * (`tools[].function.parameters` / `tools[].input_schema`) want JSON Schema.
 * Both callers use the same converter so a tool looks identical wherever it is
 * exposed. zod and plain JSON Schema objects are accepted as well.
 */

// ─── Joi → JSON Schema ───────────────────────────────────────────────────

function joiTypeToJson(type: string): string {
    switch (type) {
        case 'number': return 'number';
        case 'integer': return 'integer';
        case 'boolean': return 'boolean';
        case 'date': return 'string';
        default: return 'string';
    }
}

/** Minimal Joi → JSON Schema converter (covers the common field types). */
function joiToJsonSchema(schema: Joi.Schema, describe = schema.describe() as any): any {
    const node: any = {};
    const type = describe?.type;

    switch (type) {
        case 'object': {
            node.type = 'object';
            const properties: Record<string, any> = {};
            const required: string[] = [];
            for (const [key, child] of Object.entries(describe.keys ?? {})) {
                properties[key] = joiToJsonSchema(child as any, child);
                if ((child as any)?.flags?.presence === 'required') required.push(key);
            }
            node.properties = properties;
            if (required.length) node.required = required;
            break;
        }
        case 'array': {
            node.type = 'array';
            if (describe.items?.length) node.items = joiToJsonSchema(describe.items[0], describe.items[0]);
            break;
        }
        case 'alternatives': {
            // Joi alternatives → anyOf (only the simple `try` list is covered)
            const matches = (describe.matches ?? []).map((m: any) => joiToJsonSchema(m.schema, m.schema));
            if (matches.length) node.anyOf = matches;
            else node.type = 'object';
            break;
        }
        default: {
            node.type = joiTypeToJson(type);
            if (type === 'date') node.format = 'date-time';
            if (type === 'string') {
                for (const rule of describe.rules ?? []) {
                    if (['email', 'uri', 'uuid', 'isoDate', 'ip'].includes(rule.name)) {
                        node.format = rule.name;
                    }
                    if (rule.name === 'pattern' && rule.args?.regex) {
                        node.pattern = String(rule.args.regex).replace(/^\/|\/[gimsuy]*$/g, '');
                    }
                }
            }
            if (describe.valids?.length && describe.valids.length <= 50) {
                node.enum = describe.valids;
            }
            break;
        }
    }

    if (describe?.flags?.description) node.description = describe.flags.description;
    return node;
}

// ─── Detection ───────────────────────────────────────────────────────────

function isJoiSchema(schema: any): boolean {
    return !!schema && typeof schema === 'object'
        && typeof schema.describe === 'function' && typeof schema.validate === 'function';
}

function isZodSchema(schema: any): boolean {
    return !!schema && typeof schema === 'object'
        && typeof schema.safeParse === 'function' && (!!schema._zod || !!schema._def);
}

function isJsonSchema(schema: any): boolean {
    return !!schema && typeof schema === 'object'
        && (typeof schema.type === 'string' || !!schema.properties || !!schema.anyOf || !!schema.oneOf || !!schema.allOf);
}

// ─── zod → JSON Schema (zod is imported only when a zod schema is used) ──

let zodModule: any | undefined;

async function ensureZod(): Promise<any | null> {
    if (zodModule !== undefined) return zodModule;
    try {
        zodModule = await import("zod");
    } catch {
        zodModule = null;
    }
    return zodModule;
}

/** An open object schema — the fallback when nothing usable was declared. */
function openObjectSchema(): any {
    return { type: 'object', properties: {}, additionalProperties: true };
}

/**
 * Normalize a Joi / zod / JSON Schema into a JSON Schema object.
 * `undefined` → an open object (the provider requires *some* schema).
 */
async function toJsonSchema(schema?: any): Promise<any> {
    if (schema === undefined || schema === null) return openObjectSchema();
    if (isJoiSchema(schema)) return joiToJsonSchema(schema);
    if (isZodSchema(schema)) {
        const zod = await ensureZod();
        const convert = zod?.toJSONSchema ?? zod?.z?.toJSONSchema;
        if (typeof convert !== 'function') {
            console.error('zod schema support requires zod >= 4 (`z.toJSONSchema`) — schema ignored');
            return openObjectSchema();
        }
        try {
            return convert(schema, { unrepresentable: 'any' });
        } catch (err: any) {
            console.error(`Failed to convert the zod schema to JSON Schema: ${err?.message}`);
            return openObjectSchema();
        }
    }
    if (isJsonSchema(schema)) return schema;
    // Unknown shape (a boolean schema, a `{}`…) — pass it through
    return typeof schema === 'object' ? schema : openObjectSchema();
}

// ─── Validation ──────────────────────────────────────────────────────────

export type SchemaValidation = { value: any; error: string | null };

/**
 * Validate a value against a declared schema.
 * Joi and zod are enforced; a plain JSON Schema is not (there is no validator
 * in the dependency set) — the value is returned untouched.
 */
async function validateWithSchema(schema: any, value: any): Promise<SchemaValidation> {
    if (schema === undefined || schema === null) return { value, error: null };

    if (isJoiSchema(schema)) {
        const { error, value: validated } = schema.validate(value, {
            allowUnknown: true,
            stripUnknown: false,
            abortEarly: false,
            convert: true,
        });
        return { value: validated, error: error ? error.message : null };
    }

    if (isZodSchema(schema)) {
        const parsed = schema.safeParse(value);
        if (parsed.success) return { value: parsed.data, error: null };
        const first = parsed.error?.issues?.[0];
        const path = first?.path?.length ? `${first.path.join('.')}: ` : '';
        return { value, error: `${path}${first?.message ?? parsed.error?.message ?? 'invalid'}` };
    }

    return { value, error: null };
}

export {
    joiTypeToJson,
    joiToJsonSchema,
    isJoiSchema,
    isZodSchema,
    isJsonSchema,
    openObjectSchema,
    toJsonSchema,
    validateWithSchema,
};
