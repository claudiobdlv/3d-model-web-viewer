import path from "node:path";

export type WorkerConfig = {
  serverUrl: string;
  token: string;
  pollIntervalMs: number;
  outputDir: string;
  placeholderGlb?: string;
  runOnce: boolean;
};

export function loadConfig(argv = process.argv): WorkerConfig {
  const token = process.env.WORKER_API_TOKEN;
  if (!token) {
    throw new Error("WORKER_API_TOKEN is required for the worker.");
  }

  const pollIntervalSeconds = Number(process.env.POLL_INTERVAL_SECONDS || 15);

  return {
    serverUrl: trimTrailingSlash(process.env.SERVER_URL || "http://192.168.1.100:3009"),
    token,
    pollIntervalMs: Math.max(1, pollIntervalSeconds) * 1000,
    outputDir: path.resolve(process.env.WORKER_OUTPUT_DIR || "./worker-output"),
    placeholderGlb: process.env.PLACEHOLDER_GLB
      ? path.resolve(process.env.PLACEHOLDER_GLB)
      : undefined,
    runOnce: process.env.RUN_ONCE === "true" || argv.includes("--once")
  };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
