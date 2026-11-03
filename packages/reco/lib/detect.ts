import { RecoError } from "./errors";
import type { FaceDetection, RecoImage, RecoPoint } from "../types/reco";

/** Black, in the detector's `(x - 127.5) / 128` input space. */
const PAD = -127.5 / 128;

export interface DetectorTensor {
    readonly data: Float32Array;
    readonly dims: readonly number[];
}

/** The resize factor that fits an image inside the detector's square input. */
export function detectorResize(
    width: number,
    height: number,
    detSize: number,
): { scale: number; width: number; height: number } {
    if (!(width > 0) || !(height > 0) || !(detSize > 0)) {
        throw new RecoError("RECO_IMAGE_UNSUPPORTED", `Invalid detector geometry ${width}x${height} / ${detSize}`);
    }
    const scale = Math.min(detSize / width, detSize / height);
    return {
        scale,
        width: Math.max(1, Math.min(detSize, Math.round(width * scale))),
        height: Math.max(1, Math.min(detSize, Math.round(height * scale))),
    };
}

/**
 * Packs a resized RGB image into the detector input: CHW float32, normalized
 * `(x - 127.5) / 128`, padded on the right and bottom with black — the InsightFace
 * convention (the image sits at the top-left of the square).
 */
export function toDetectorTensor(image: RecoImage, detSize: number): Float32Array {
    if (image.width > detSize || image.height > detSize) {
        throw new RecoError("RECO_IMAGE_UNSUPPORTED", `The detector input is ${detSize}, got ${image.width}x${image.height}`);
    }
    if (image.data.length !== image.width * image.height * 3) {
        throw new RecoError("RECO_IMAGE_UNSUPPORTED", "The detector input is not 3-channel RGB");
    }

    const plane = detSize * detSize;
    const out = new Float32Array(plane * 3).fill(PAD);
    for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
            const source = (y * image.width + x) * 3;
            const target = y * detSize + x;
            out[target] = (image.data[source]! - 127.5) / 128;
            out[plane + target] = (image.data[source + 1]! - 127.5) / 128;
            out[plane * 2 + target] = (image.data[source + 2]! - 127.5) / 128;
        }
    }
    return out;
}

export interface DetectorOutputGroup {
    readonly stride: number;
    readonly anchors: number;
    readonly scores: Float32Array;
    readonly bbox: Float32Array;
    readonly kps: Float32Array;
}

/**
 * Groups the nine RetinaFace outputs by stride, using their shape rather than their
 * order: `[1, anchors, 1]` is a score map, `[1, anchors, 4]` a box regression,
 * `[1, anchors, 10]` five keypoints. `anchors = 2 * (detSize / stride)^2`.
 */
export function groupDetectorOutputs(
    outputs: readonly DetectorTensor[],
    detSize: number,
): DetectorOutputGroup[] {
    const byStride = new Map<
        number,
        { anchors: number; scores?: Float32Array; bbox?: Float32Array; kps?: Float32Array }
    >();

    for (const output of outputs) {
        const dims = output.dims;
        const channels = dims.length >= 2 ? dims[dims.length - 1]! : 1;
        const anchors = dims.length >= 2 ? dims[dims.length - 2]! : (dims[0] ?? output.data.length);
        if (anchors <= 0 || anchors % 2 !== 0 || output.data.length < anchors * channels) continue;
        if (channels !== 1 && channels !== 4 && channels !== 10) continue;

        const cells = anchors / 2;
        const featureMap = Math.sqrt(cells);
        if (!Number.isInteger(featureMap)) continue;
        const stride = detSize / featureMap;
        if (!Number.isInteger(stride) || stride <= 0) continue;

        const entry = byStride.get(stride) ?? { anchors };
        entry.anchors = anchors;
        if (channels === 1 && !entry.scores) entry.scores = output.data;
        else if (channels === 4 && !entry.bbox) entry.bbox = output.data;
        else if (channels === 10 && !entry.kps) entry.kps = output.data;
        else {
            throw new RecoError(
                "RECO_MODEL_INVALID",
                `Stride ${stride} has more than one output with ${channels} channel(s)`,
            );
        }
        byStride.set(stride, entry);
    }

    const groups: DetectorOutputGroup[] = [];
    for (const [stride, entry] of byStride) {
        if (!entry.scores || !entry.bbox || !entry.kps) {
            throw new RecoError(
                "RECO_MODEL_INVALID",
                `Stride ${stride} is missing a score, box or keypoint output — this is not a RetinaFace detector`,
            );
        }
        groups.push({
            stride,
            anchors: entry.anchors,
            scores: entry.scores,
            bbox: entry.bbox,
            kps: entry.kps,
        });
    }
    // Odd strides first, so a later box of equal score never hides a tighter one.
    return groups.sort((left, right) => left.stride - right.stride);
}

export interface DecodeDetectionsOptions {
    readonly detSize: number;
    /** Detector confidence threshold, 0..1. */
    readonly threshold: number;
    /** Resize factor applied before inference (`detectorResize().scale`). */
    readonly scale: number;
}

/** Turns the raw detector outputs into faces, in source-image pixels. */
export function decodeDetections(
    outputs: readonly DetectorTensor[],
    options: DecodeDetectionsOptions,
): FaceDetection[] {
    if (!(options.scale > 0)) {
        throw new RecoError("RECO_IMAGE_UNSUPPORTED", `Invalid detector scale ${options.scale}`);
    }

    const found: FaceDetection[] = [];
    for (const group of groupDetectorOutputs(outputs, options.detSize)) {
        const featureMap = options.detSize / group.stride;
        const { scores, bbox, kps, anchors } = group;

        for (let i = 0; i < anchors; i++) {
            const score = scores[i]!;
            if (!(score >= options.threshold)) continue;

            const cell = i >> 1;
            const cx = (cell % featureMap) * group.stride;
            const cy = Math.floor(cell / featureMap) * group.stride;

            const x1 = (cx - bbox[i * 4]! * group.stride) / options.scale;
            const y1 = (cy - bbox[i * 4 + 1]! * group.stride) / options.scale;
            const x2 = (cx + bbox[i * 4 + 2]! * group.stride) / options.scale;
            const y2 = (cy + bbox[i * 4 + 3]! * group.stride) / options.scale;
            const width = x2 - x1;
            const height = y2 - y1;
            if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) continue;

            const keypoints: RecoPoint[] = [];
            for (let j = 0; j < 5; j++) {
                const px = (cx + kps[i * 10 + j * 2]! * group.stride) / options.scale;
                const py = (cy + kps[i * 10 + j * 2 + 1]! * group.stride) / options.scale;
                if (!Number.isFinite(px) || !Number.isFinite(py)) break;
                keypoints.push({ x: px, y: py });
            }
            if (keypoints.length !== 5) continue;

            found.push({
                score,
                box: { x: x1, y: y1, width, height },
                keypoints: keypoints as unknown as FaceDetection["keypoints"],
            });
        }
    }

    return found.sort((left, right) => right.score - left.score);
}

/** Non-maximum suppression on the detection boxes, best score first. */
export function nms(faces: readonly FaceDetection[], threshold: number): FaceDetection[] {
    const sorted = [...faces].sort((left, right) => right.score - left.score);
    const kept: FaceDetection[] = [];

    for (const face of sorted) {
        let suppressed = false;
        for (const keptFace of kept) {
            if (intersectionOverUnion(face.box, keptFace.box) > threshold) {
                suppressed = true;
                break;
            }
        }
        if (!suppressed) kept.push(face);
    }
    return kept;
}

/** Clamps boxes to the image; a box entirely outside it is dropped. */
export function clipDetections(
    faces: readonly FaceDetection[],
    width: number,
    height: number,
): FaceDetection[] {
    const out: FaceDetection[] = [];
    for (const face of faces) {
        const x1 = clamp(face.box.x, 0, width);
        const y1 = clamp(face.box.y, 0, height);
        const x2 = clamp(face.box.x + face.box.width, 0, width);
        const y2 = clamp(face.box.y + face.box.height, 0, height);
        if (x2 - x1 < 1 || y2 - y1 < 1) continue;
        out.push({ score: face.score, box: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }, keypoints: face.keypoints });
    }
    return out;
}

function intersectionOverUnion(
    left: { x: number; y: number; width: number; height: number },
    right: { x: number; y: number; width: number; height: number },
): number {
    const x1 = Math.max(left.x, right.x);
    const y1 = Math.max(left.y, right.y);
    const x2 = Math.min(left.x + left.width, right.x + right.width);
    const y2 = Math.min(left.y + left.height, right.y + right.height);
    const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    if (intersection === 0) return 0;
    const union = left.width * left.height + right.width * right.height - intersection;
    return union > 0 ? intersection / union : 0;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
