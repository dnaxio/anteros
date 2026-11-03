import { RecoError } from "./errors";
import type { RecoImage, RecoPoint } from "../types/reco";

/** The five ArcFace reference landmarks, for a 112x112 crop. */
export const ARC_DST: readonly [RecoPoint, RecoPoint, RecoPoint, RecoPoint, RecoPoint] = [
    { x: 38.2946, y: 51.6963 },
    { x: 73.5318, y: 51.5014 },
    { x: 56.0252, y: 71.7366 },
    { x: 41.5493, y: 92.3655 },
    { x: 70.7299, y: 92.2041 },
];

/**
 * The least-squares similarity transform mapping `src` onto `dst`:
 * `x' = a*x - b*y + tx`, `y' = b*x + a*y + ty`.
 */
export interface SimilarityTransform {
    readonly a: number;
    readonly b: number;
    readonly tx: number;
    readonly ty: number;
}

export function similarityTransform(
    src: readonly RecoPoint[],
    dst: readonly RecoPoint[],
): SimilarityTransform {
    const n = src.length;
    if (n === 0 || n !== dst.length) {
        throw new RecoError("RECO_ALIGNMENT_INVALID", `Needs as many source points as destination points (${n}/${dst.length})`);
    }

    let msx = 0;
    let msy = 0;
    let mdx = 0;
    let mdy = 0;
    for (let i = 0; i < n; i++) {
        const s = src[i]!;
        const d = dst[i]!;
        assertPoint(s, "source");
        assertPoint(d, "destination");
        msx += s.x;
        msy += s.y;
        mdx += d.x;
        mdy += d.y;
    }
    msx /= n;
    msy /= n;
    mdx /= n;
    mdy /= n;

    let num1 = 0;
    let num2 = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
        const s = src[i]!;
        const d = dst[i]!;
        const sx = s.x - msx;
        const sy = s.y - msy;
        const dx = d.x - mdx;
        const dy = d.y - mdy;
        num1 += sx * dx + sy * dy;
        num2 += sx * dy - sy * dx;
        den += sx * sx + sy * sy;
    }

    if (!(den > 1e-9)) {
        throw new RecoError("RECO_ALIGNMENT_INVALID", "The source landmarks are degenerate (no spread)");
    }

    const a = num1 / den;
    const b = num2 / den;
    return { a, b, tx: mdx - (a * msx - b * msy), ty: mdy - (b * msx + a * msy) };
}

/**
 * Warps the face onto the ArcFace reference frame and returns an 8-bit RGB crop of
 * `size` x `size`. Bilinear sampling; samples outside the image read as black.
 */
export function alignFace(
    image: RecoImage,
    keypoints: readonly RecoPoint[],
    size = 112,
): RecoImage {
    if (!Number.isInteger(size) || size <= 0) {
        throw new RecoError("RECO_ALIGNMENT_INVALID", `Invalid face size ${size}`);
    }
    if (keypoints.length !== ARC_DST.length) {
        throw new RecoError("RECO_ALIGNMENT_INVALID", `Expected ${ARC_DST.length} landmarks, got ${keypoints.length}`);
    }

    const ratio = size / 112;
    const dst = ARC_DST.map((point) => ({ x: point.x * ratio, y: point.y * ratio }));
    const { a, b, tx, ty } = similarityTransform(keypoints, dst);
    const det = a * a + b * b;
    if (!(det > 1e-12)) {
        throw new RecoError("RECO_ALIGNMENT_INVALID", "The landmark transform is degenerate");
    }

    const { data, width, height } = image;
    const out = new Uint8Array(size * size * 3);

    for (let v = 0; v < size; v++) {
        for (let u = 0; u < size; u++) {
            const dx = u - tx;
            const dy = v - ty;
            const sx = (a * dx + b * dy) / det;
            const sy = (-b * dx + a * dy) / det;

            const x0 = Math.floor(sx);
            const y0 = Math.floor(sy);
            const fx = sx - x0;
            const fy = sy - y0;
            const target = (v * size + u) * 3;

            for (let c = 0; c < 3; c++) {
                const value =
                    sample(data, width, height, x0, y0, c) * (1 - fx) * (1 - fy) +
                    sample(data, width, height, x0 + 1, y0, c) * fx * (1 - fy) +
                    sample(data, width, height, x0, y0 + 1, c) * (1 - fx) * fy +
                    sample(data, width, height, x0 + 1, y0 + 1, c) * fx * fy;
                out[target + c] = Math.round(value);
            }
        }
    }

    return { data: out, width: size, height: size };
}

/** Builds the recognizer input: CHW float32, `(value - 127.5) / 127.5`. */
export function toRecognitionTensor(aligned: RecoImage): Float32Array {
    const { data, width, height } = aligned;
    if (width !== height) {
        throw new RecoError("RECO_ALIGNMENT_INVALID", `The recognizer needs a square crop, got ${width}x${height}`);
    }
    if (data.length !== width * height * 3) {
        throw new RecoError("RECO_IMAGE_UNSUPPORTED", "The aligned crop is not 3-channel RGB");
    }

    const plane = width * height;
    const tensor = new Float32Array(plane * 3);
    for (let i = 0; i < plane; i++) {
        const source = i * 3;
        tensor[i] = ((data[source]! - 127.5) / 127.5);
        tensor[plane + i] = ((data[source + 1]! - 127.5) / 127.5);
        tensor[plane * 2 + i] = ((data[source + 2]! - 127.5) / 127.5);
    }
    return tensor;
}

function sample(data: Uint8Array, width: number, height: number, x: number, y: number, channel: number): number {
    if (x < 0 || y < 0 || x >= width || y >= height) return 0;
    return data[(y * width + x) * 3 + channel]!;
}

function assertPoint(point: RecoPoint, label: string): void {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        throw new RecoError("RECO_ALIGNMENT_INVALID", `The ${label} landmarks contain a non-finite coordinate`);
    }
}
