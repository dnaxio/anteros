import { describe, expect, test } from "bun:test";
import { isRecoError, loadImage, resizeImage } from "../index";
import { JPEG_EXIF, PNG_16BIT, PNG_GRAY, PNG_RGB, PNG_RGBA } from "./fixtures";

describe("loadImage", () => {
    test("decodes base64 bytes", async () => {
        const image = await loadImage(PNG_RGB);

        expect(image.width).toBe(10);
        expect(image.height).toBe(20);
        expect(image.data.length).toBe(10 * 20 * 3);
        expect(Array.from(image.data.slice(0, 3))).toEqual([10, 20, 30]);
    });

    test("decodes a data URL", async () => {
        const image = await loadImage(`data:image/png;base64,${PNG_RGB}`);
        expect(image.data.length).toBe(10 * 20 * 3);
    });

    test("decodes an explicit { base64 } payload", async () => {
        const image = await loadImage({ base64: PNG_RGB, mimeType: "image/png" });
        expect(image.data.length).toBe(10 * 20 * 3);
    });

    test("drops the alpha channel", async () => {
        const image = await loadImage({ base64: PNG_RGBA });
        expect(image.data.length).toBe(10 * 20 * 3);
        expect(Array.from(image.data.slice(0, 3))).toEqual([10, 20, 30]);
    });

    test("converts grayscale to three channels", async () => {
        const image = await loadImage(PNG_GRAY);
        expect(image.data.length).toBe(10 * 10 * 3);
        expect(image.data[0]).toBe(128);
    });

    test("applies the EXIF orientation", async () => {
        const image = await loadImage(Buffer.from(JPEG_EXIF, "base64"));
        expect(image.width).toBe(10);
        expect(image.height).toBe(20);
    });

    test("downscales a 16-bit image to 8 bits", async () => {
        const image = await loadImage(PNG_16BIT);
        expect(image.data.length).toBe(4 * 4 * 3);
        expect(image.data[0]).toBe(255);
    });

    test("recognizes a bare base64 string", async () => {
        const image = await loadImage(JPEG_EXIF);
        expect(image.width).toBe(10);
        expect(image.height).toBe(20);
    });

    test("accepts a Blob, as Bun.file() returns one", async () => {
        const blob = new Blob([Buffer.from(PNG_RGB, "base64")]);
        const image = await loadImage(blob);
        expect(image.data.length).toBe(10 * 20 * 3);
    });

    test("honours maxPixels before allocating pixels", async () => {
        try {
            await loadImage(PNG_RGB, { maxPixels: 10 });
            throw new Error("expected a failure");
        } catch (error) {
            expect(isRecoError(error)).toBe(true);
            if (isRecoError(error)) expect(error.code).toBe("RECO_IMAGE_INVALID");
        }
    });

    test("accepts an already decoded image", async () => {
        const image = { data: new Uint8Array(3 * 2 * 2), width: 2, height: 2 };
        expect(await loadImage(image)).toBe(image);
    });

    test("refuses bytes that are not an image", async () => {
        try {
            await loadImage(Buffer.from("not an image"));
            throw new Error("expected a failure");
        } catch (error) {
            expect(isRecoError(error)).toBe(true);
            if (isRecoError(error)) expect(error.code).toBe("RECO_IMAGE_INVALID");
        }
    });

    test("refuses an invalid base64 payload", async () => {
        try {
            await loadImage({ base64: "not-base64!!" });
            throw new Error("expected a failure");
        } catch (error) {
            expect(isRecoError(error)).toBe(true);
            if (isRecoError(error)) expect(error.code).toBe("RECO_IMAGE_INVALID");
        }
    });

    test("refuses a decoded image with the wrong byte count", async () => {
        try {
            await loadImage({ data: new Uint8Array(3), width: 10, height: 10 });
            throw new Error("expected a failure");
        } catch (error) {
            expect(isRecoError(error)).toBe(true);
            if (isRecoError(error)) expect(error.code).toBe("RECO_IMAGE_UNSUPPORTED");
        }
    });
});

describe("resizeImage", () => {
    const twoByTwo = {
        data: Uint8Array.from([0, 0, 0, 255, 0, 0, 0, 255, 0, 255, 255, 255]),
        width: 2,
        height: 2,
    };

    test("returns the same image when the size does not change", async () => {
        expect(await resizeImage(twoByTwo, 2, 2)).toBe(twoByTwo);
    });

    test("doubles with bilinear sampling", async () => {
        const resized = await resizeImage(twoByTwo, 4, 4);

        expect(resized.width).toBe(4);
        expect(resized.height).toBe(4);
        expect(resized.data.length).toBe(4 * 4 * 3);
        expect(Array.from(resized.data.slice(0, 3))).toEqual([0, 0, 0]);
        expect(Array.from(resized.data.slice(9, 12))).toEqual([255, 0, 0]);
        expect(Array.from(resized.data.slice(36, 39))).toEqual([0, 255, 0]);
        expect(Array.from(resized.data.slice(45, 48))).toEqual([255, 255, 255]);
    });
});
