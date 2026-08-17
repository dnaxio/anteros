import type { Type } from "arktype";
import type { GenerateRandomOptions } from "../utils/func";
import type Joi from "joi";
export type FieldType = "boolean"
    | "ipv4"
    | "ipv6"
    | "url"
    | "date"
    | "datetime-local"
    | "email"
    | "array"
    | "number"
    | "integer"
    | "password"
    | "random"
    | "relationship"
    | "string"
    | "enum"
    | "json"
    | "geojson.Point"
    | "geojson.LineString"
    | "geojson.Polygon"
    | "uuid"
    | "slug"




export type enumOptions = {
    multiple?: boolean;
    items?: Array<string | number | boolean | object>;
}

export type SlugOptions = {
    min?: number;
    max?: number;
}


export type Field = {
    name: string;
    description?: string;
    type: FieldType;
    studio?: {
        label?: string;
        info?: string;
        display?: string;
    };
    validate?: {
        schema: Joi.Schema
    },
    required?: boolean;
    enumOptions?: enumOptions;
    slugOptions?: SlugOptions;
    unique?: boolean | 1 | 0; // Mongo-style: true/1 → unique index, false/0 → non-unique
    /** Encrypt this field's values at rest (uses server.encryption + the configured mode) */
    encryption?: boolean;
    /** Encrypt sub-path(s) inside a json / array-of-json field (dot notation) — e.g. { path: 'zip' } on field 'address' encrypts address.zip */
    encryptionOptions?: {
        path?: string | string[];
    };
    nullable?: boolean;
    empty?: boolean;
    defaultValue?: number | string | boolean | object | array<any>;
    index?: boolean;
    indexType?: "text"
    | "hashed"
    | "2dsphere"
    | "2d"
    indexOptions?: {
        expireAfterSeconds?: number;
        sparse?: boolean | 1 | 0;
        version?: number;
        unique?: boolean | 1 | 0;
    };
    relation?: {
        to: string;
        hasMany?: boolean;
        pipeline?: Array<any>;
    };
    /**
     * Required if type === "random"
     */
    randomOptions?: GenerateRandomOptions;
}
