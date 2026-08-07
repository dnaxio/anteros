
import type { Collection as CollectionType } from "../types/collection";
import Joi, { type AnySchema } from "joi";


let s = Joi.object({
    name: Joi.string().required(),
})




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

            if (f.type == 'string') {
                propertiesSchema[fieldName] = Joi.string()
            }

            if (f.type == 'password') {
                propertiesSchema[fieldName] = Joi.string()
            }

            if (f.type == 'number') {
                propertiesSchema[fieldName] = Joi.number()
            }

            if (f.type == 'integer') {
                propertiesSchema[fieldName] = Joi.number().integer()
            }

            if (f.type == 'boolean') {
                propertiesSchema[fieldName] = Joi.boolean()
            }

            if (f.type.match(/(date|datetime-local)/)) {
                propertiesSchema[fieldName] = Joi.date()
            }

            if (f.type == 'array') {
                propertiesSchema[fieldName] = Joi.array()
            }

            if (f.type == 'json') {
                propertiesSchema[fieldName] = Joi.object()
            }

            if (f.type == 'uuid') {
                propertiesSchema[fieldName] = Joi.string().uuid()
            }
            if (f.type == 'email') {
                propertiesSchema[fieldName] = Joi.string().email()
            }

            if (f.type == 'url') {
                propertiesSchema[fieldName] = Joi.string().uri()
            }

            if (f.type == 'slug') {
                let schema = Joi.string().pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
                if (f.slugOptions?.min != null) schema = schema.min(f.slugOptions.min)
                if (f.slugOptions?.max != null) schema = schema.max(f.slugOptions.max)
                propertiesSchema[fieldName] = schema
            }

            if (f.type == 'ipv4') {
                propertiesSchema[fieldName] = Joi.string().ip({ version: 'ipv4' })
            }

            if (f.type == 'ipv6') {
                propertiesSchema[fieldName] = Joi.string().ip({ version: 'ipv6' })
            }

            if (f.type == 'enum' && !f.enumOptions?.multiple) {
                propertiesSchema[fieldName] = Joi.string().valid(...f.enumOptions?.items || [])
            }

            if (f.type == 'enum' && f.enumOptions?.multiple) {
                propertiesSchema[fieldName] = Joi.array().items(Joi.string().valid(...f.enumOptions?.items || []))
            }

            if (f.type == 'random') {
                propertiesSchema[fieldName] = Joi.string()
            }

            if (f.type == 'random' && f?.randomOptions?.toNumber) {
                propertiesSchema[fieldName] = Joi.number()
            }

            if (f?.type.match(/(geojson\.Point|geojson\.LineString|geojson\.Polygon)/)) {
                propertiesSchema[fieldName] = Joi.object({
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
                propertiesSchema[fieldName] = Joi.string().optional().messages({
                    'string.base': `${f.name} must be  a string (ObjectId)`,
                })
            }

            if (f?.type == 'relationship' && f?.relation?.hasMany) {
                propertiesSchema[fieldName] = Joi.array().items(Joi.string().optional()).messages({
                    'string.base': `${f.name} must be  a string (ObjectId)`,
                })
            }

            if (f.validate?.schema) {
                propertiesSchema[fieldName] = f.validate.schema
            }

            if (f?.required) {
                propertiesSchema[fieldName] = propertiesSchema[fieldName]?.required()!
            } else {
                propertiesSchema[fieldName] = propertiesSchema[fieldName]?.optional()!
            }

            if (f?.nullable) {
                propertiesSchema[fieldName] = propertiesSchema[fieldName]?.allow(null)
            }

            if (f?.empty) {
                propertiesSchema[fieldName] = propertiesSchema[fieldName]?.allow('')
            }

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

export { buildSchema, buildSchemaForkOptional }