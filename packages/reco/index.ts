export {
    RecoEngine,
    createEngine,
    DEFAULT_DET_SIZE,
    DEFAULT_DET_THRESHOLD,
    DEFAULT_FACE_SIZE,
    DEFAULT_MODEL_DIR,
    DEFAULT_NMS_THRESHOLD,
} from "./lib/engine";
export { RecoError, isRecoError } from "./lib/errors";
export type { RecoErrorCode } from "./lib/errors";
export {
    DEFAULT_DET_MODEL,
    DEFAULT_DOWNLOAD_TIMEOUT_MS,
    DEFAULT_MODEL_URL,
    DEFAULT_REC_MODEL,
    downloadModels,
    ensureModels,
    modelsPresent,
} from "./lib/models";
export type { DownloadModelsOptions, ModelDownloadProgress } from "./lib/models";
export { isBase64Image, isRecoImage, loadImage, resizeImage } from "./lib/image";
export { ARC_DST, alignFace, similarityTransform, toRecognitionTensor } from "./lib/geometry";
export type { SimilarityTransform } from "./lib/geometry";
export {
    clipDetections,
    decodeDetections,
    detectorResize,
    groupDetectorOutputs,
    nms,
    toDetectorTensor,
} from "./lib/detect";
export type { DecodeDetectionsOptions, DetectorOutputGroup, DetectorTensor } from "./lib/detect";
export { cosineSimilarity, findBestMatch, normalizeEmbedding } from "./lib/similarity";
export type {
    Base64Image,
    DetectOptions,
    ExecutionProvider,
    FaceBox,
    FaceDetection,
    FaceResult,
    FindMatchOptions,
    ImageInput,
    LoadImageOptions,
    MatchResult,
    RecoEngineOptions,
    RecoImage,
    RecoPoint,
    RecognizeOptions,
    ResolvedRecoEngineOptions,
} from "./types/reco";
