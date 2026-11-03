import { describe, expect, test } from "bun:test";
import {
    clipDetections,
    decodeDetections,
    detectorResize,
    groupDetectorOutputs,
    isRecoError,
    nms,
    toDetectorTensor,
} from "../index";
import type { DetectorTensor, FaceDetection, RecoImage } from "../index";

const DET_SIZE = 32;

function keypointValues(): number[] {
    return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
}

function outputsAt(
    index: number,
    distances: readonly [number, number, number, number],
    score = 0.9,
    stride = 8,
    detSize = DET_SIZE,
): DetectorTensor[] {
    const featureMap = detSize / stride;
    const anchors = featureMap * featureMap * 2;
    const scores = new Float32Array(anchors);
    const bbox = new Float32Array(anchors * 4);
    const kps = new Float32Array(anchors * 10);

    scores[index] = score;
    bbox.set(distances, index * 4);
    kps.set(keypointValues(), index * 10);

    return [
        { data: kps, dims: [1, anchors, 10] },
        { data: scores, dims: [1, anchors, 1] },
        { data: bbox, dims: [1, anchors, 4] },
    ];
}

describe("detectorResize", () => {
    test("fits inside the square and keeps the aspect ratio", () => {
        expect(detectorResize(1000, 500, 640)).toEqual({ scale: 0.64, width: 640, height: 320 });
        expect(detectorResize(500, 1000, 640)).toEqual({ scale: 0.64, width: 320, height: 640 });
        expect(detectorResize(320, 240, 640)).toEqual({ scale: 2, width: 640, height: 480 });
    });
});

describe("toDetectorTensor", () => {
    test("packs RGB as CHW and pads with black at the bottom-right", () => {
        const image: RecoImage = {
            data: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]),
            width: 2,
            height: 2,
        };
        const tensor = toDetectorTensor(image, 4);
        const plane = 16;
        const pad = -127.5 / 128;

        expect(tensor.length).toBe(plane * 3);
        expect(tensor[0]).toBeCloseTo((255 - 127.5) / 128, 6);
        expect(tensor[1]).toBeCloseTo((0 - 127.5) / 128, 6);
        expect(tensor[plane + 1]).toBeCloseTo((255 - 127.5) / 128, 6);
        expect(tensor[plane * 2 + 4]).toBeCloseTo((255 - 127.5) / 128, 6);
        expect(tensor[3]).toBe(pad);
        expect(tensor[plane * 2 + 5]).toBeCloseTo((255 - 127.5) / 128, 6);
        expect(tensor[plane * 3 - 2]).toBe(pad);
    });
});

describe("groupDetectorOutputs", () => {
    test("groups by stride whatever the output order", () => {
        const outputs = outputsAt(5, [1, 2, 3, 4]);
        const groups = groupDetectorOutputs(outputs, DET_SIZE);

        expect(groups).toHaveLength(1);
        expect(groups[0]!.stride).toBe(8);
        expect(groups[0]!.anchors).toBe(32);
    });

    test("refuses an incomplete detector", () => {
        const outputs = outputsAt(5, [1, 2, 3, 4]).filter((output) => output.dims[2] !== 4);
        try {
            groupDetectorOutputs(outputs, DET_SIZE);
            throw new Error("expected a failure");
        } catch (error) {
            expect(isRecoError(error)).toBe(true);
            if (isRecoError(error)) expect(error.code).toBe("RECO_MODEL_INVALID");
        }
    });
});

describe("decodeDetections", () => {
    test("decodes a box and five keypoints at the anchor cell", () => {
        const faces = decodeDetections(
            outputsAt(5, [1, 2, 3, 4]),
            { detSize: DET_SIZE, threshold: 0.5, scale: 1 },
        );

        expect(faces).toHaveLength(1);
        const face = faces[0]!;
        expect(face.score).toBeCloseTo(0.9, 6);
        // index 5 -> cell 2 -> cx = 16, cy = 0, stride = 8
        expect(face.box).toEqual({ x: 8, y: -16, width: 32, height: 48 });
        expect(face.keypoints[0]).toEqual({ x: 24, y: 16 });
        expect(face.keypoints[4]).toEqual({ x: 88, y: 80 });
    });

    test("divides by the resize scale", () => {
        const faces = decodeDetections(
            outputsAt(5, [1, 2, 3, 4]),
            { detSize: DET_SIZE, threshold: 0.5, scale: 0.5 },
        );

        expect(faces[0]!.box).toEqual({ x: 16, y: -32, width: 64, height: 96 });
        expect(faces[0]!.keypoints[0]).toEqual({ x: 48, y: 32 });
    });

    test("drops detections under the threshold", () => {
        const faces = decodeDetections(
            outputsAt(5, [1, 2, 3, 4], 0.3),
            { detSize: DET_SIZE, threshold: 0.5, scale: 1 },
        );
        expect(faces).toHaveLength(0);
    });

    test("sorts best score first", () => {
        const best = outputsAt(5, [1, 1, 1, 1], 0.95);
        const second = outputsAt(0, [1, 1, 1, 1], 0.8, 16);
        const faces = decodeDetections([...second, ...best], {
            detSize: DET_SIZE,
            threshold: 0.5,
            scale: 1,
        });

        expect(faces.map((face) => face.score)).toHaveLength(2);
        expect(faces[0]!.score).toBeCloseTo(0.95, 5);
        expect(faces[1]!.score).toBeCloseTo(0.8, 5);
    });
});

function face(x: number, y: number, width: number, height: number, score = 0.9): FaceDetection {
    return {
        score,
        box: { x, y, width, height },
        keypoints: Array.from({ length: 5 }, () => ({ x: 0, y: 0 })) as unknown as FaceDetection["keypoints"],
    };
}

describe("nms", () => {
    test("keeps the best of two overlapping boxes", () => {
        const kept = nms([face(0, 0, 10, 10, 0.8), face(1, 1, 10, 10, 0.9)], 0.4);
        expect(kept).toHaveLength(1);
        expect(kept[0]!.score).toBe(0.9);
    });

    test("keeps two disjoint boxes", () => {
        expect(nms([face(0, 0, 10, 10), face(30, 30, 10, 10)], 0.4)).toHaveLength(2);
    });
});

describe("clipDetections", () => {
    test("clamps to the image and drops what falls outside", () => {
        const kept = clipDetections([face(-5, -5, 20, 20), face(100, 100, 10, 10)], 10, 10);
        expect(kept).toHaveLength(1);
        expect(kept[0]!.box).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    });
});
