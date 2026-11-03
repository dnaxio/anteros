import type { InferenceSession } from "onnxruntime-node";

/** An 8-bit RGB image in memory, three channels interleaved (HWC). */
export interface RecoImage {
    readonly data: Uint8Array;
    readonly width: number;
    readonly height: number;
}

/**
 * Anything the engine can read: a path, encoded bytes (Buffer included), a Blob
 * (`Bun.file()` included), a base64 string or data URL, an explicit `{ base64 }`, or an
 * image already decoded by `loadImage()`.
 *
 * A string is a **filesystem path** — never pass an untrusted string here (use bytes or
 * base64 instead), it would be an arbitrary-file-read primitive.
 */
export type ImageInput = string | Uint8Array | Blob | Base64Image | RecoImage;

export interface LoadImageOptions {
    /**
     * Reject an image whose `width * height` exceeds this, before allocating pixels.
     * Defaults to Bun's own limit (~268 MP). Lower it for untrusted input: a 32 KiB PNG
     * can decode to hundreds of megabytes.
     */
    readonly maxPixels?: number;
}

/** An explicit base64 payload — no ambiguity with a file path. */
export interface Base64Image {
    /** Base64 text, with or without a `data:image/...;base64,` prefix. */
    readonly base64: string;
    readonly mimeType?: string;
}

export interface RecoPoint {
    readonly x: number;
    readonly y: number;
}

/** An axis-aligned box, in source-image pixels, clamped to the image. */
export interface FaceBox {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface FaceDetection {
    /** Detector confidence, 0..1. */
    readonly score: number;
    readonly box: FaceBox;
    /** The five ArcFace landmarks: left eye, right eye, nose, left mouth, right mouth. */
    readonly keypoints: readonly [RecoPoint, RecoPoint, RecoPoint, RecoPoint, RecoPoint];
}

export interface FaceResult extends FaceDetection {
    /** A 512-dimension unit vector; cosine similarity is a dot product. */
    readonly embedding: Float32Array;
}

export type ExecutionProvider = NonNullable<InferenceSession.SessionOptions["executionProviders"]>[number];

export interface RecoEngineOptions {
    /** Directory holding the ONNX weights. Default `RECO_MODEL_DIR` or `./models/buffalo_l`. */
    readonly modelDir?: string;
    /** Detector file name, relative to `modelDir`. Default `det_10g.onnx`. */
    readonly detModel?: string;
    /** Recognizer file name, relative to `modelDir`. Default `w600k_r50.onnx`. */
    readonly recModel?: string;
    /** Default `['cpu']`. A supplied `sessionOptions.executionProviders` wins. */
    readonly providers?: readonly ExecutionProvider[];
    /** Detector input edge, square. Default 640. */
    readonly detSize?: number;
    /** Detector score threshold. Default 0.5. */
    readonly detThreshold?: number;
    /** IoU above which a box is suppressed. Default 0.4. */
    readonly nmsThreshold?: number;
    /** Keep at most this many faces, best first. Default 0 (all). */
    readonly maxFaces?: number;
    /** Aligned face edge fed to the recognizer. Default 112. */
    readonly faceSize?: number;
    /** Reject images above this many pixels before decoding. Defaults to Bun's limit (~268 MP). */
    readonly maxPixels?: number;
    /**
     * Download the buffalo_l pack when `det_10g.onnx` / `w600k_r50.onnx` are missing.
     * Default `true` — one download per modelDir, then never again. Only applies to the
     * default file names.
     */
    readonly autoDownload?: boolean;
    /** Archive URL used by `autoDownload`. Defaults to the buffalo_l release. */
    readonly modelUrl?: string;
    /** Abort the automatic download after this many milliseconds. Default 10 minutes. */
    readonly downloadTimeoutMs?: number;
    /** Merged into the ONNX Runtime session options of both sessions. */
    readonly sessionOptions?: InferenceSession.SessionOptions;
}

export interface DetectOptions {
    readonly detSize?: number;
    readonly threshold?: number;
    readonly nmsThreshold?: number;
    readonly maxFaces?: number;
}

export interface RecognizeOptions extends DetectOptions {
    readonly faceSize?: number;
}

/** `RecoEngineOptions` with every default applied — what `engine.options` returns. */
export interface ResolvedRecoEngineOptions {
    readonly modelDir: string;
    readonly detModel: string;
    readonly recModel: string;
    readonly providers: readonly ExecutionProvider[];
    readonly detSize: number;
    readonly detThreshold: number;
    readonly nmsThreshold: number;
    readonly maxFaces: number;
    readonly faceSize: number;
    readonly maxPixels?: number;
    readonly autoDownload: boolean;
    readonly modelUrl: string;
    readonly downloadTimeoutMs: number;
    readonly sessionOptions?: InferenceSession.SessionOptions;
}

export interface MatchResult {
    readonly index: number;
    readonly score: number;
}

export interface FindMatchOptions {
    /** Minimum cosine similarity for a match to be returned. Default -1 (any). */
    readonly threshold?: number;
}
