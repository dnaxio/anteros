export type RecoErrorCode =
    | "RECO_MODEL_NOT_FOUND"
    | "RECO_MODEL_INVALID"
    | "RECO_MODEL_DOWNLOAD_FAILED"
    | "RECO_MODEL_EXTRACT_FAILED"
    | "RECO_INFERENCE_FAILED"
    | "RECO_IMAGE_INVALID"
    | "RECO_IMAGE_UNSUPPORTED"
    | "RECO_NO_FACE"
    | "RECO_ALIGNMENT_INVALID"
    | "RECO_EMBEDDING_INVALID"
    | "RECO_ENGINE_CLOSED";

/** A failure with a stable `code`, so callers branch on the code rather than the message. */
export class RecoError extends Error {
    readonly code: RecoErrorCode;

    constructor(code: RecoErrorCode, message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "RecoError";
        this.code = code;
    }
}

export function isRecoError(error: unknown): error is RecoError {
    return error instanceof RecoError;
}
