import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { convertStepJob } from "../src/converterProcessor.js";
import type { ConversionQuality } from "../src/quality.js";

const { values } = parseArgs({
  options: {
    input: { type: "string", short: "i" },
    output: { type: "string", short: "o" },
    quality: { type: "string", short: "q", default: "medium" },
    mode: { type: "string", default: "meshopt" }
  }
});

if (!values.input) throw new Error("--input <STEP/STP path> is required");
const sourcePath = path.resolve(values.input);
const extension = path.extname(sourcePath).toLowerCase();
if (!fs.existsSync(sourcePath) || ![".step", ".stp"].includes(extension)) {
  throw new Error("--input must reference an existing .step or .stp file");
}
if (!new Set(["low", "medium", "high"]).has(values.quality ?? "")) {
  throw new Error("--quality must be low, medium, or high");
}
if (!new Set(["disabled", "meshopt"]).has(values.mode ?? "")) {
  throw new Error("--mode must be disabled or meshopt");
}

const outputDir = path.resolve(values.output ?? path.join(".tmp", "meshopt-step-validation"));
const slug = path.basename(sourcePath, extension).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
const converterCli = fileURLToPath(new URL("../../converter/src/cli.js", import.meta.url));

const result = await convertStepJob({
  slug,
  sourcePath,
  outputDir,
  converterBackend: "occt-js",
  converterCli,
  xcafConverterBin: "",
  xcafColourMode: "xcaf-baseline",
  quality: values.quality as ConversionQuality,
  glbOptimizationMode: values.mode as "disabled" | "meshopt",
  largeStepChunkingMode: "disabled"
});

const stats = JSON.parse(await fs.promises.readFile(result.statsPath, "utf8"));
console.log(JSON.stringify({
  fixture: path.basename(sourcePath),
  outputDir: path.dirname(result.displayGlbPath),
  sourceFileSizeBytes: stats.sourceFileSizeBytes,
  triangleCount: stats.triangleCount,
  backend: stats.converterBackend,
  qualityPreset: stats.qualityPreset ?? stats.semanticQuality,
  colourMode: stats.optimization?.colourMode ?? stats.colourMode ?? null,
  optimization: stats.optimization
}, null, 2));
