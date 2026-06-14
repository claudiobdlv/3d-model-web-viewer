import path from "node:path";

export type WorkerConfig = {
  serverUrl: string;
  token: string;
  pollIntervalMs: number;
  outputDir: string;
  converterCli: string;
  quality: string;
  runOnce: boolean;
  keepWorkerOutput: boolean;
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

  return {
    serverUrl: trimTrailingSlash(process.env.SERVER_URL || "http://localhost:3009"),
    token,
    pollIntervalMs: Math.max(1, pollIntervalSeconds) * 1000,
    outputDir: path.resolve(process.env.WORKER_OUTPUT_DIR || "./worker-output"),
    converterCli: path.resolve(process.env.CONVERTER_CLI || "../converter/src/cli.js"),
    quality,
    runOnce: process.env.RUN_ONCE === "true" || argv.includes("--once"),
    keepWorkerOutput: process.env.KEEP_WORKER_OUTPUT !== "false"
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
