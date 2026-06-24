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
  largeStepChunkingMode: "disabled" | "auto" | "direct-filter";
  largeStepChunkConcurrencyMode: "fixed" | "adaptive";
  largeStepFileSizeThresholdMb: number;
  largeStepAutoMinFileSizeMb: number;
  largeStepAutoPlannerFileSizeMb: number;
  largeStepAutoPrescanEnabled: boolean;
  largeStepForcePlanner: boolean;
  largeStepLeafCountThreshold: number;
  largeStepFaceCountThreshold: number;
  largeStepWorkScoreThreshold: number;
  largeStepMinExpectedSpeedupFraction: number;
  largeStepTargetChunks: number;
  largeStepAutoMaxTargetChunks: number;
  largeStepMinConcurrentChunks: number;
  largeStepInitialConcurrentChunks: number;
  largeStepMaxConcurrentChunks: number;
  largeStepResourcePollSeconds: number;
  largeStepMaxWorkerMemoryFraction: number;
  largeStepMinFreeMemoryMb: number;
  largeStepMaxSwapGrowthMb: number;
  largeStepEmergencyMemoryFraction: number;
  largeStepScaleUpWarmupSeconds: number;
  largeStepScaleUpCooldownSeconds: number;
  largeStepEstimatedChunkMemoryMb: number;
  largeStepScaleUpMinFreeAfterReserveMb: number;
  largeStepMemoryBasedMaxCapEnabled: boolean;
  largeStepChunkFallbackMode: "fail" | "full-conversion";
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

  const largeStepChunkingMode = process.env.LARGE_STEP_CHUNKING_MODE || "disabled";
  if (!["disabled", "auto", "direct-filter"].includes(largeStepChunkingMode)) {
    throw new Error("LARGE_STEP_CHUNKING_MODE must be disabled, auto, or direct-filter.");
  }

  const largeStepChunkConcurrencyMode = process.env.LARGE_STEP_CHUNK_CONCURRENCY_MODE || "adaptive";
  if (!["fixed", "adaptive"].includes(largeStepChunkConcurrencyMode)) {
    throw new Error("LARGE_STEP_CHUNK_CONCURRENCY_MODE must be fixed or adaptive.");
  }

  const largeStepChunkFallbackMode = process.env.LARGE_STEP_CHUNK_FALLBACK_MODE || "fail";
  if (!["fail", "full-conversion"].includes(largeStepChunkFallbackMode)) {
    throw new Error("LARGE_STEP_CHUNK_FALLBACK_MODE must be fail or full-conversion.");
  }

  // Support LARGE_STEP_FILE_SIZE_THRESHOLD_MB as a fallback for LARGE_STEP_AUTO_MIN_FILE_SIZE_MB if defined.
  const defaultMinSize = process.env.LARGE_STEP_FILE_SIZE_THRESHOLD_MB
    ? Number(process.env.LARGE_STEP_FILE_SIZE_THRESHOLD_MB)
    : 25;

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
      262144000,
      "MAX_MODEL_ARTIFACT_BYTES"
    ),
    largeStepChunkingMode: largeStepChunkingMode as "disabled" | "auto" | "direct-filter",
    largeStepChunkConcurrencyMode: largeStepChunkConcurrencyMode as "fixed" | "adaptive",
    largeStepFileSizeThresholdMb: positiveInteger(
      process.env.LARGE_STEP_AUTO_MIN_FILE_SIZE_MB || process.env.LARGE_STEP_FILE_SIZE_THRESHOLD_MB,
      80,
      "LARGE_STEP_FILE_SIZE_THRESHOLD_MB"
    ),
    largeStepAutoMinFileSizeMb: positiveInteger(
      process.env.LARGE_STEP_AUTO_MIN_FILE_SIZE_MB,
      defaultMinSize,
      "LARGE_STEP_AUTO_MIN_FILE_SIZE_MB"
    ),
    largeStepAutoPlannerFileSizeMb: positiveInteger(
      process.env.LARGE_STEP_AUTO_PLANNER_FILE_SIZE_MB,
      80,
      "LARGE_STEP_AUTO_PLANNER_FILE_SIZE_MB"
    ),
    largeStepAutoPrescanEnabled: parseBoolean(
      process.env.LARGE_STEP_AUTO_PRESCAN_ENABLED,
      true
    ),
    largeStepForcePlanner: parseBoolean(
      process.env.LARGE_STEP_FORCE_PLANNER,
      false
    ),
    largeStepLeafCountThreshold: positiveInteger(
      process.env.LARGE_STEP_LEAF_COUNT_THRESHOLD,
      2000,
      "LARGE_STEP_LEAF_COUNT_THRESHOLD"
    ),
    largeStepFaceCountThreshold: positiveInteger(
      process.env.LARGE_STEP_FACE_COUNT_THRESHOLD,
      50000,
      "LARGE_STEP_FACE_COUNT_THRESHOLD"
    ),
    largeStepWorkScoreThreshold: positiveInteger(
      process.env.LARGE_STEP_WORK_SCORE_THRESHOLD,
      35000,
      "LARGE_STEP_WORK_SCORE_THRESHOLD"
    ),
    largeStepMinExpectedSpeedupFraction: positiveFloat(
      process.env.LARGE_STEP_MIN_EXPECTED_SPEEDUP_FRACTION,
      0.15,
      "LARGE_STEP_MIN_EXPECTED_SPEEDUP_FRACTION"
    ),
    largeStepTargetChunks: positiveInteger(
      process.env.LARGE_STEP_TARGET_CHUNKS,
      3,
      "LARGE_STEP_TARGET_CHUNKS"
    ),
    largeStepAutoMaxTargetChunks: positiveInteger(
      process.env.LARGE_STEP_AUTO_MAX_TARGET_CHUNKS,
      6,
      "LARGE_STEP_AUTO_MAX_TARGET_CHUNKS"
    ),
    largeStepMinConcurrentChunks: positiveInteger(
      process.env.LARGE_STEP_MIN_CONCURRENT_CHUNKS,
      1,
      "LARGE_STEP_MIN_CONCURRENT_CHUNKS"
    ),
    largeStepInitialConcurrentChunks: positiveInteger(
      process.env.LARGE_STEP_INITIAL_CONCURRENT_CHUNKS,
      2,
      "LARGE_STEP_INITIAL_CONCURRENT_CHUNKS"
    ),
    largeStepMaxConcurrentChunks: positiveInteger(
      process.env.LARGE_STEP_MAX_CONCURRENT_CHUNKS,
      3,
      "LARGE_STEP_MAX_CONCURRENT_CHUNKS"
    ),
    largeStepResourcePollSeconds: positiveInteger(
      process.env.LARGE_STEP_RESOURCE_POLL_SECONDS,
      10,
      "LARGE_STEP_RESOURCE_POLL_SECONDS"
    ),
    largeStepMaxWorkerMemoryFraction: positiveFloat(
      process.env.LARGE_STEP_MAX_WORKER_MEMORY_FRACTION,
      0.75,
      "LARGE_STEP_MAX_WORKER_MEMORY_FRACTION"
    ),
    largeStepMinFreeMemoryMb: positiveInteger(
      process.env.LARGE_STEP_MIN_FREE_MEMORY_MB,
      900,
      "LARGE_STEP_MIN_FREE_MEMORY_MB"
    ),
    largeStepMaxSwapGrowthMb: positiveInteger(
      process.env.LARGE_STEP_MAX_SWAP_GROWTH_MB,
      512,
      "LARGE_STEP_MAX_SWAP_GROWTH_MB"
    ),
    largeStepEmergencyMemoryFraction: positiveFloat(
      process.env.LARGE_STEP_EMERGENCY_MEMORY_FRACTION,
      0.92,
      "LARGE_STEP_EMERGENCY_MEMORY_FRACTION"
    ),
    largeStepScaleUpWarmupSeconds: nonNegativeInteger(
      process.env.LARGE_STEP_SCALE_UP_WARMUP_SECONDS,
      300,
      "LARGE_STEP_SCALE_UP_WARMUP_SECONDS"
    ),
    largeStepScaleUpCooldownSeconds: nonNegativeInteger(
      process.env.LARGE_STEP_SCALE_UP_COOLDOWN_SECONDS,
      120,
      "LARGE_STEP_SCALE_UP_COOLDOWN_SECONDS"
    ),
    largeStepEstimatedChunkMemoryMb: nonNegativeInteger(
      process.env.LARGE_STEP_ESTIMATED_CHUNK_MEMORY_MB,
      2600,
      "LARGE_STEP_ESTIMATED_CHUNK_MEMORY_MB"
    ),
    largeStepScaleUpMinFreeAfterReserveMb: nonNegativeInteger(
      process.env.LARGE_STEP_SCALE_UP_MIN_FREE_AFTER_RESERVE_MB,
      900,
      "LARGE_STEP_SCALE_UP_MIN_FREE_AFTER_RESERVE_MB"
    ),
    largeStepMemoryBasedMaxCapEnabled: parseBoolean(
      process.env.LARGE_STEP_MEMORY_BASED_MAX_CAP_ENABLED,
      true
    ),
    largeStepChunkFallbackMode: largeStepChunkFallbackMode as "fail" | "full-conversion"
  };
}

function nonNegativeInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function positiveFloat(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`${name} must be a positive float.`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return value.toLowerCase() === "true";
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
