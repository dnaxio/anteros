import { DEFAULT_MODEL_URL, downloadModels, modelsPresent } from "../lib/models";

const modelDir = process.env.RECO_MODEL_DIR ?? "./models/buffalo_l";

if (modelsPresent(modelDir)) {
    console.log(`Models already present in ${modelDir}`);
    process.exit(0);
}

console.log(`Downloading buffalo_l into ${modelDir} (~280 MB)`);
let shown = -1;

await downloadModels({
    modelDir,
    url: DEFAULT_MODEL_URL,
    onProgress: ({ received, total }) => {
        if (!total) return;
        const percent = Math.floor((received / total) * 100);
        if (percent >= shown + 10) {
            shown = percent;
            console.error(`${percent}%`);
        }
    },
});

console.log(`Done: det_10g.onnx, w600k_r50.onnx in ${modelDir}`);
console.warn(
    "License: the InsightFace buffalo_l weights are for non-commercial research use only. " +
        "See https://github.com/deepinsight/insightface/blob/master/model_zoo/README.md",
);
