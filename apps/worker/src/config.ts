import path from "node:path";

export type WorkerConfig = {
  serverUrl: string;
  token: string;
  pollIntervalMs: number;
  maxConcurrentJobs: number;
  outputDir: string;
  converterBackend: "occt-js" | "xcaf-baseline";
  converterCli: string;
  xcafConverterBin: string;
  xcafColourMode: "xcaf-baseline" | "step-presentation";
  quality: string;
  glbOptimizationMode: "disabled" | "meshopt";
  runOnce: boolean;
  keepWorkerOutput: boolean;
  maxModelArtifactBytes: number;
};

export function loadConfig(argv = process.argv): WorkerConfig {
  const token = process.env.WORKER_API_TOKEN;
  if (!token) {
    throw new Error("WORKER_API_TOKEN is required for the worker.");
  }

  const pollIntervalSeconds = Number(process.env.POLL_INTERVAL_SECONDS || 15);
  const quality = process.env.CONVERTER_QUALITY || "balanced";
  if (!["fast", "balanced", "high", "detailed"].includes(quality)) {
    throw new Error("CONVERTER_QUALITY must be fast, balanced, high, or detailed.");
  }

  const converterBackend = process.env.CONVERTER_BACKEND || "occt-js";
  if (!["occt-js", "xcaf-baseline"].includes(converterBackend)) {
    throw new Error("CONVERTER_BACKEND must be occt-js or xcaf-baseline.");
  }
  const xcafColourMode = process.env.XCAF_COLOUR_MODE || "xcaf-baseline";
  if (!["xcaf-baseline", "step-presentation"].includes(xcafColourMode)) {
    throw new Error("XCAF_COLOUR_MODE must be xcaf-baseline or step-presentation.");
  }

    const glbOptimizationMode = process.env.GLB_OPTIMIZATION_MODE || "disabled";
  if (!["disabled", "meshopt"].includes(glbOptimizationMode)) {
    throw new Error("GLB_OPTIMIZATION_MODE must be disabled or meshopt.");
  }

  return {
    serverUrl: trimTrailingSlash(process.env.SERVER_URL || "http://localhost:3009"),
    token,
    pollIntervalMs: Math.max(1, pollIntervalSeconds) * 1000,
    maxConcurrentJobs: positiveInteger(
      process.env.WORKER_MAX_CONCURRENT_JOBS,
      1,
      "WORKER_MAX_CONCURRENT_JOBS"
    ),
    outputDir: path.resolve(process.env.WORKER_OUTPUT_DIR || "./worker-output"),
    converterBackend: converterBackend as WorkerConfig["converterBackend"],
    converterCli: path.resolve(process.env.CONVERTER_CLI || "../converter/src/cli.js"),
    xcafConverterBin: path.resolve(process.env.XCAF_CONVERTER_BIN || "/app/bin/xcaf-step-to-glb"),
    xcafColourMode: xcafColourMode as WorkerConfig["xcafColourMode"],
    quality,
    glbOptimizationMode: glbOptimizationMode as "disabled" | "meshopt",
    runOnce: process.env.RUN_ONCE === "true" || argv.includes("--once"),
    keepWorkerOutput: process.env.KEEP_WORKER_OUTPUT !== "false",
    maxModelArtifactBytes: positiveInteger(
      process.env.MAX_MODEL_ARTIFACT_BYTES,
      1024 * 1024 * 1024,
      "MAX_MODEL_ARTIFACT_BYTES"
    )
  };
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
