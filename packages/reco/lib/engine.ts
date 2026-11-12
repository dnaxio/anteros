import { existsSync } from "node:fs";
import { join } from "node:path";
import * as ort from "onnxruntime-node";
import { RecoError } from "./errors";
import { loadImage, resizeImage } from "./image";
import {
    DEFAULT_DET_MODEL,
    DEFAULT_DOWNLOAD_TIMEOUT_MS,
    DEFAULT_MODEL_URL,
    DEFAULT_REC_MODEL,
    ensureModels,
    modelsPresent,
} from "./models";
import { clipDetections, decodeDetections, detectorResize, nms, toDetectorTensor } from "./detect";
import { alignFace, toRecognitionTensor } from "./geometry";
import { cosineSimilarity, normalizeEmbedding } from "./similarity";
import type {
    DetectOptions,
    FaceDetection,
    FaceResult,
    ImageInput,
    RecoEngineOptions,
    RecognizeOptions,
    RecoImage,
    ResolvedRecoEngineOptions,
} from "../types/reco";

export const DEFAULT_MODEL_DIR = "./models/buffalo_l";
export const DEFAULT_DET_SIZE = 640;
export const DEFAULT_DET_THRESHOLD = 0.5;
export const DEFAULT_NMS_THRESHOLD = 0.4;
export const DEFAULT_FACE_SIZE = 112;

type SessionResult = Awaited<ReturnType<ort.InferenceSession["run"]>>;

/**
 * Detection and recognition over the InsightFace `buffalo_l` pack
 * (`det_10g.onnx` + `w600k_r50.onnx`), running locally through ONNX Runtime.
 *
 * One engine owns both sessions; create it once and reuse it.
 */
export class RecoEngine {
    private readonly det: ort.InferenceSession;
    private readonly rec: ort.InferenceSession;
    private readonly resolved: ResolvedRecoEngineOptions;
    private closed = false;

    private constructor(
        det: ort.InferenceSession,
        rec: ort.InferenceSession,
        options: ResolvedRecoEngineOptions,
    ) {
        this.det = det;
        this.rec = rec;
        this.resolved = options;
    }

    static async create(options: RecoEngineOptions = {}): Promise<RecoEngine> {
        const modelDir = options.modelDir ?? process.env.RECO_MODEL_DIR ?? DEFAULT_MODEL_DIR;
        const detModel = options.detModel ?? DEFAULT_DET_MODEL;
        const recModel = options.recModel ?? DEFAULT_REC_MODEL;

        const detPath = join(modelDir, detModel);
        const recPath = join(modelDir, recModel);

        const resolved: ResolvedRecoEngineOptions = {
            modelDir,
            detModel,
            recModel,
            providers: options.providers ?? ["cpu"],
            detSize: positiveInteger(options.detSize, "detSize", DEFAULT_DET_SIZE),
            detThreshold: unitInterval(options.detThreshold, "detThreshold", DEFAULT_DET_THRESHOLD),
            nmsThreshold: unitInterval(options.nmsThreshold, "nmsThreshold", DEFAULT_NMS_THRESHOLD),
            maxFaces: nonNegativeInteger(options.maxFaces, "maxFaces", 0),
            faceSize: positiveInteger(options.faceSize, "faceSize", DEFAULT_FACE_SIZE),
            maxPixels: optionalPositiveInteger(options.maxPixels, "maxPixels"),
            allowPath: options.allowPath ?? false,
            autoDownload: options.autoDownload ?? true,
            modelUrl: options.modelUrl ?? DEFAULT_MODEL_URL,
            downloadTimeoutMs: positiveInteger(
                options.downloadTimeoutMs,
                "downloadTimeoutMs",
                DEFAULT_DOWNLOAD_TIMEOUT_MS,
            ),
            sessionOptions: options.sessionOptions,
        };

        const canDownload = detModel === DEFAULT_DET_MODEL && recModel === DEFAULT_REC_MODEL;
        if (resolved.autoDownload && canDownload && !modelsPresent(modelDir, detModel, recModel)) {
            console.warn(`[reco] models missing in ${modelDir}; downloading buffalo_l (~280 MB)`);
            await ensureModels({
                modelDir,
                url: resolved.modelUrl,
                timeoutMs: resolved.downloadTimeoutMs,
                detModel,
                recModel,
            });
        }

        requireModel(detPath, "detector", detModel);
        requireModel(recPath, "recognizer", recModel);

        const sessionOptions: ort.InferenceSession.SessionOptions = {
            executionProviders: resolved.providers,
            ...options.sessionOptions,
        };

        let det: ort.InferenceSession;
        try {
            det = await ort.InferenceSession.create(detPath, sessionOptions);
        } catch (error) {
            throw new RecoError("RECO_MODEL_INVALID", `Cannot load ${detPath}: ${(error as Error).message}`, {
                cause: error,
            });
        }

        let rec: ort.InferenceSession;
        try {
            rec = await ort.InferenceSession.create(recPath, sessionOptions);
        } catch (error) {
            await det.release().catch(() => {});
            throw new RecoError("RECO_MODEL_INVALID", `Cannot load ${recPath}: ${(error as Error).message}`, {
                cause: error,
            });
        }

        return new RecoEngine(det, rec, resolved);
    }

    /** The resolved configuration (defaults applied). */
    get options(): Readonly<ResolvedRecoEngineOptions> {
        return this.resolved;
    }

    /** The raw ONNX Runtime sessions, for callers that need a tensor the API does not expose. */
    get sessions(): { readonly det: ort.InferenceSession; readonly rec: ort.InferenceSession } {
        return { det: this.det, rec: this.rec };
    }

    get disposed(): boolean {
        return this.closed;
    }

    /** Detects every face above the threshold, best score first. */
    async detect(input: ImageInput, options: DetectOptions = {}): Promise<FaceDetection[]> {
        this.assertOpen();
        const image = await this.load(input);
        return this.detectIn(image, options);
    }

    /** Detects the faces of an image and embeds each one (512 dimensions, unit norm). */
    async recognize(input: ImageInput, options: RecognizeOptions = {}): Promise<FaceResult[]> {
        this.assertOpen();
        const image = await this.load(input);
        const faceSize = positiveInteger(options.faceSize, "faceSize", this.resolved.faceSize);
        const faces = await this.detectIn(image, options);

        const results: FaceResult[] = [];
        for (const face of faces) {
            results.push({ ...face, embedding: await this.embedFace(image, face, faceSize) });
        }
        return results;
    }

    /**
     * The 512-dimension descriptor of every detected face, best score first.
     * Same work as `recognize()`, without the boxes and landmarks.
     */
    async getDescriptors(input: ImageInput, options: RecognizeOptions = {}): Promise<Float32Array[]> {
        const faces = await this.recognize(input, options);
        return faces.map((face) => face.embedding);
    }

    /** The descriptor of the best face, or `null` when the image has no face. */
    async getDescriptor(input: ImageInput, options: RecognizeOptions = {}): Promise<Float32Array | null> {
        const [descriptor] = await this.getDescriptors(input, { ...options, maxFaces: 1 });
        return descriptor ?? null;
    }

    /** The embedding of one face — the given detection, or the best one in the image. */
    async embed(input: ImageInput, face?: FaceDetection, options: RecognizeOptions = {}): Promise<Float32Array> {
        this.assertOpen();
        const image = await this.load(input);
        const detection = face ?? (await this.detectIn(image, options))[0];
        if (!detection) throw new RecoError("RECO_NO_FACE", "No face was detected");
        const faceSize = positiveInteger(options.faceSize, "faceSize", this.resolved.faceSize);
        return this.embedFace(image, detection, faceSize);
    }

    /**
     * Embeds an image that is already an aligned square crop (a stored 112x112 face, say),
     * skipping detection. A non-square crop is refused rather than silently stretched.
     */
    async embedAligned(input: ImageInput, options: { faceSize?: number } = {}): Promise<Float32Array> {
        this.assertOpen();
        const image = await this.load(input);
        if (image.width !== image.height) {
            throw new RecoError(
                "RECO_ALIGNMENT_INVALID",
                `An aligned crop must be square, got ${image.width}x${image.height}`,
            );
        }
        const faceSize = positiveInteger(options.faceSize, "faceSize", this.resolved.faceSize);
        const aligned = image.width === faceSize ? image : await resizeImage(image, faceSize, faceSize);
        return this.embedAlignedImage(aligned);
    }

    /** 1:1 comparison: the best face of each image, cosine similarity in `[-1, 1]`. */
    async compare(left: ImageInput, right: ImageInput): Promise<number> {
        const [a, b] = await Promise.all([this.embed(left), this.embed(right)]);
        return cosineSimilarity(a, b);
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await Promise.all([this.det.release(), this.rec.release()]);
    }

    private load(input: ImageInput): Promise<RecoImage> {
        return loadImage(input, { maxPixels: this.resolved.maxPixels, allowPath: this.resolved.allowPath });
    }

    private async detectIn(image: RecoImage, options: DetectOptions): Promise<FaceDetection[]> {
        const detSize = positiveInteger(options.detSize, "detSize", this.resolved.detSize);
        const threshold = unitInterval(options.threshold, "threshold", this.resolved.detThreshold);
        const nmsThreshold = unitInterval(options.nmsThreshold, "nmsThreshold", this.resolved.nmsThreshold);
        const maxFaces = nonNegativeInteger(options.maxFaces, "maxFaces", this.resolved.maxFaces);

        const geometry = detectorResize(image.width, image.height, detSize);
        const resized =
            geometry.width === image.width && geometry.height === image.height
                ? image
                : await resizeImage(image, geometry.width, geometry.height);

        const tensor = toDetectorTensor(resized, detSize);
        const inputName = firstInput(this.det, "detector");
        const result = await this.run(
            this.det,
            { [inputName]: new ort.Tensor("float32", tensor, [1, 3, detSize, detSize]) },
            "detector",
        );

        const outputs = this.det.outputNames.map((name) => {
            const value = result[name];
            if (!value || !(value.data instanceof Float32Array)) {
                throw new RecoError("RECO_MODEL_INVALID", `The detector output '${name}' is not a float32 tensor`);
            }
            return { data: value.data, dims: value.dims };
        });

        const faces = decodeDetections(outputs, { detSize, threshold, scale: geometry.scale });
        const kept = clipDetections(nms(faces, nmsThreshold), image.width, image.height);
        return maxFaces > 0 ? kept.slice(0, maxFaces) : kept;
    }

    private async embedFace(
        image: RecoImage,
        face: FaceDetection,
        faceSize: number,
    ): Promise<Float32Array> {
        return this.embedAlignedImage(alignFace(image, face.keypoints, faceSize));
    }

    private async embedAlignedImage(aligned: RecoImage): Promise<Float32Array> {
        const faceSize = aligned.width;
        const tensor = toRecognitionTensor(aligned);
        const inputName = firstInput(this.rec, "recognizer");
        const result = await this.run(
            this.rec,
            { [inputName]: new ort.Tensor("float32", tensor, [1, 3, faceSize, faceSize]) },
            "recognizer",
        );

        const outputName = this.rec.outputNames[0];
        if (!outputName) throw new RecoError("RECO_MODEL_INVALID", "The recognizer has no output");
        const value = result[outputName];
        if (!value || !(value.data instanceof Float32Array)) {
            throw new RecoError("RECO_MODEL_INVALID", `The recognizer output '${outputName}' is not a float32 tensor`);
        }
        return normalizeEmbedding(value.data);
    }

    private async run(
        session: ort.InferenceSession,
        feeds: Record<string, ort.Tensor>,
        label: string,
    ): Promise<SessionResult> {
        try {
            return await session.run(feeds);
        } catch (error) {
            throw new RecoError("RECO_INFERENCE_FAILED", `The ${label} failed: ${(error as Error).message}`, {
                cause: error,
            });
        }
    }

    private assertOpen(): void {
        if (this.closed) throw new RecoError("RECO_ENGINE_CLOSED", "The engine has been closed");
    }
}

export async function createEngine(options: RecoEngineOptions = {}): Promise<RecoEngine> {
    return RecoEngine.create(options);
}

function firstInput(session: ort.InferenceSession, label: string): string {
    const name = session.inputNames[0];
    if (!name) throw new RecoError("RECO_MODEL_INVALID", `The ${label} has no input`);
    return name;
}

function requireModel(path: string, label: string, file: string): void {
    if (existsSync(path)) return;
    throw new RecoError(
        "RECO_MODEL_NOT_FOUND",
        `Missing ${label} model '${file}' at ${path}. The automatic download only covers ` +
            `${DEFAULT_DET_MODEL} / ${DEFAULT_REC_MODEL}; otherwise fetch the buffalo_l pack (see the README) ` +
            "and pass { modelDir } or set RECO_MODEL_DIR",
    );
}

function optionalPositiveInteger(value: number | undefined, name: string): number | undefined {
    if (value === undefined) return undefined;
    if (!Number.isInteger(value) || value <= 0) {
        throw new RecoError("RECO_MODEL_INVALID", `${name} must be a positive integer, got ${value}`);
    }
    return value;
}

function positiveInteger(value: number | undefined, name: string, fallback: number): number {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value <= 0) {
        throw new RecoError("RECO_MODEL_INVALID", `${name} must be a positive integer, got ${value}`);
    }
    return value;
}

function nonNegativeInteger(value: number | undefined, name: string, fallback: number): number {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < 0) {
        throw new RecoError("RECO_MODEL_INVALID", `${name} must be a non-negative integer, got ${value}`);
    }
    return value;
}

function unitInterval(value: number | undefined, name: string, fallback: number): number {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new RecoError("RECO_MODEL_INVALID", `${name} must be between 0 and 1, got ${value}`);
    }
    return value;
}
