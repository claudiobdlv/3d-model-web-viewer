import fs from "node:fs";
import path from "node:path";
import { getModelDir, getLogDir, getWorkerOutputDir } from "../storage.js";

export interface LargeStepChunkingSummary {
  mode?: string;
  status?: string;
  label?: string;
  detailLabel?: string;
  skipReason?: string;
  targetChunks?: number;
  actualChunks?: number;
  maxActiveChunks?: number;
  plannerDurationSeconds?: number;
  totalWallClockSeconds?: number;
  rawGlbBytes?: number;
  finalGlbBytes?: number;
  meshoptReductionPercent?: number;
  peakMemoryFraction?: number;
  swapGrowthBytes?: number;
  decisionReasons?: string[];
  chunks?: Array<{
    index?: number;
    durationSeconds?: number;
    triangles?: number;
    glbBytes?: number;
  }>;
}

function readLogTail(filePath: string, maxBytes = 8192): string {
  try {
    const fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    if (size === 0) {
      fs.closeSync(fd);
      return "";
    }
    const bytesToRead = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    const position = size - bytesToRead;
    fs.readSync(fd, buffer, 0, bytesToRead, position);
    fs.closeSync(fd);
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

export function getLargeStepChunkingSummary(slug: string, readLog = false): LargeStepChunkingSummary | undefined {
  const modelDir = getModelDir(slug);
  const manifestPath = path.join(modelDir, "manifest.json");
  const statsPath = path.join(modelDir, "stats.json");

  let manifest: any = null;
  let stats: any = null;

  try {
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    }
  } catch {
    // Ignore malformed JSON or read error
  }

  try {
    if (fs.existsSync(statsPath)) {
      stats = JSON.parse(fs.readFileSync(statsPath, "utf8"));
    }
  } catch {
    // Ignore malformed JSON or read error
  }

  const largeStepChunking = manifest?.largeStepChunking || stats?.largeStepChunking;
  const optimization = manifest?.optimization || stats?.optimization;

  const summary: LargeStepChunkingSummary = {};

  // Extract from largeStepChunking metadata if available
  if (largeStepChunking) {
    summary.mode = largeStepChunking.mode;
    summary.status = largeStepChunking.status;
    summary.skipReason = largeStepChunking.skipReason;
    summary.targetChunks = largeStepChunking.targetChunks;
    summary.actualChunks = largeStepChunking.actualChunks;
    summary.maxActiveChunks = largeStepChunking.adaptiveConcurrency?.maxReached;
    summary.plannerDurationSeconds = largeStepChunking.plannerDurationSeconds;
    summary.totalWallClockSeconds = largeStepChunking.totalWallClockSeconds;
    summary.peakMemoryFraction = largeStepChunking.adaptiveConcurrency?.summary?.peakMemoryUsedFraction;
    summary.swapGrowthBytes = largeStepChunking.adaptiveConcurrency?.summary?.swapGrowthBytes;
    summary.decisionReasons = largeStepChunking.decision?.reasons;

    if (Array.isArray(largeStepChunking.chunks)) {
      summary.chunks = largeStepChunking.chunks.map((c: any) => ({
        index: c.index,
        durationSeconds: typeof c.durationMs === "number" ? Number((c.durationMs / 1000).toFixed(2)) : undefined,
        triangles: c.triangleCount,
        glbBytes: c.glbSizeBytes // or undefined if not available
      }));
    }
  }

  // Extract optimization sizes
  if (optimization) {
    summary.rawGlbBytes = optimization.rawSizeBytes;
    summary.finalGlbBytes = optimization.displaySizeBytes;
    summary.meshoptReductionPercent = optimization.reductionPercent;
  } else if (stats?.outputGlbSizeBytes !== undefined) {
    summary.finalGlbBytes = stats.outputGlbSizeBytes;
    if (stats?.sourceFileSizeBytes !== undefined) {
      summary.rawGlbBytes = stats.sourceFileSizeBytes;
    }
  }

  // Fallback total duration to baseline processing seconds if not present
  if (summary.totalWallClockSeconds === undefined && typeof stats?.processingSeconds === "number") {
    summary.totalWallClockSeconds = stats.processingSeconds;
  }

  // Read log if requested
  let processingProgress: string | undefined = undefined;
  let logFallbackReason: string | undefined = largeStepChunking?.fallbackReason;

  if (readLog) {
    const logFilePath = [
      path.join(getLogDir(slug), "conversion.log"),
      path.join(getWorkerOutputDir(slug), "conversion.log")
    ].find((candidate) => fs.existsSync(candidate));

    if (logFilePath) {
      const logContent = readLogTail(logFilePath);
      if (logContent) {
        // 1. Determine active processing progress from log if not completed yet
        const isComplete = summary.status && ["applied", "skipped", "disabled", "fallback-full-conversion"].includes(summary.status);
        if (!isComplete) {
          if (logContent.includes("[CHUNKING] Merging chunk GLBs...")) {
            processingProgress = "Processing: merging";
          } else {
            const startMatches = [...logContent.matchAll(/\[CHUNKING\] Starting chunk (\d+)/g)];
            if (startMatches.length > 0) {
              const currentIdx = parseInt(startMatches[startMatches.length - 1][1], 10);
              const currentNum = currentIdx + 1;
              const targetMatch = logContent.match(/with target chunks (\d+)/);
              if (targetMatch) {
                const target = parseInt(targetMatch[1], 10);
                processingProgress = `Processing: chunk ${currentNum}/${target}`;
              } else {
                processingProgress = `Processing: chunk ${currentNum}`;
              }
            } else if (logContent.includes("[CHUNKING] Running planner:")) {
              processingProgress = "Processing: planner";
            } else if (logContent.includes("[CHUNKING] Running STEP pre-scan")) {
              processingProgress = "Processing: pre-scan";
            }
          }
        }

        // 2. Fallback plannerDurationSeconds if log has it
        if (summary.plannerDurationSeconds === undefined) {
          const plannerFinMatch = logContent.match(/\[CHUNKING\] Planner finished in ([\d.]+)s/);
          if (plannerFinMatch) {
            summary.plannerDurationSeconds = parseFloat(plannerFinMatch[1]);
          }
        }

        // 3. Fallback chunks duration count if log contains chunk finish lines
        if (summary.actualChunks === undefined) {
          const chunkCompletedMatches = [...logContent.matchAll(/\[CHUNKING\] Completed chunk \d+/g)];
          if (chunkCompletedMatches.length > 0) {
            summary.actualChunks = chunkCompletedMatches.length;
          }
        }

        // 4. Capture memory guard or planner failures from log
        if (logContent.includes("memory guard") || logContent.includes("memory_based_cap")) {
          logFallbackReason = logFallbackReason || "memory guard";
        } else if (logContent.includes("Planner failed") || logContent.includes("planner-failed")) {
          logFallbackReason = logFallbackReason || "planner failed";
        }
      }
    }
  }

  // Build the frontend labels
  const mode = summary.mode;
  const status = summary.status;
  const skipReason = summary.skipReason;
  const decisionReasons = summary.decisionReasons;

  if (processingProgress) {
    summary.label = processingProgress;
  } else if (mode === "auto" && status === "skipped") {
    summary.label = "Auto skipped";
    if (skipReason === "below-auto-min-size") {
      summary.detailLabel = "below 25 MB";
    } else if (skipReason === "prescan-not-complex") {
      summary.detailLabel = "simple model";
    } else if (skipReason === "planner-not-worth-it") {
      summary.detailLabel = "planner skipped chunking";
    } else {
      summary.detailLabel = skipReason;
    }
  } else if (status === "applied") {
    summary.label = mode === "auto" ? "Auto chunked" : "Chunked";
    const chunksCount = summary.actualChunks ?? summary.targetChunks ?? 0;
    const maxActive = summary.maxActiveChunks ? `, max active ${summary.maxActiveChunks}` : "";
    let detail = `${chunksCount} chunk${chunksCount === 1 ? "" : "s"}${maxActive}`;

    // Add memory constraints info
    if (decisionReasons) {
      if (decisionReasons.some((r) => r.includes("memory_based_cap"))) {
        detail += " — memory capped";
      } else if (decisionReasons.some((r) => r.includes("not_enough_free_after_chunk_reserve"))) {
        detail += " — RAM reserve blocked scale-up";
      }
    }
    summary.detailLabel = detail;
  } else if (mode === "disabled") {
    summary.label = "Chunking disabled";
  } else if (status === "disabled") {
    summary.label = "Normal conversion";
  } else if (status === "failed" || status === "fallback-full-conversion") {
    summary.label = "Chunking failed";
    if (logFallbackReason) {
      if (logFallbackReason.includes("memory guard") || logFallbackReason.includes("memory_based_cap")) {
        summary.detailLabel = "memory guard";
      } else if (logFallbackReason.includes("Planner failed") || logFallbackReason.includes("planner failed")) {
        summary.detailLabel = "planner failed";
      } else {
        summary.detailLabel = logFallbackReason;
      }
    }
  }

  // If we have no fields extracted at all, return undefined
  if (Object.keys(summary).length === 0) {
    return undefined;
  }

  return summary;
}
