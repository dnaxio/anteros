import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RecoError } from "./errors";

/** The InsightFace release this package loads `det_10g.onnx` and `w600k_r50.onnx` from. */
export const DEFAULT_MODEL_URL =
    "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip";

export const DEFAULT_DET_MODEL = "det_10g.onnx";
export const DEFAULT_REC_MODEL = "w600k_r50.onnx";
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 600_000;

export interface ModelDownloadProgress {
    readonly received: number;
    readonly total?: number;
}

export interface DownloadModelsOptions {
    /** Directory the pack is extracted into. Created if missing. */
    readonly modelDir: string;
    /** Defaults to the buffalo_l release URL. */
    readonly url?: string;
    /** Abort the download after this many milliseconds. Default 10 minutes. */
    readonly timeoutMs?: number;
    /** Detector file name to check after extraction. Default `det_10g.onnx`. */
    readonly detModel?: string;
    /** Recognizer file name to check after extraction. Default `w600k_r50.onnx`. */
    readonly recModel?: string;
    readonly onProgress?: (progress: ModelDownloadProgress) => void;
}

const inflight = new Map<string, Promise<void>>();

/** True when both model files exist in `modelDir`. */
export function modelsPresent(modelDir: string, detModel = DEFAULT_DET_MODEL, recModel = DEFAULT_REC_MODEL): boolean {
    return existsSync(join(modelDir, detModel)) && existsSync(join(modelDir, recModel));
}

/**
 * Makes sure the two model files are on disk, downloading and extracting the pack when
 * they are missing. Concurrent calls for the same directory share one download.
 */
export async function ensureModels(options: DownloadModelsOptions): Promise<void> {
    const url = options.url ?? DEFAULT_MODEL_URL;
    if (modelsPresent(options.modelDir, options.detModel, options.recModel)) return;

    const key = `${options.modelDir}\0${url}`;
    const pending = inflight.get(key);
    if (pending) return pending;

    const task = downloadModels({ ...options, url }).finally(() => inflight.delete(key));
    inflight.set(key, task);
    return task;
}

/**
 * Downloads the buffalo_l archive and extracts it into `modelDir`, using `fetch` and
 * `unzip` (or `tar`, which reads zip on macOS and Windows). The archive is removed after a
 * successful extraction and kept on failure so it can be extracted by hand.
 */
export async function downloadModels(options: DownloadModelsOptions): Promise<void> {
    const { modelDir, url = DEFAULT_MODEL_URL, timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS } = options;
    const detModel = options.detModel ?? DEFAULT_DET_MODEL;
    const recModel = options.recModel ?? DEFAULT_REC_MODEL;

    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch (error) {
        throw new RecoError("RECO_MODEL_DOWNLOAD_FAILED", `Invalid model URL '${url}'`, { cause: error });
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new RecoError("RECO_MODEL_DOWNLOAD_FAILED", `Unsupported model URL protocol '${parsed.protocol}'`);
    }

    mkdirSync(modelDir, { recursive: true });
    const archive = join(modelDir, ".buffalo_l.zip");

    let response: Response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
        throw new RecoError(
            "RECO_MODEL_DOWNLOAD_FAILED",
            `Cannot download ${url}: ${(error as Error).message}`,
            { cause: error },
        );
    }
    if (!response.ok) {
        throw new RecoError("RECO_MODEL_DOWNLOAD_FAILED", `Cannot download ${url}: HTTP ${response.status}`);
    }
    if (!response.body) {
        throw new RecoError("RECO_MODEL_DOWNLOAD_FAILED", `Cannot download ${url}: empty response body`);
    }

    const total = Number(response.headers.get("content-length")) || undefined;
    let received = 0;
    try {
        const writer = Bun.file(archive).writer();
        for await (const chunk of response.body) {
            writer.write(chunk);
            received += chunk.byteLength;
            options.onProgress?.({ received, total });
        }
        await writer.end();
    } catch (error) {
        rmSync(archive, { force: true });
        throw new RecoError(
            "RECO_MODEL_DOWNLOAD_FAILED",
            `Download of ${url} stopped after ${received} bytes: ${(error as Error).message}`,
            { cause: error },
        );
    }

    extract(archive, modelDir);

    if (!modelsPresent(modelDir, detModel, recModel)) {
        throw new RecoError(
            "RECO_MODEL_EXTRACT_FAILED",
            `The archive did not contain ${detModel} and ${recModel} in ${modelDir}`,
        );
    }
    rmSync(archive, { force: true });
}

function extract(archive: string, modelDir: string): void {
    const unzip = Bun.which("unzip");
    const tar = unzip ? undefined : Bun.which("tar");
    if (!unzip && !tar) {
        throw new RecoError(
            "RECO_MODEL_EXTRACT_FAILED",
            `Neither unzip nor tar is available — extract ${archive} into ${modelDir} manually`,
        );
    }

    const command = unzip ? [unzip, "-oq", archive, "-d", modelDir] : [tar!, "-xf", archive, "-C", modelDir];
    const result = Bun.spawnSync(command, { stdio: ["ignore", "ignore", "pipe"] });
    if (result.exitCode !== 0) {
        const stderr = result.stderr ? result.stderr.toString().trim().slice(0, 500) : "";
        throw new RecoError(
            "RECO_MODEL_EXTRACT_FAILED",
            `Extraction failed (exit ${result.exitCode})${stderr ? `: ${stderr}` : ""} — archive kept at ${archive}`,
        );
    }
}
