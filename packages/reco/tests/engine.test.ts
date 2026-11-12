import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createEngine, cosineSimilarity, isRecoError } from "../index";
import type { RecoEngine, RecoImage } from "../index";

const modelDir = process.env.RECO_MODEL_DIR ?? join(import.meta.dir, "../../../models/buffalo_l");
const modelsAvailable =
    existsSync(join(modelDir, "det_10g.onnx")) && existsSync(join(modelDir, "w600k_r50.onnx"));

const testImage = process.env.RECO_TEST_IMAGE;

function blank(size = 64): RecoImage {
    return { data: new Uint8Array(size * size * 3).fill(128), width: size, height: size };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
    try {
        await promise;
        return undefined;
    } catch (error) {
        return isRecoError(error) ? error.code : (error as Error).message;
    }
}

describe("createEngine", () => {
    test("refuses a missing model directory with a stable code", async () => {
        expect(
            await codeOf(
                createEngine({
                    modelDir: join(import.meta.dir, "does-not-exist"),
                    autoDownload: false,
                }),
            ),
        ).toBe("RECO_MODEL_NOT_FOUND");
    });
});

const integration = modelsAvailable ? describe : describe.skip;

integration("with the buffalo_l weights", () => {
    let engine: RecoEngine;

    beforeAll(async () => {
        engine = await createEngine({ modelDir });
    });

    afterAll(async () => {
        await engine?.close();
    });

    test("loads both sessions", () => {
        expect(engine.sessions.det.outputNames).toHaveLength(9);
        expect(engine.sessions.rec.inputNames).toHaveLength(1);
        expect(engine.sessions.rec.outputNames).toHaveLength(1);
        expect(engine.options.detSize).toBe(640);
        expect(engine.options.faceSize).toBe(112);
    });

    test("finds no face in a blank image", async () => {
        expect(await engine.detect(blank())).toEqual([]);
        expect(await engine.recognize(blank())).toEqual([]);
    });

    test("reports RECO_NO_FACE when asked to embed a blank image", async () => {
        expect(await codeOf(engine.embed(blank()))).toBe("RECO_NO_FACE");
        expect(await engine.getDescriptors(blank())).toEqual([]);
        expect(await engine.getDescriptor(blank())).toBeNull();
    });

    test("refuses a non-square aligned crop", async () => {
        const crop = { data: new Uint8Array(20 * 10 * 3), width: 20, height: 10 };
        expect(await codeOf(engine.embedAligned(crop))).toBe("RECO_ALIGNMENT_INVALID");
    });

    test("refuses to run after close()", async () => {
        const disposable = await createEngine({ modelDir });
        await disposable.close();
        expect(disposable.disposed).toBe(true);
        expect(await codeOf(disposable.detect(blank()))).toBe("RECO_ENGINE_CLOSED");
    });

    const withPhoto = testImage && existsSync(testImage) ? test : test.skip;

    test("refuses a bare path — a string is base64, not a file", async () => {
        // No filesystem access: the string never reaches `existsSync` / sharp
        expect(await codeOf(engine.detect("/etc/hosts"))).toBe("RECO_IMAGE_INVALID");
        expect(await codeOf(engine.getDescriptor("/etc/hosts"))).toBe("RECO_IMAGE_INVALID");
    });

    withPhoto("detects a real face, embeds it, and compares it to itself", async () => {
        const photo = testImage!;
        const faces = await engine.recognize({ path: photo });
        expect(faces.length).toBeGreaterThan(0);

        const face = faces[0]!;
        expect(face.score).toBeGreaterThan(0.5);
        expect(face.keypoints).toHaveLength(5);
        expect(face.embedding).toBeInstanceOf(Float32Array);
        expect(face.embedding.length).toBe(512);

        const norm = Math.hypot(...face.embedding);
        expect(norm).toBeCloseTo(1, 5);

        expect(await engine.compare({ path: photo }, { path: photo })).toBeCloseTo(1, 5);
        expect(cosineSimilarity(face.embedding, face.embedding)).toBeCloseTo(1, 6);
    });

    withPhoto("returns 512-d descriptors from a path, base64 and a data URL", async () => {
        const photo = testImage!;

        const descriptors = await engine.getDescriptors({ path: photo }, { maxFaces: 2 });
        expect(descriptors.length).toBe(2);
        for (const descriptor of descriptors) {
            expect(descriptor).toBeInstanceOf(Float32Array);
            expect(descriptor.length).toBe(512);
            expect(Math.hypot(...descriptor)).toBeCloseTo(1, 5);
        }

        expect((await engine.getDescriptor({ path: photo }))?.length).toBe(512);

        const base64 = Buffer.from(await Bun.file(photo).bytes()).toString("base64");
        expect((await engine.getDescriptors(`data:image/jpeg;base64,${base64}`, { maxFaces: 1 })).length).toBe(1);
        expect((await engine.getDescriptor({ base64 }))?.length).toBe(512);
    });

    const alignedImage = process.env.RECO_TEST_ALIGNED_IMAGE;
    const withAligned = alignedImage && existsSync(alignedImage) ? test : test.skip;

    withAligned("embeds an already aligned square crop", async () => {
        const embedding = await engine.embedAligned({ path: alignedImage! });
        expect(embedding.length).toBe(512);
        expect(Math.hypot(...embedding)).toBeCloseTo(1, 5);
    });
});
