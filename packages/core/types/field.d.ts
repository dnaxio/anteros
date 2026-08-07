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
    unique?: boolean;
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
        sparse?: boolean;
        version?: number;
        unique?: boolean;
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
