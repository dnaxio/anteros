import { existsSync } from "node:fs";
import sharp from "sharp";
import { RecoError } from "./errors";
import type { Base64Image, ImageInput, LoadImageOptions, PathImage, RecoImage } from "../types/reco";

const BASE64_ONLY = /^[A-Za-z0-9+/]+={0,2}$/;
const NOT_IN_BASE64 = /[.\\]/;

/** sharp's own default, restated so `maxPixels` has one documented fallback. */
const DEFAULT_MAX_PIXELS = 268402689;

export function isRecoImage(input: ImageInput): input is RecoImage {
    if (input instanceof Uint8Array || typeof input === "string") return false;
    const candidate = input as RecoImage;
    return (
        typeof candidate === "object" &&
        candidate !== null &&
        typeof candidate.width === "number" &&
        typeof candidate.height === "number" &&
        candidate.data instanceof Uint8Array
    );
}

export function isBase64Image(input: ImageInput): input is Base64Image {
    if (typeof input !== "object" || input === null || input instanceof Uint8Array) return false;
    return typeof (input as Base64Image).base64 === "string";
}

/** An explicit `{ path }` — the only signal that a local file may be read. */
export function isPathImage(input: ImageInput): input is PathImage {
    if (typeof input !== "object" || input === null || input instanceof Uint8Array) return false;
    return typeof (input as PathImage).path === "string";
}

function assertRecoImage(image: RecoImage): void {
    if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0) {
        throw new RecoError("RECO_IMAGE_UNSUPPORTED", `Invalid image size ${image.width}x${image.height}`);
    }
    if (image.data.length !== image.width * image.height * 3) {
        throw new RecoError(
            "RECO_IMAGE_UNSUPPORTED",
            `Expected ${image.width * image.height * 3} bytes of RGB data, got ${image.data.length}`,
        );
    }
}

/**
 * Decodes a path, bytes, a `Blob`, a base64 string (bare or `data:` URL) or an explicit
 * `{ base64 }` into 8-bit RGB through sharp. EXIF orientation is applied, colourspaces are
 * converted to sRGB, alpha is dropped and 16-bit samples are downscaled — so the RGB
 * indexing downstream cannot silently drift.
 *
 * A string is a filesystem path: never pass an untrusted string here.
 */
export async function loadImage(input: ImageInput, options: LoadImageOptions = {}): Promise<RecoImage> {
    if (isRecoImage(input)) {
        assertRecoImage(input);
        return input;
    }
    if (isPathImage(input)) {
        return decode(input.path, options);
    }
    if (isBase64Image(input)) {
        return decode(base64Bytes(input.base64), options);
    }
    if (typeof input === "string") {
        return decode(resolveString(input, options.allowPath ?? false), options);
    }
    if (input instanceof Uint8Array) {
        return decode(input, options);
    }
    if (input instanceof Blob) {
        return decode(Buffer.from(await input.arrayBuffer()), options);
    }
    throw new RecoError("RECO_IMAGE_INVALID", "An image is a path, bytes, a Blob, base64, or a decoded image");
}

async function decode(source: string | Uint8Array | Buffer, options: LoadImageOptions): Promise<RecoImage> {
    try {
        const { data, info } = await sharp(source, {
            failOn: "error",
            limitInputPixels: options.maxPixels ?? DEFAULT_MAX_PIXELS,
        })
            .rotate()
            .toColourspace("srgb")
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        if (info.channels !== 3) {
            throw new RecoError(
                "RECO_IMAGE_UNSUPPORTED",
                `Expected 3 channels after conversion, got ${info.channels} (${info.format ?? "unknown"})`,
            );
        }

        return {
            data: toUint8(data, info.width * info.height * 3),
            width: info.width,
            height: info.height,
        };
    } catch (error) {
        if (error instanceof RecoError) throw error;
        throw new RecoError("RECO_IMAGE_INVALID", `Cannot decode image: ${(error as Error).message}`, { cause: error });
    }
}

/** Normalizes 8- or 16-bit samples to 8 bits; the byte count is the only depth signal. */
function toUint8(data: Buffer, pixels: number): Uint8Array {
    if (data.length === pixels) return data;

    if (data.length === pixels * 2) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const out = new Uint8Array(pixels);
        for (let i = 0; i < pixels; i++) out[i] = view.getUint16(i * 2, true) >> 8;
        return out;
    }

    throw new RecoError(
        "RECO_IMAGE_UNSUPPORTED",
        `Unsupported pixel depth (${data.length} bytes for ${pixels} 8-bit pixels)`,
    );
}

/**
 * A bare string is a `data:` URL or base64 — **never a path** unless `allowPath` is on.
 * That is the difference between "convenient" and "arbitrary file read": a string coming
 * from a request can no longer name a file on the server.
 */
function resolveString(input: string, allowPath: boolean): string | Uint8Array {
    const value = input.trim();
    if (value.startsWith("data:")) return base64Bytes(value);

    if (allowPath) {
        if (existsSync(value)) return value;
        if (looksLikeBase64(value)) return base64Bytes(value);
        return value; // let sharp report the unreadable path
    }

    if (looksLikeBase64(value)) return base64Bytes(value);
    throw new RecoError(
        "RECO_IMAGE_INVALID",
        "A bare string is base64 or a data URL — pass { path } (or create the engine with allowPath: true) for a local file",
    );
}

function looksLikeBase64(value: string): boolean {
    const compact = value.replace(/\s+/g, "");
    if (compact.length <= 32 || compact.length % 4 !== 0 || NOT_IN_BASE64.test(compact)) return false;
    return BASE64_ONLY.test(compact);
}

function base64Bytes(value: string): Uint8Array {
    let payload = value.trim();

    if (payload.startsWith("data:")) {
        const comma = payload.indexOf(",");
        if (comma < 0) throw new RecoError("RECO_IMAGE_INVALID", "A data URL has no payload");
        const header = payload.slice(5, comma);
        if (!header.endsWith(";base64")) {
            throw new RecoError("RECO_IMAGE_UNSUPPORTED", "Only base64 data URLs are supported");
        }
        payload = payload.slice(comma + 1);
    }

    payload = payload.replace(/\s+/g, "");
    if (payload.length === 0 || payload.length % 4 !== 0 || !BASE64_ONLY.test(payload)) {
        throw new RecoError("RECO_IMAGE_INVALID", "Invalid base64 payload");
    }
    return Buffer.from(payload, "base64");
}

/** Resizes a decoded image; used to fit the detector input. */
export async function resizeImage(image: RecoImage, width: number, height: number): Promise<RecoImage> {
    assertRecoImage(image);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new RecoError("RECO_IMAGE_UNSUPPORTED", `Invalid resize target ${width}x${height}`);
    }
    if (width === image.width && height === image.height) return image;

    const { data, info } = await sharp(image.data, {
        raw: { width: image.width, height: image.height, channels: 3 },
    })
        .resize(width, height, { fit: "fill", kernel: "linear" })
        .raw()
        .toBuffer({ resolveWithObject: true });

    return { data, width: info.width, height: info.height };
}
