# @anteros/reco

Face detection and recognition on the **[InsightFace](https://github.com/deepinsight/insightface)** `buffalo_l`
pack, running locally through ONNX Runtime.

- **`det_10g`** finds faces — boxes, confidence, five landmarks
- **`w600k_r50`** turns an aligned face into a **512-dimension unit embedding**
- `detect`, `embed`, `recognize`, `getDescriptors`, `getDescriptor`, `embedAligned`, `compare`,
  `cosineSimilarity`, `findBestMatch`
- Bytes, **base64 strings**, **data URLs**, `{ base64 }` and an explicit `{ path }` are all accepted
- No API key, no network at inference: two `.onnx` files and two portable native dependencies

> ⚠️ **The weights are non-commercial.** InsightFace's code is MIT, but the `buffalo_l` models are released
> for non-commercial research use only. A commercial deployment needs a license from InsightFace — see the
> [model zoo notice](https://github.com/deepinsight/insightface/blob/master/model_zoo/README.md).

## Install

```bash
bun add @anteros/reco
```

## Download the models

`createEngine()` downloads the pack when `det_10g.onnx` and `w600k_r50.onnx` are missing — once per
directory, ~280 MB, then the files stay:

```ts
const engine = await createEngine(); // fetches ./models/buffalo_l if needed
```

`autoDownload: false` turns it off; `modelUrl` and `downloadTimeoutMs` (default 10 minutes) tune it.
Extraction uses `unzip`, or `tar` when `unzip` is absent. Only the default file names are downloaded.

From a checkout of this repository, the same download as a script:

```bash
bun run packages/reco/scripts/download-models.ts   # -> ./models/buffalo_l
```

The same step is exported: `downloadModels()`, `ensureModels()` and `modelsPresent()`.

Otherwise, the two commands InsightFace documents:

```bash
curl -L -O https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip
unzip buffalo_l.zip -d models/buffalo_l
```

Only `det_10g.onnx` and `w600k_r50.onnx` are loaded, out of the five files in the pack (~340 MB on disk).
`createEngine({ modelDir })` points at the directory; `RECO_MODEL_DIR` does the same without code.

## Quick start

```ts
import { cosineSimilarity, createEngine } from "@anteros/reco";

const engine = await createEngine({ modelDir: "./models/buffalo_l" });

// Every face, best score first: box, five landmarks, unit embedding.
const faces = await engine.recognize("./team.jpg");
for (const face of faces) console.log(face.score, face.box, face.embedding.length); // 512

// 1:1 — the best face of each image.
const score = await engine.compare("./alice-1.jpg", "./alice-2.jpg");

// 1:N — your own index.
const found = faces
  .map((face, index) => ({ index, score: cosineSimilarity(face.embedding, stored) }))
  .sort((left, right) => right.score - left.score)[0];

await engine.close();
```

One engine owns both sessions: create it once, reuse it. `close()` is idempotent; later calls fail with
`RECO_ENGINE_CLOSED`.

## Detecting and embedding separately

```ts
import { loadImage } from "@anteros/reco";

const image = await loadImage("./group.jpg");      // decode once, EXIF applied
const faces = await engine.detect(image, { threshold: 0.6, maxFaces: 5 });
const embedding = await engine.embed(image, faces[0]);
```

Every method accepts encoded bytes, a `Blob` (`Bun.file()` included), a base64 string, a `data:`
URL, an explicit `{ base64 }`, an explicit `{ path }`, or an image already decoded by `loadImage()`.
A **bare string is base64 or a `data:` URL — never a path** (see the safety note below).

Already have an aligned square crop? `embedAligned(crop)` skips the detector. A non-square crop is refused.

## Descriptors

```ts
// Every detected face, best score first: 512-d unit vectors.
const descriptors = await engine.getDescriptors({ path: "./team.jpg" });

// The best face only, or null when there is none.
const best = await engine.getDescriptor({ path: "./alice.jpg" });

// Base64 works the same way.
const fromDataUrl = await engine.getDescriptors(`data:image/jpeg;base64,${payload}`);
const explicit = await engine.getDescriptor({ base64: payload, mimeType: "image/jpeg" });
const bare = await engine.getDescriptors(payload);
```

## Options

| Option           | Default                    | Description                                                    |
| ---------------- | -------------------------- | -------------------------------------------------------------- |
| `modelDir`       | `RECO_MODEL_DIR` or `./models/buffalo_l` | Where the two `.onnx` files live.              |
| `detModel`       | `'det_10g.onnx'`           | Detector file name.                                            |
| `recModel`       | `'w600k_r50.onnx'`         | Recognizer file name.                                          |
| `providers`      | `['cpu']`                  | ONNX Runtime execution providers.                              |
| `detSize`        | `640`                      | Detector input edge.                                           |
| `detThreshold`   | `0.5`                      | Detector confidence threshold.                                 |
| `nmsThreshold`   | `0.4`                      | IoU above which boxes are merged.                              |
| `maxFaces`       | `0` (all)                  | Keep the best N faces.                                         |
| `faceSize`       | `112`                      | Aligned crop edge (`w600k_r50` wants 112).                     |
| `maxPixels`      | sharp's ~268 MP            | Refuse a larger image before decoding (untrusted input).       |
| `allowPath`      | `false`                    | Let a **bare string** name a file (legacy; trusted input only). |
| `autoDownload`   | `true`                     | Fetch buffalo_l when the two default models are missing.       |
| `modelUrl`       | buffalo_l release          | Archive used by `autoDownload`.                                |
| `downloadTimeoutMs` | `600000`                | Abort the download after this many milliseconds.               |
| `sessionOptions` | —                          | Merged into both ONNX Runtime sessions.                        |

`detect` / `recognize` / `getDescriptors` / `getDescriptor` / `embed` take `detSize`, `threshold`,
`nmsThreshold` and `maxFaces` per call.

## Errors

Every failure is a `RecoError` with a stable code: `RECO_MODEL_NOT_FOUND`, `RECO_MODEL_INVALID`,
`RECO_MODEL_DOWNLOAD_FAILED`, `RECO_MODEL_EXTRACT_FAILED`, `RECO_INFERENCE_FAILED`, `RECO_IMAGE_INVALID`,
`RECO_IMAGE_UNSUPPORTED`, `RECO_NO_FACE`, `RECO_ALIGNMENT_INVALID`, `RECO_EMBEDDING_INVALID`,
`RECO_ENGINE_CLOSED`.

## Notes

- Embeddings are unit vectors, so cosine similarity is a dot product. There is no universal threshold:
  calibrate it on your own pairs.
- One face is embedded at a time on the CPU. Lower `detSize` or cap `maxFaces` to trade accuracy for speed.
- An embedding is biometric personal data (special category under the GDPR): collect it lawfully, keep it
  only as long as needed, encrypt it at rest.
- **A bare string is never a path.** A string is base64 or a `data:` URL; reading a local file is an
  explicit `{ path }`, and the engine refuses anything else (`RECO_IMAGE_INVALID`) **before touching the
  filesystem**. A query parameter or an uploaded filename therefore cannot become an arbitrary-file-read
  primitive. `allowPath: true` restores the legacy "a bare string may name a file" behaviour for trusted,
  local input. For untrusted images, also lower `maxPixels` (defaults to sharp's ~268 MP).
- `sharp` and `onnxruntime-node` are native dependencies, both with prebuilt binaries. `bun add` may report
  a blocked postinstall for ONNX Runtime; the binary shipped in the package is enough — no trust step.
- Images are decoded by `sharp`: EXIF applied, colour converted to sRGB, 16-bit downscaled. `maxPixels`
  maps to sharp's `limitInputPixels`.
