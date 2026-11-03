import { RecoError } from "./errors";
import type { FindMatchOptions, MatchResult } from "../types/reco";

/** Scales a vector to unit length, so cosine similarity is a dot product. */
export function normalizeEmbedding(vector: ArrayLike<number>): Float32Array {
    if (vector.length === 0) {
        throw new RecoError("RECO_EMBEDDING_INVALID", "Cannot normalize an empty embedding");
    }

    let sum = 0;
    for (let i = 0; i < vector.length; i++) {
        const value = vector[i]!;
        if (!Number.isFinite(value)) {
            throw new RecoError("RECO_EMBEDDING_INVALID", `The embedding contains a non-finite value at ${i}`);
        }
        sum += value * value;
    }

    const norm = Math.sqrt(sum);
    if (!(norm > 0)) {
        throw new RecoError("RECO_EMBEDDING_INVALID", "Cannot normalize a zero-length embedding");
    }

    const out = new Float32Array(vector.length);
    for (let i = 0; i < vector.length; i++) out[i] = vector[i]! / norm;
    return out;
}

/**
 * Cosine similarity in `[-1, 1]`; embeddings of the same face score close to 1.
 * Throws on a dimension mismatch rather than truncating in silence.
 */
export function cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>): number {
    if (left.length !== right.length) {
        throw new RecoError(
            "RECO_EMBEDDING_INVALID",
            `Embeddings have different dimensions (${left.length} vs ${right.length})`,
        );
    }
    if (left.length === 0) {
        throw new RecoError("RECO_EMBEDDING_INVALID", "Cannot compare empty embeddings");
    }

    let dot = 0;
    let normLeft = 0;
    let normRight = 0;
    for (let i = 0; i < left.length; i++) {
        const a = left[i]!;
        const b = right[i]!;
        dot += a * b;
        normLeft += a * a;
        normRight += b * b;
    }

    if (!(normLeft > 0) || !(normRight > 0)) {
        throw new RecoError("RECO_EMBEDDING_INVALID", "Cannot compare a zero-length embedding");
    }

    return Math.max(-1, Math.min(1, dot / Math.sqrt(normLeft * normRight)));
}

/** Best cosine match among `candidates`, or `undefined` when none clears `threshold`. */
export function findBestMatch(
    query: ArrayLike<number>,
    candidates: readonly ArrayLike<number>[],
    options: FindMatchOptions = {},
): MatchResult | undefined {
    const threshold = options.threshold ?? -1;
    let best: MatchResult | undefined;

    for (let index = 0; index < candidates.length; index++) {
        const score = cosineSimilarity(query, candidates[index]!);
        if (score < threshold) continue;
        if (!best || score > best.score) best = { index, score };
    }
    return best;
}
