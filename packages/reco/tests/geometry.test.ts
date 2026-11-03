import { describe, expect, test } from "bun:test";
import { ARC_DST, alignFace, isRecoError, similarityTransform, toRecognitionTensor } from "../index";
import type { RecoImage, RecoPoint } from "../index";

function gradient(width: number, height: number): RecoImage {
    const data = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const at = (y * width + x) * 3;
            data[at] = (x * 3 + y * 5) % 251;
            data[at + 1] = (x * 7 + y * 11) % 241;
            data[at + 2] = (x * 13 + y * 17) % 239;
        }
    }
    return { data, width, height };
}

function map(points: readonly [number, number][], a: number, b: number, tx: number, ty: number): RecoPoint[] {
    return points.map(([x, y]) => ({ x: a * x - b * y + tx, y: b * x + a * y + ty }));
}

describe("similarityTransform", () => {
    test("recovers a scale and a translation", () => {
        const src: [number, number][] = [[0, 0], [10, 0], [0, 10], [10, 10]];
        const dst = map(src, 2, 0, 10, -3);
        const transform = similarityTransform(
            src.map(([x, y]) => ({ x, y })),
            dst,
        );

        expect(transform.a).toBeCloseTo(2, 10);
        expect(transform.b).toBeCloseTo(0, 10);
        expect(transform.tx).toBeCloseTo(10, 10);
        expect(transform.ty).toBeCloseTo(-3, 10);
    });

    test("recovers a rotation", () => {
        const src: [number, number][] = [[0, 0], [10, 0], [0, 10], [10, 10]];
        const dst = map(src, 0, 1, 5, 4);
        const transform = similarityTransform(
            src.map(([x, y]) => ({ x, y })),
            dst,
        );

        expect(transform.a).toBeCloseTo(0, 10);
        expect(transform.b).toBeCloseTo(1, 10);
        expect(transform.tx).toBeCloseTo(5, 10);
        expect(transform.ty).toBeCloseTo(4, 10);
    });

    test("refuses degenerate landmarks", () => {
        const point = { x: 3, y: 4 };
        try {
            similarityTransform([point, point, point, point, point], ARC_DST);
            throw new Error("expected a failure");
        } catch (error) {
            expect(isRecoError(error)).toBe(true);
            if (isRecoError(error)) expect(error.code).toBe("RECO_ALIGNMENT_INVALID");
        }
    });
});

describe("alignFace", () => {
    test("is the identity for the reference landmarks on a 112x112 crop", () => {
        const image = gradient(112, 112);
        const aligned = alignFace(image, ARC_DST);

        expect(aligned.width).toBe(112);
        expect(aligned.height).toBe(112);
        expect(Array.from(aligned.data)).toEqual(Array.from(image.data));
    });

    test("scales the reference frame with the crop size", () => {
        const image = gradient(224, 224);
        const keypoints = ARC_DST.map((point) => ({ x: point.x * 2, y: point.y * 2 }));
        const aligned = alignFace(image, keypoints, 224);

        expect(aligned.width).toBe(224);
        expect(Array.from(aligned.data)).toEqual(Array.from(image.data));
    });

    test("refuses a wrong landmark count", () => {
        expect(() => alignFace(gradient(16, 16), ARC_DST.slice(0, 4))).toThrow("landmarks");
    });
});

describe("toRecognitionTensor", () => {
    test("packs CHW and normalizes around 127.5", () => {
        const aligned: RecoImage = {
            data: Uint8Array.from([0, 127, 255, 255, 127, 0, 127, 255, 0, 0, 255, 127]),
            width: 2,
            height: 2,
        };
        const tensor = toRecognitionTensor(aligned);
        const normalize = (value: number) => (value - 127.5) / 127.5;
        const expected = [
            normalize(0), normalize(255), normalize(127), normalize(0),
            normalize(127), normalize(127), normalize(255), normalize(255),
            normalize(255), normalize(0), normalize(0), normalize(127),
        ];

        expect(tensor.length).toBe(12);
        expected.forEach((value, index) => expect(tensor[index]!).toBeCloseTo(value, 5));
    });
});
