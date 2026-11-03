import { describe, expect, test } from "bun:test";
import { cosineSimilarity, findBestMatch, isRecoError, normalizeEmbedding } from "../index";

describe("normalizeEmbedding", () => {
    test("scales to unit length", () => {
        const normalized = normalizeEmbedding([3, 4]);
        expect(normalized[0]).toBeCloseTo(0.6, 6);
        expect(normalized[1]).toBeCloseTo(0.8, 6);
    });

    test("refuses a zero vector", () => {
        try {
            normalizeEmbedding([0, 0, 0]);
            throw new Error("expected a failure");
        } catch (error) {
            expect(isRecoError(error)).toBe(true);
            if (isRecoError(error)) expect(error.code).toBe("RECO_EMBEDDING_INVALID");
        }
    });

    test("refuses a non-finite value", () => {
        expect(() => normalizeEmbedding([1, Number.NaN])).toThrow("non-finite");
    });
});

describe("cosineSimilarity", () => {
    test("scores an identical embedding at 1", () => {
        expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 12);
    });

    test("scores opposite vectors at -1", () => {
        expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 12);
    });

    test("scores orthogonal vectors at 0", () => {
        expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 12);
    });

    test("refuses a dimension mismatch instead of truncating", () => {
        expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow("different dimensions");
    });

    test("refuses a zero vector", () => {
        expect(() => cosineSimilarity([0, 0], [1, 1])).toThrow("zero-length");
    });
});

describe("findBestMatch", () => {
    test("returns the closest candidate above the threshold", () => {
        const match = findBestMatch([1, 0], [[0, 1], [1, 0.1], [-1, 0]], { threshold: 0.5 });
        expect(match?.index).toBe(1);
        expect(match?.score).toBeCloseTo(0.995, 3);
    });

    test("returns undefined when no candidate clears the threshold", () => {
        expect(findBestMatch([1, 0], [[0, 1], [-1, 0]], { threshold: 0.5 })).toBeUndefined();
    });
});
