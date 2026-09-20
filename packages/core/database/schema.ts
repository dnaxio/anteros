
import type { Collection as CollectionType } from "../types/collection";
import type { Field } from "../types/field";
import Joi, { type AnySchema } from "joi";


let s = Joi.object({
    name: Joi.string().required(),
})




/**
 * Build the Joi schema for a single field. Assumes `f.type` is set.
 * Extracted so other features (e.g. `define.Vars`) can validate with the exact
 * same rules as collections — without the `Joi.object(...).min(1)` wrapper.
 */
function fieldToSchema(f: Field): AnySchema | undefined {
    let schema: AnySchema | undefined

    if (f.type == 'string') {
        schema = Joi.string()
    }

    if (f.type == 'password') {
        schema = Joi.string()
    }

    if (f.type == 'number') {
        schema = Joi.number()
    }

    if (f.type == 'integer') {
        schema = Joi.number().integer()
    }

    if (f.type == 'boolean') {
        schema = Joi.boolean()
    }

    if (f.type.match(/(date|datetime-local)/)) {
        schema = Joi.date()
    }

    if (f.type == 'array') {
        schema = Joi.array()
    }

    if (f.type == 'json') {
        schema = Joi.object()
    }

    if (f.type == 'uuid') {
        schema = Joi.string().uuid()
    }
    if (f.type == 'email') {
        schema = Joi.string().email()
    }

    if (f.type == 'url') {
        schema = Joi.string().uri()
    }

    if (f.type == 'slug') {
        let slug = Joi.string().pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        if (f.slugOptions?.min != null) slug = slug.min(f.slugOptions.min)
        if (f.slugOptions?.max != null) slug = slug.max(f.slugOptions.max)
        schema = slug
    }

    if (f.type == 'ipv4') {
        schema = Joi.string().ip({ version: 'ipv4' })
    }

    if (f.type == 'ipv6') {
        schema = Joi.string().ip({ version: 'ipv6' })
    }

    if (f.type == 'enum' && !f.enumOptions?.multiple) {
        schema = Joi.string().valid(...f.enumOptions?.items || [])
    }

    if (f.type == 'enum' && f.enumOptions?.multiple) {
        schema = Joi.array().items(Joi.string().valid(...f.enumOptions?.items || []))
    }

    if (f.type == 'random') {
        schema = Joi.string()
    }

    if (f.type == 'random' && f?.randomOptions?.toNumber) {
        schema = Joi.number()
    }

    if (f?.type.match(/(geojson\.Point|geojson\.LineString|geojson\.Polygon)/)) {
        schema = Joi.object({
            type: Joi.string().valid("Point", "LineString", "Polygon", "MultiPoint").required(),
            coordinates: Joi.alternatives().conditional("type", [
                {
                    is: "Point",
                    then: Joi.array().items(Joi.number()).length(2).required(), // [lng, lat]
                },
                {
                    is: Joi.string().valid("LineString", "MultiPoint"),
                    then: Joi.array().items(Joi.array().items(Joi.number()).length(2)).required(), // [[lng, lat], ...]
                },
                {
                    is: "Polygon",
                    then: Joi.array().items(Joi.array().items(Joi.array().items(Joi.number()).length(2))).required(), // [[[lng, lat], ...]]
                },
            ]),
        });
    }

    if (f?.type == 'relationship') {
        schema = Joi.string().optional().messages({
            'string.base': `${f.name} must be  a string (ObjectId)`,
        })
    }

    if (f?.type == 'relationship' && f?.relation?.hasMany) {
        schema = Joi.array().items(Joi.string().optional()).messages({
            'string.base': `${f.name} must be  a string (ObjectId)`,
        })
    }

    if (f.validate?.schema) {
        schema = f.validate.schema
    }

    if (f?.required) {
        schema = schema?.required()
    } else {
        schema = schema?.optional()
    }

    if (f?.nullable) {
        schema = schema?.allow(null)
    }

    if (f?.empty) {
        schema = schema?.allow('')
    }

    return schema
}


function buildSchema(col: CollectionType, opts = {
    partial: false
}) {

    let propertiesSchema = {
        createdAt: Joi.date(),
        updatedAt: Joi.date(),
    } as {
        [key: string]: AnySchema
    }
    for (const f of col.fields) {

        if (f.type && f.name) {

            let fieldName = f.name
            const fieldSchema = fieldToSchema(f)
            if (fieldSchema) propertiesSchema[fieldName] = fieldSchema

        }
    }

    let schema = Joi.object(propertiesSchema).min(1)
    return opts.partial ? buildSchemaForkOptional(schema) : schema
}

function buildSchemaForkOptional(schemaPassed: AnySchema): AnySchema {
    return schemaPassed.fork(
        Object.keys(schemaPassed.describe().keys),
        (field) => field.optional()
    )
}

export { buildSchema, buildSchemaForkOptional, fieldToSchema }
