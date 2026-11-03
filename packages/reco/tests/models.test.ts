import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine, isRecoError } from "../index";
import { ZIP_MODELS } from "./fixtures";

const canExtract = Boolean(Bun.which("unzip") || Bun.which("tar"));

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
    try {
        await promise;
        return undefined;
    } catch (error) {
        return isRecoError(error) ? error.code : (error as Error).message;
    }
}

function tempDir(): string {
    return mkdtempSync(join(tmpdir(), "reco-models-"));
}

describe("automatic model download", () => {
    const warn = console.warn;
    beforeAll(() => {
        console.warn = () => {};
    });
    afterAll(() => {
        console.warn = warn;
    });

    test.skipIf(!canExtract)("downloads and extracts the pack when the models are missing", async () => {
        const zip = Buffer.from(ZIP_MODELS, "base64");
        const server = Bun.serve({ port: 0, fetch: () => new Response(zip) });
        const dir = tempDir();

        try {
            const code = await codeOf(
                createEngine({
                    modelDir: dir,
                    modelUrl: `http://127.0.0.1:${server.port}/buffalo_l.zip`,
                    downloadTimeoutMs: 5000,
                }),
            );

            // The archive holds dummy files: extraction works, ONNX Runtime refuses them.
            expect(code).toBe("RECO_MODEL_INVALID");
            expect(existsSync(join(dir, "det_10g.onnx"))).toBe(true);
            expect(existsSync(join(dir, "w600k_r50.onnx"))).toBe(true);
            expect(existsSync(join(dir, ".buffalo_l.zip"))).toBe(false);
        } finally {
            server.stop(true);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("fails with RECO_MODEL_DOWNLOAD_FAILED when the URL is unreachable", async () => {
        const dir = tempDir();
        try {
            const code = await codeOf(
                createEngine({
                    modelDir: dir,
                    modelUrl: "http://127.0.0.1:1/buffalo_l.zip",
                    downloadTimeoutMs: 2000,
                }),
            );
            expect(code).toBe("RECO_MODEL_DOWNLOAD_FAILED");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("never touches the network when both files already exist", async () => {
        const dir = tempDir();
        writeFileSync(join(dir, "det_10g.onnx"), "not a model");
        writeFileSync(join(dir, "w600k_r50.onnx"), "not a model");

        try {
            const code = await codeOf(
                createEngine({
                    modelDir: dir,
                    modelUrl: "http://127.0.0.1:1/buffalo_l.zip",
                    downloadTimeoutMs: 1000,
                }),
            );
            // Reaches ONNX Runtime instead of the downloader.
            expect(code).toBe("RECO_MODEL_INVALID");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("does not download custom model names", async () => {
        const dir = tempDir();
        try {
            const code = await codeOf(
                createEngine({
                    modelDir: dir,
                    detModel: "custom-det.onnx",
                    recModel: "custom-rec.onnx",
                    modelUrl: "http://127.0.0.1:1/buffalo_l.zip",
                    downloadTimeoutMs: 1000,
                }),
            );
            expect(code).toBe("RECO_MODEL_NOT_FOUND");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test("autoDownload: false keeps the old behaviour", async () => {
        const dir = tempDir();
        try {
            const code = await codeOf(createEngine({ modelDir: dir, autoDownload: false }));
            expect(code).toBe("RECO_MODEL_NOT_FOUND");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
