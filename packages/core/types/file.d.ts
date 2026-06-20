import type { AppError, fn } from "../lib/error";
import type { Field } from "./field";
import type { HooksCollection } from "./hook";
import type Joi from "joi";
import type { useRest } from "../database/rest";
import type { jwt } from "../utils/func";

type FileAccessHandler = (ctx: {
    rest: InstanceType<typeof useRest>;
    error: typeof fn.error;
    jwt: typeof jwt;
    token: { value: string | null; decoded: Record<string, unknown> | null; provided: boolean; expired: boolean };
}) => boolean | Promise<boolean>;

type FileApiAccess = {
    /** Default access rule applied when no per-operation rule is set */
    '*'?: boolean | FileAccessHandler;
    /** Access control for POST /upload/:tenant_id/:slug */
    upload?: boolean | FileAccessHandler;
    /** Access control for GET /files/:tenant_id/:slug/:file */
    read?: boolean | FileAccessHandler;
    /** Access control for DELETE /files/:tenant_id/:slug/:file */
    delete?: boolean | FileAccessHandler;
};

/**
 * File collection type.
 *
 * Defined in `files/*.file.ts` — a dedicated collection
 * for handling file uploads, storage, and serving.
 *
 * Each file collection generates:
 *   POST   /upload/:tenant_id/:slug       — upload a file
 *   GET    /files/:tenant_id/:slug/:file  — serve/download a file
 */
export type FileCollection = {
    /** Unique identifier used in routes: `/upload/:tenant_id/:slug` */
    slug: string;
    hooks?: {
        beforeOperation?: HooksCollection['beforeOperation'];
        afterOperation?: HooksCollection['afterOperation'];
    };
    /** Metadata fields stored alongside the file document */
    fields?: Field[];
    /** Upload validation rules */
    upload?: {
        /** Allowed MIME types for upload.
         * @example ['image/jpeg', 'image/png', 'application/pdf'] */
        allowedMimeTypes?: string[];
        /** Maximum file size in bytes. Default: 10MB */
        maxSize?: number;
        /**
         * Image transformations (resize, format, etc.).
         * Applied on-the-fly when serving via GET /files/:tenant_id/:slug/:file
         */
        transformations?: {
            /** Resize to max width in pixels */
            width?: number;
            /** Resize to max height in pixels */
            height?: number;
            /** Output format */
            format?: 'webp' | 'jpeg' | 'png' | 'avif';
            /** Quality 1-100 (default: 80) */
            quality?: number;
        };
    };
    /**
     * Storage configuration.
     * @default 'disk'
     */
    storage?: {
        /** Storage backend */
        driver: 'disk' | 's3';
        /** Relative path inside the tenant storage directory.
         * @example 'uploads/photos' */
        path?: string;
        /** S3 bucket name (required if driver is 's3') */
        bucket?: string;
        /** S3 region (required if driver is 's3') */
            region?: string;
        };
        /**
         * Replicate uploaded files to remote destinations.
         * Executed after the primary storage save.
         */
        replicate?: {
            /** Destination driver */
            driver: 's3' | 'ssh' | 'sftp';
            /** Remote host (required for ssh/sftp) */
            host?: string;
            /** SSH/SFTP port (default: 22) */
            port?: number;
            /** Remote username (required for ssh/sftp) */
            username?: string;
            /** Remote path or directory */
            path?: string;
            /** S3 bucket (required if driver is 's3') */
            bucket?: string;
            /** S3 region */
            region?: string;
            /** Custom S3 endpoint */
            endpoint?: string;
            /** Private key path for SSH auth */
            privateKey?: string;
        }[];
        /** Enregistrer les métadonnées du fichier en base. Défaut: true */
        trackMetaData?: boolean;
    api?: {
        access?: FileApiAccess;
        privateFields?: (string | RegExp)[];
        readOnlyFields?: (string | RegExp)[];
    };
    /**
     * The tenant id of the file collection
     * @type {string}
     */
    _tenant_?: string;
    _isTimeSerie_?: boolean;
    _isFileCollection_?: boolean;
    _schema_?: Joi.Schema;
    _schemaPartial_?: Joi.Schema;
}
