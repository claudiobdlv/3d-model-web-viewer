import child_process from "node:child_process";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  nativeDeflections,
  nativeQualityPreset,
  occtJsQualityPreset,
  type ConversionQuality,
  type NativeQualityPreset
} from "./quality.js";

import type { GlbOptimizationMode } from "./glbOptimizer.js";
import { validateMergedGlb } from "./utils/mergeGlbs.js";
import { decideLargeStepChunking } from "./utils/largeStepDecision.js";

type MeshiqAdaptiveMeshMode = "off" | "on";
type MeshiqAdaptiveMeshProfile = "conservative" | "standard" | "strong";

function meshiqAdaptiveMeshMode(): MeshiqAdaptiveMeshMode {
  const value = process.env.MESHIQ_ADAPTIVE_MESH ?? "off";
  if (value !== "off" && value !== "on") {
    throw new Error("MESHIQ_ADAPTIVE_MESH must be off or on.");
  }
  return value;
}

function meshiqAdaptiveMeshProfile(): MeshiqAdaptiveMeshProfile {
  const value = process.env.MESHIQ_ADAPTIVE_MESH_PROFILE ?? "standard";
  if (value !== "conservative" && value !== "standard" && value !== "strong") {
    throw new Error("MESHIQ_ADAPTIVE_MESH_PROFILE must be conservative, standard, or strong.");
  }
  return value;
}

export type ConverterProcessorInput = {
  slug: string;
  sourcePath: string;
  outputDir: string;
  converterBackend: "occt-js" | "xcaf-baseline";
  converterCli: string;
  xcafConverterBin: string;
  xcafColourMode: "xcaf-baseline" | "step-presentation";
  quality: ConversionQuality;
  glbOptimizationMode: GlbOptimizationMode;
  signal?: AbortSignal;
  onProgress?: (percent: number, label: string) => void | Promise<void>;
  largeStepChunkingMode?: "disabled" | "auto" | "direct-filter";
  largeStepChunkConcurrencyMode?: "fixed" | "adaptive";
  largeStepFileSizeThresholdMb?: number; // legacy fallback
  largeStepAutoMinFileSizeMb?: number;
  largeStepAutoPlannerFileSizeMb?: number;
  largeStepAutoPrescanEnabled?: boolean;
  largeStepForcePlanner?: boolean;
  largeStepLeafCountThreshold?: number;
  largeStepFaceCountThreshold?: number;
  largeStepWorkScoreThreshold?: number;
  largeStepMinExpectedSpeedupFraction?: number;
  largeStepTargetChunks?: number;
  largeStepAutoMaxTargetChunks?: number;
  largeStepMinConcurrentChunks?: number;
  largeStepInitialConcurrentChunks?: number;
  largeStepMaxConcurrentChunks?: number;
  largeStepResourcePollSeconds?: number;
  largeStepMaxWorkerMemoryFraction?: number;
  largeStepMinFreeMemoryMb?: number;
  largeStepMaxSwapGrowthMb?: number;
  largeStepEmergencyMemoryFraction?: number;
  largeStepScaleUpWarmupSeconds?: number;
  largeStepScaleUpCooldownSeconds?: number;
  largeStepEstimatedChunkMemoryMb?: number;
  largeStepScaleUpMinFreeAfterReserveMb?: number;
  largeStepMemoryBasedMaxCapEnabled?: boolean;
  largeStepChunkFallbackMode?: "fail" | "full-conversion";
};

export type ConverterProcessorOutput = {
  displayGlbPath: string;
  manifestPath: string;
  statsPath: string;
  materialDebugPath: string;
  conversionLogPath: string;
  xcafReportPath?: string;
  meshReportPath?: string;
};

export async function convertStepJob(input: ConverterProcessorInput): Promise<ConverterProcessorOutput> {
  const jobStartTime = Date.now();
  const jobDir = path.join(input.outputDir, input.slug);
  fs.mkdirSync(jobDir, { recursive: true });

  const largeStepChunkingMode = input.largeStepChunkingMode ?? "disabled";
  const largeStepChunkConcurrencyMode = input.largeStepChunkConcurrencyMode ?? "adaptive";
  const largeStepAutoMinFileSizeMb = input.largeStepAutoMinFileSizeMb ?? input.largeStepFileSizeThresholdMb ?? 25;
  const largeStepAutoPlannerFileSizeMb = input.largeStepAutoPlannerFileSizeMb ?? 80;
  const largeStepAutoPrescanEnabled = input.largeStepAutoPrescanEnabled ?? true;
  const largeStepForcePlanner = input.largeStepForcePlanner ?? false;
  const largeStepLeafCountThreshold = input.largeStepLeafCountThreshold ?? 2000;
  const largeStepFaceCountThreshold = input.largeStepFaceCountThreshold ?? 50000;
  const largeStepWorkScoreThreshold = input.largeStepWorkScoreThreshold ?? 35000;
  const largeStepMinExpectedSpeedupFraction = input.largeStepMinExpectedSpeedupFraction ?? 0.15;
  const largeStepTargetChunks = input.largeStepTargetChunks ?? 3;
  const largeStepAutoMaxTargetChunks = input.largeStepAutoMaxTargetChunks ?? 6;
  const largeStepMinConcurrentChunks = input.largeStepMinConcurrentChunks ?? 1;
  const largeStepInitialConcurrentChunks = input.largeStepInitialConcurrentChunks ?? 2;
  const largeStepMaxConcurrentChunks = input.largeStepMaxConcurrentChunks ?? 3;
  const largeStepResourcePollSeconds = input.largeStepResourcePollSeconds ?? 10;
  const largeStepMaxWorkerMemoryFraction = input.largeStepMaxWorkerMemoryFraction ?? 0.75;
  const largeStepMinFreeMemoryMb = input.largeStepMinFreeMemoryMb ?? 900;
  const largeStepMaxSwapGrowthMb = input.largeStepMaxSwapGrowthMb ?? 512;
  const largeStepEmergencyMemoryFraction = input.largeStepEmergencyMemoryFraction ?? 0.92;
  const largeStepScaleUpWarmupSeconds = input.largeStepScaleUpWarmupSeconds ?? 300;
  const largeStepScaleUpCooldownSeconds = input.largeStepScaleUpCooldownSeconds ?? 120;
  const largeStepEstimatedChunkMemoryMb = input.largeStepEstimatedChunkMemoryMb ?? 2600;
  const largeStepScaleUpMinFreeAfterReserveMb = input.largeStepScaleUpMinFreeAfterReserveMb ?? 900;
  const largeStepMemoryBasedMaxCapEnabled = input.largeStepMemoryBasedMaxCapEnabled ?? true;
  const largeStepChunkFallbackMode = input.largeStepChunkFallbackMode ?? "fail";

  const conversionLogPath = path.join(jobDir, "conversion.log");

  const chunkingStats: any = {
    mode: largeStepChunkingMode,
    status: "disabled"
  };

  let useChunking = false;
  const sourceStat = await fs.promises.stat(input.sourcePath);
  const fileSizeBytes = sourceStat.size;

  const decisionConfig = {
    largeStepChunkingMode,
    largeStepAutoMinFileSizeMb,
    largeStepAutoPlannerFileSizeMb,
    largeStepAutoPrescanEnabled,
    largeStepForcePlanner,
    largeStepLeafCountThreshold,
    largeStepFaceCountThreshold,
    largeStepWorkScoreThreshold
  };

  const decisionInput = {
    filePath: input.sourcePath,
    fileSizeBytes,
    converterBackend: input.converterBackend
  };

  // 1. Initial decision
  let decision = decideLargeStepChunking(decisionInput, decisionConfig);

  // 2. Pre-scan if requested
  let preScanResult: any = null;
  if (decision.shouldRunPreScan) {
    await appendLog(conversionLogPath, `[CHUNKING] Running STEP pre-scan for medium file...\n`);
    const { preScanStepFile } = await import("./utils/stepPreScan.js");
    preScanResult = await preScanStepFile(input.sourcePath);
    await appendLog(
      conversionLogPath,
      `[CHUNKING] Pre-scan finished. probablyComplex=${preScanResult.probablyComplex}, advancedFaceCount=${preScanResult.advancedFaceCount}, manifoldSolidBrepCount=${preScanResult.manifoldSolidBrepCount}, productCount=${preScanResult.productCount}, relationshipCount=${preScanResult.relationshipCount}\n`
    );
    // Call decision again with pre-scan result
    decision = decideLargeStepChunking(decisionInput, decisionConfig, preScanResult);
  }

  // 3. Planner if requested
  let plannerPlan: any = null;
  if (decision.shouldRunPlanner) {
    const plannerBin = path.join(path.dirname(input.xcafConverterBin), "xcaf-step-planner");
    await input.onProgress?.(12, "Planning large model");
    await appendLog(conversionLogPath, `[CHUNKING] Running planner: ${plannerBin} with target chunks ${largeStepTargetChunks}\n`);

    const plannerStartTime = Date.now();
    let plannerResult: { stdout: string; code: number } | null = null;
    try {
      plannerResult = await runPlanner({
        plannerBin,
        sourcePath: input.sourcePath,
        outputDir: jobDir,
        targetChunks: largeStepTargetChunks,
        signal: input.signal
      });
      const plannerDurationMs = Date.now() - plannerStartTime;
      chunkingStats.plannerDurationSeconds = Number((plannerDurationMs / 1000).toFixed(2));
      await appendLog(conversionLogPath, `[CHUNKING] Planner finished in ${chunkingStats.plannerDurationSeconds}s\n`);
    } catch (err: any) {
      if (input.signal?.aborted) throw err;
      await appendLog(conversionLogPath, `[CHUNKING] Planner failed with error: ${err.message || err}\n`);
      if (largeStepChunkFallbackMode === "full-conversion") {
        await appendLog(conversionLogPath, `[CHUNKING] Fallback: running full conversion.\n`);
        chunkingStats.status = "fallback-full-conversion";
        chunkingStats.fallbackReason = `Planner failed: ${err.message || err}`;
        useChunking = false;
      } else {
        throw new Error(`Planner failed: ${err.message || err}`);
      }
    }

    if (useChunking === false && plannerResult) {
      if (plannerResult.code !== 0) {
        await appendLog(conversionLogPath, `[CHUNKING] Planner exited with non-zero code ${plannerResult.code}\n`);
        if (largeStepChunkFallbackMode === "full-conversion") {
          await appendLog(conversionLogPath, `[CHUNKING] Fallback: running full conversion.\n`);
          chunkingStats.status = "fallback-full-conversion";
          chunkingStats.fallbackReason = `Planner exited with code ${plannerResult.code}`;
          useChunking = false;
        } else {
          throw new Error(`Planner exited with code ${plannerResult.code}`);
        }
      } else {
        await appendLog(conversionLogPath, `\n=== Planner stdout ===\n${plannerResult.stdout}\n======================\n`);
        const planPath = path.join(jobDir, "large-model-plan.json");
        try {
          plannerPlan = JSON.parse(await fs.promises.readFile(planPath, "utf8"));
        } catch (err: any) {
          await appendLog(conversionLogPath, `[CHUNKING] Failed to read or parse large-model-plan.json: ${err.message}\n`);
          if (largeStepChunkFallbackMode === "full-conversion") {
            await appendLog(conversionLogPath, `[CHUNKING] Fallback: running full conversion.\n`);
            chunkingStats.status = "fallback-full-conversion";
            chunkingStats.fallbackReason = `Failed to parse plan JSON: ${err.message}`;
            useChunking = false;
          } else {
            throw new Error(`Failed to parse plan JSON: ${err.message}`);
          }
        }

        if (plannerPlan) {
          const leafCount = plannerPlan.model_summary?.total_leaf_shape_count ?? 0;
          const faceCount = plannerPlan.model_summary?.total_face_count ?? 0;
          const workScore = plannerPlan.model_summary?.naive_complexity_score ?? 0;
          const recommended = plannerPlan.chunking_recommendation?.chunking_enabled === true;

          const plannerSummary = {
            leafCount,
            faceCount,
            workScore,
            recommended
          };

          decision = decideLargeStepChunking(decisionInput, decisionConfig, preScanResult, plannerSummary);
          useChunking = decision.shouldChunk;
        }
      }
    }
  }

  // Populate chunkingStats
  chunkingStats.mode = largeStepChunkingMode;
  if (chunkingStats.status !== "fallback-full-conversion") {
    if (useChunking) {
      chunkingStats.status = "applied";
    } else if (largeStepChunkingMode === "disabled") {
      chunkingStats.status = "disabled";
    } else if (decision.skipReason) {
      chunkingStats.status = "skipped";
      chunkingStats.skipReason = decision.skipReason;
    } else {
      chunkingStats.status = "disabled";
    }
  }

  chunkingStats.decision = {
    fileSizeBytes,
    prescan: preScanResult ? {
      probablyComplex: preScanResult.probablyComplex,
      advancedFaceCount: preScanResult.advancedFaceCount,
      manifoldSolidBrepCount: preScanResult.manifoldSolidBrepCount,
      productCount: preScanResult.productCount,
      relationshipCount: preScanResult.relationshipCount,
      reasons: preScanResult.reasons
    } : null,
    plannerRecommended: plannerPlan?.chunking_recommendation?.chunking_enabled ?? null,
    leafCount: plannerPlan?.model_summary?.total_leaf_shape_count ?? null,
    faceCount: plannerPlan?.model_summary?.total_face_count ?? null,
    workScore: plannerPlan?.model_summary?.naive_complexity_score ?? null,
    reasons: decision.reasons
  };

  if (useChunking && plannerPlan) {
    chunkingStats.planner = {
      leafCount: plannerPlan.model_summary?.total_leaf_shape_count ?? 0,
      faceCount: plannerPlan.model_summary?.total_face_count ?? 0,
      recommended: plannerPlan.chunking_recommendation?.chunking_enabled === true
    };
    chunkingStats.targetChunks = plannerPlan.chunking_recommendation?.target_chunks ?? largeStepTargetChunks;
    chunkingStats.actualChunks = plannerPlan.chunks?.length ?? 0;
  }

  if (!useChunking && decision.skipReason) {
    await appendLog(conversionLogPath, `[CHUNKING] Skipped chunking. Reason: ${decision.skipReason}. Details: ${decision.reasons.join("; ")}\n`);
  }

  if (useChunking) {
    const planPath = path.join(jobDir, "large-model-plan.json");
    const plan = JSON.parse(await fs.promises.readFile(planPath, "utf8"));
    const chunks = plan.chunks || [];
    if (chunks.length === 0) {
      throw new Error("Planner returned no chunks to convert.");
    }

    const labelListPaths: string[] = [];
    for (const chunk of chunks) {
      const idx = chunk.chunk_index;
      const labelListPath = path.join(jobDir, `chunk-${idx}-label-list.txt`);
      const paths = chunk.root_label_paths || [];
      if (paths.length === 0) {
        throw new Error(`Chunk ${idx} has an empty label list.`);
      }
      await fs.promises.writeFile(labelListPath, paths.join("\n") + "\n");
      labelListPaths.push(labelListPath);
      await appendLog(
        conversionLogPath,
        `[CHUNKING] Chunk ${idx} ("${chunk.name}"): labels=${paths.length}, leaves=${chunk.leafCount}, faces=${chunk.faceCount}, naive_score=${chunk.naive_work_score}\n`
      );
    }

    const activeSubprocesses = new Set<any>();

    const abortListener = () => {
      for (const proc of activeSubprocesses) {
        try {
          proc.kill("SIGTERM");
          const timeout = setTimeout(() => {
            if (proc.exitCode === null && proc.signalCode === null) {
              proc.kill("SIGKILL");
            }
          }, 2000);
          timeout.unref();
        } catch (e) {
          console.error("Error aborting chunk subprocess:", e);
        }
      }
    };
    if (input.signal) {
      input.signal.addEventListener("abort", abortListener);
    }

    const chunkStatsOutputs: any[] = [];
    const chunkReportPaths: string[] = [];
    const chunkGlbPaths: string[] = [];
    const runningChunks = new Set<number>();
    const completedChunks = new Set<number>();

    const updateProgress = async () => {
      const total = chunks.length;
      const runningStr = Array.from(runningChunks).map(idx => `${idx + 1}/${total}`).join(", ");
      const label = runningStr ? `Running chunks ${runningStr}` : `Completed all chunks`;
      const percent = Math.min(65, Math.floor(20 + (completedChunks.size / total) * 45));
      await input.onProgress?.(percent, label);
    };

    const runChunk = async (chunk: any) => {
      const idx = chunk.chunk_index;
      const chunkOutputDir = path.join(jobDir, `chunk-${idx}`);
      await fs.promises.mkdir(chunkOutputDir, { recursive: true });

      const nativeQuality = nativeQualityPreset(input.quality);
      const labelListPath = labelListPaths[idx];
      const args = [
        input.sourcePath,
        chunkOutputDir,
        nativeQuality,
        "--colour-mode",
        input.xcafColourMode,
        "--colour-space",
        "raw",
        "--label-list",
        labelListPath
      ];

      const parallelMesh = process.env.XCAF_PARALLEL_MESH === "off" ? "off" : "on";
      args.push("--parallel-mesh", parallelMesh);
      const adaptiveMesh = meshiqAdaptiveMeshMode();
      const adaptiveProfile = meshiqAdaptiveMeshProfile();
      if (adaptiveMesh === "on") {
        args.push("--adaptive-mesh", "on");
        args.push("--adaptive-mesh-profile", adaptiveProfile);
      }
      if (process.env.DEBUG_SUPER_COARSE_MESH === "true") args.push("--debug-super-coarse-mesh");
      if (process.env.DEBUG_SKIP_RAW_STEP_STYLES === "true") args.push("--debug-skip-raw-step-styles");
      if (process.env.DEBUG_DISABLE_STYLE_CACHE === "true") args.push("--debug-disable-style-cache");
      if (process.env.DEBUG_LEGACY_TRANSFORM === "true") args.push("--debug-legacy-transform");

      const meshReuseKillSwitch = process.env.DEBUG_DISABLE_MESH_REUSE === "true";
      if (meshReuseKillSwitch) {
        args.push("--debug-disable-mesh-reuse");
      } else {
        args.push("--enable-mesh-reuse");
      }

      await appendLog(conversionLogPath, `[CHUNKING] Starting chunk ${idx}: ${input.xcafConverterBin} ${args.join(" ")}\n`);
      const startTime = Date.now();

      runningChunks.add(idx);
      await updateProgress();

      await new Promise<void>((resolve, reject) => {
        const child = child_process.spawn(input.xcafConverterBin, args, {
          stdio: ["ignore", "inherit", "inherit"]
        });
        activeSubprocesses.add(child);

        child.on("error", (err) => {
          activeSubprocesses.delete(child);
          reject(err);
        });

        child.on("exit", (code) => {
          activeSubprocesses.delete(child);
          if (input.signal?.aborted) {
            return reject(new DOMException("Conversion cancelled.", "AbortError"));
          }
          if (code === 0) resolve();
          else reject(new Error(`Chunk ${idx} exited with code ${code}`));
        });
      });

      const durationMs = Date.now() - startTime;
      runningChunks.delete(idx);
      completedChunks.add(idx);
      await updateProgress();

      await appendLog(conversionLogPath, `[CHUNKING] Completed chunk ${idx} in ${(durationMs / 1000).toFixed(2)}s\n`);

      const chunkReportPath = path.join(chunkOutputDir, "xcaf-report.json");
      const chunkGlbPath = path.join(chunkOutputDir, "display.glb");
      await assertFile(chunkGlbPath, `Chunk ${idx} did not produce display.glb`);
      await assertFile(chunkReportPath, `Chunk ${idx} did not produce xcaf-report.json`);

      chunkReportPaths.push(chunkReportPath);
      chunkGlbPaths.push(chunkGlbPath);

      const report = JSON.parse(await fs.promises.readFile(chunkReportPath, "utf8"));
      chunkStatsOutputs.push({
        index: idx,
        status: "success",
        labelCount: chunk.root_label_paths.length,
        nodeCount: report.summary?.nodeCount ?? 0,
        triangleCount: report.summary?.triangles ?? 0,
        durationMs
      });
    };

    // Adaptive Concurrency Scheduler logic
    const adaptiveMode = largeStepChunkConcurrencyMode === "adaptive";
    const { getResourceSnapshot, readCgroupBytes } = await import("./utils/resourceMonitor.js");

    // Memory-based auto-cap logic
    let memoryBasedCap = largeStepMaxConcurrentChunks;
    if (largeStepMemoryBasedMaxCapEnabled) {
      const cgroupMemMax = readCgroupBytes("/sys/fs/cgroup/memory.max");
      const hostMemory = cgroupMemMax !== null ? cgroupMemMax : os.totalmem();
      if (hostMemory < 6 * 1024 * 1024 * 1024) {
        memoryBasedCap = 1;
      } else if (hostMemory < 10 * 1024 * 1024 * 1024) {
        memoryBasedCap = 2;
      }
    }

    const effectiveMaxConcurrentChunks = Math.min(largeStepMaxConcurrentChunks, memoryBasedCap);
    const maxConcurrency = Math.min(effectiveMaxConcurrentChunks, chunks.length);
    const initialConcurrency = Math.min(largeStepInitialConcurrentChunks, chunks.length, effectiveMaxConcurrentChunks);
    const pollIntervalMs = largeStepResourcePollSeconds * 1000;

    const resourceMonitorConfig = {
      largeStepMaxWorkerMemoryFraction,
      largeStepMinFreeMemoryMb,
      largeStepMaxSwapGrowthMb,
      largeStepEmergencyMemoryFraction
    };

    const initialSwapBytes = readCgroupBytes("/sys/fs/cgroup/memory.swap.current") || 0;

    const snapshots: any[] = [];
    const decisions: any[] = [];
    let peakMemoryUsedFraction = 0;
    let peakSwapBytes = 0;
    let peakSwapGrowthBytes = 0;
    let maxConcurrencyReached = 0;

    const queue = [...chunks];
    const activePromises = new Set<Promise<void>>();
    const chunkErrors: any[] = [];

    const recordSnapshot = () => {
      const snap = getResourceSnapshot(resourceMonitorConfig, initialSwapBytes);
      snapshots.push(snap);

      if (snap.memoryUsedFraction !== undefined && snap.memoryUsedFraction > peakMemoryUsedFraction) {
        peakMemoryUsedFraction = snap.memoryUsedFraction;
      }
      if (snap.swapCurrentBytes !== undefined && snap.swapCurrentBytes > peakSwapBytes) {
        peakSwapBytes = snap.swapCurrentBytes;
      }
      if (snap.swapDeltaBytes !== undefined && snap.swapDeltaBytes > peakSwapGrowthBytes) {
        peakSwapGrowthBytes = snap.swapDeltaBytes;
      }

      return snap;
    };

    try {
      const schedulerStartTime = Date.now();
      let lastPollTime = 0;
      let launchedCount = 0;
      let initialBatchLaunchedAt: number | null = null;
      let lastScaleUpTime: number | null = null;

      let lastLoggedRejectReason: string | null = null;
      let lastLoggedActiveCount: number | null = null;

      while (queue.length > 0 || activePromises.size > 0) {
        if (input.signal?.aborted) {
          throw new DOMException("Conversion cancelled.", "AbortError");
        }
        if (chunkErrors.length > 0) {
          abortListener();
          throw chunkErrors[0];
        }

        const nowMs = Date.now();
        let currentSnapshot = snapshots[snapshots.length - 1];
        if (nowMs - lastPollTime >= pollIntervalMs || !currentSnapshot) {
          currentSnapshot = recordSnapshot();
          lastPollTime = nowMs;

          await appendLog(
            conversionLogPath,
            `[RESOURCE_MONITOR] UsedMemFraction=${currentSnapshot.memoryUsedFraction?.toFixed(4) ?? "N/A"}, FreeMemMb=${((currentSnapshot.memoryFreeBytes ?? 0) / (1024 * 1024)).toFixed(1)}, SwapDeltaMb=${((currentSnapshot.swapDeltaBytes ?? 0) / (1024 * 1024)).toFixed(1)}, SafeToLaunch=${currentSnapshot.safeToLaunchMore}, EmergencyPressure=${currentSnapshot.emergencyPressure}\n`
          );

          if (currentSnapshot.emergencyPressure) {
            await appendLog(conversionLogPath, `[RESOURCE_MONITOR] EMERGENCY pressure triggered! Aborting chunks.\n`);
            abortListener();
            throw new Error(`Aborted due to emergency memory pressure: ${currentSnapshot.reasons.join("; ")}`);
          }
        }

        const activeCount = activePromises.size;
        if (activeCount > maxConcurrencyReached) {
          maxConcurrencyReached = activeCount;
        }

        if (queue.length > 0) {
          let shouldLaunch = false;
          let rejectReason: string | null = null;

          if (activeCount >= maxConcurrency) {
            if (activeCount >= effectiveMaxConcurrentChunks) {
              if (effectiveMaxConcurrentChunks < largeStepMaxConcurrentChunks) {
                rejectReason = "memory_based_cap";
              } else {
                rejectReason = "max_concurrency_reached";
              }
            } else {
              rejectReason = "max_concurrency_reached";
            }
          } else if (activeCount < initialConcurrency) {
            // Hard initial concurrency cap is respected
            shouldLaunch = true;
          } else if (!adaptiveMode) {
            shouldLaunch = true;
          } else {
            // Adaptive Mode scale-up checks
            if (activeCount >= effectiveMaxConcurrentChunks) {
              rejectReason = "memory_based_cap";
            } else if (initialBatchLaunchedAt === null || (Date.now() - initialBatchLaunchedAt) < largeStepScaleUpWarmupSeconds * 1000) {
              rejectReason = "warmup_not_elapsed";
            } else if (lastScaleUpTime !== null && (Date.now() - lastScaleUpTime) < largeStepScaleUpCooldownSeconds * 1000) {
              rejectReason = "cooldown_not_elapsed";
            } else if (currentSnapshot.emergencyPressure) {
              rejectReason = "emergency_pressure";
            } else if (currentSnapshot.swapDeltaBytes !== undefined && currentSnapshot.swapDeltaBytes >= largeStepMaxSwapGrowthMb * 1024 * 1024) {
              rejectReason = "swap_growth_too_high";
            } else if (currentSnapshot.memoryUsedFraction !== undefined && currentSnapshot.memoryUsedFraction >= largeStepMaxWorkerMemoryFraction) {
              rejectReason = "memory_fraction_too_high";
            } else if (!currentSnapshot.safeToLaunchMore) {
              rejectReason = "not_enough_free_after_chunk_reserve";
            } else {
              // Custom reserve headroom check
              const currentFreeMemoryMB = (currentSnapshot.memoryFreeBytes ?? 0) / (1024 * 1024);
              if (currentFreeMemoryMB - largeStepEstimatedChunkMemoryMb < largeStepScaleUpMinFreeAfterReserveMb) {
                rejectReason = "not_enough_free_after_chunk_reserve";
              } else {
                shouldLaunch = true;
              }
            }
          }

          const stateChanged = shouldLaunch || (rejectReason !== lastLoggedRejectReason || activeCount !== lastLoggedActiveCount);

          if (stateChanged) {
            const elapsedSeconds = Math.round((Date.now() - schedulerStartTime) / 1000);
            const memoryFreeMb = currentSnapshot?.memoryFreeBytes !== undefined ? Math.round(currentSnapshot.memoryFreeBytes / (1024 * 1024)) : undefined;
            const swapGrowthMb = currentSnapshot?.swapDeltaBytes !== undefined ? Math.round(currentSnapshot.swapDeltaBytes / (1024 * 1024)) : undefined;

            const decision = {
              elapsedSeconds,
              activeChunks: activeCount,
              queuedChunks: queue.length,
              safeToLaunchMore: shouldLaunch,
              reasons: shouldLaunch ? ["resource_headroom_safe"] : [rejectReason || "unknown"],
              memoryUsedFraction: currentSnapshot?.memoryUsedFraction,
              memoryFreeMb,
              swapGrowthMb
            };

            decisions.push(decision);

            lastLoggedRejectReason = rejectReason;
            lastLoggedActiveCount = activeCount;

            if (shouldLaunch) {
              if (launchedCount < initialConcurrency) {
                await appendLog(conversionLogPath, `[SCHEDULER] Launching initial chunk. ActiveCount=${activeCount}, QueuedCount=${queue.length}\n`);
              } else {
                const elapsed = ((Date.now() - (initialBatchLaunchedAt ?? nowMs)) / 1000).toFixed(1);
                const freeMb = ((currentSnapshot?.memoryFreeBytes ?? 0) / (1024 * 1024)).toFixed(1);
                const swapDeltaMb = ((currentSnapshot?.swapDeltaBytes ?? 0) / (1024 * 1024)).toFixed(1);
                await appendLog(
                  conversionLogPath,
                  `[SCHEDULER] Launching extra chunk. ElapsedSinceInitial=${elapsed}s, ActiveBefore=${activeCount}, FreeMem=${freeMb}MB, ReserveMem=${largeStepEstimatedChunkMemoryMb}MB, MemFraction=${currentSnapshot?.memoryUsedFraction?.toFixed(4) ?? "N/A"}, SwapGrowth=${swapDeltaMb}MB, Reason=resource_headroom_safe\n`
                );
              }
            } else {
              await appendLog(
                conversionLogPath,
                `[SCHEDULER] Scale-up blocked. ActiveCount=${activeCount}, QueuedCount=${queue.length}, Reason=${rejectReason}\n`
              );
            }
          }

          if (shouldLaunch) {
            const nextChunk = queue.shift()!;
            launchedCount++;

            if (launchedCount === initialConcurrency || queue.length === 0) {
              if (initialBatchLaunchedAt === null) {
                initialBatchLaunchedAt = Date.now();
              }
            }
            if (launchedCount > initialConcurrency) {
              lastScaleUpTime = Date.now();
            }

            const chunkPromise = runChunk(nextChunk)
              .then(() => {
                activePromises.delete(chunkPromise);
              })
              .catch((err) => {
                activePromises.delete(chunkPromise);
                chunkErrors.push(err);
              });

            activePromises.add(chunkPromise);
            if (activePromises.size > maxConcurrencyReached) {
              maxConcurrencyReached = activePromises.size;
            }
            continue;
          }
        }

        if (activePromises.size > 0) {
          await Promise.race([
            new Promise((resolve) => setTimeout(resolve, 1000)),
            Promise.any(activePromises)
          ]).catch(() => {
            // chunkPromise catch block handles removing itself, errors are propagated below
          });
        } else {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      if (chunkErrors.length > 0) {
        throw chunkErrors[0];
      }

      // Propagate errors from chunk promises if any failed
      await Promise.all(activePromises);

      if (input.signal) {
        input.signal.removeEventListener("abort", abortListener);
      }

      chunkingStats.adaptiveConcurrency = {
        enabled: adaptiveMode,
        initial: initialConcurrency,
        maxConfigured: largeStepMaxConcurrentChunks,
        maxReached: maxConcurrencyReached,
        pollSeconds: largeStepResourcePollSeconds,
        snapshots,
        decisions,
        summary: {
          peakMemoryUsedFraction,
          peakSwapBytes,
          swapGrowthBytes: peakSwapGrowthBytes
        }
      };
    } catch (chunkErr: any) {
      if (input.signal) {
        input.signal.removeEventListener("abort", abortListener);
      }
      for (const proc of activeSubprocesses) {
        try { proc.kill("SIGKILL"); } catch (e) {}
      }
      await appendLog(conversionLogPath, `[CHUNKING] Chunk conversion failed: ${chunkErr.message || chunkErr}\n`);
      await cleanUpChunks(chunks, jobDir);

      if (input.signal?.aborted || (chunkErr instanceof Error && chunkErr.name === "AbortError")) {
        throw chunkErr;
      }

      if (largeStepChunkFallbackMode === "full-conversion") {
        await appendLog(conversionLogPath, `[CHUNKING] Fallback: running full conversion.\n`);
        chunkingStats.status = "fallback-full-conversion";
        chunkingStats.fallbackReason = `Chunk conversion failed: ${chunkErr.message || chunkErr}`;
        useChunking = false;
      } else {
        throw chunkErr;
      }
    }

    if (useChunking) {
      await input.onProgress?.(68, "Merging chunks");
      await appendLog(conversionLogPath, `[CHUNKING] Merging chunk GLBs...\n`);
      const mergeStartTime = Date.now();
      const rawGlbPath = path.join(jobDir, "display.raw.glb");

      let mergeStats: any;
      try {
        const { mergeGlbs } = await import("./utils/mergeGlbs.js");
        const sortedChunkGlbPaths = chunks.map((c: any) => path.join(jobDir, `chunk-${c.chunk_index}`, "display.glb"));
        mergeStats = await mergeGlbs(sortedChunkGlbPaths, rawGlbPath);
      } catch (err: any) {
        await appendLog(conversionLogPath, `[CHUNKING] Merge failed: ${err.message}\n`);
        await cleanUpChunks(chunks, jobDir);
        if (largeStepChunkFallbackMode === "full-conversion") {
          await appendLog(conversionLogPath, `[CHUNKING] Fallback: running full conversion.\n`);
          chunkingStats.status = "fallback-full-conversion";
          chunkingStats.fallbackReason = `Merge failed: ${err.message}`;
          useChunking = false;
        } else {
          throw err;
        }
      }

      if (useChunking) {
        const mergeDurationMs = Date.now() - mergeStartTime;
        await appendLog(conversionLogPath, `[CHUNKING] Merged chunk GLBs in ${(mergeDurationMs / 1000).toFixed(2)}s\n`);

        await input.onProgress?.(69, "Validating merged GLB");
        const sortedChunkGlbPaths = chunks.map((c: any) => path.join(jobDir, `chunk-${c.chunk_index}`, "display.glb"));
        const validation = await validateMergedGlb(sortedChunkGlbPaths, rawGlbPath);
        if (!validation.passed) {
          const errMsg = `Merged GLB validation failed: ${validation.errors.join("; ")}`;
          await appendLog(conversionLogPath, `[CHUNKING] ${errMsg}\n`);
          await cleanUpChunks(chunks, jobDir);
          if (largeStepChunkFallbackMode === "full-conversion") {
            await appendLog(conversionLogPath, `[CHUNKING] Fallback: running full conversion.\n`);
            chunkingStats.status = "fallback-full-conversion";
            chunkingStats.fallbackReason = errMsg;
            useChunking = false;
          } else {
            throw new Error(errMsg);
          }
        } else {
          await appendLog(conversionLogPath, `[CHUNKING] Merged GLB validation passed.\n`);
          chunkingStats.merge = {
            status: "success",
            durationMs: mergeDurationMs
          };
          chunkingStats.chunks = chunkStatsOutputs.sort((a, b) => a.index - b.index);
          chunkingStats.status = "applied";
        }
      }

      if (useChunking) {
        const aggregatedReportPath = path.join(jobDir, "xcaf-report.json");
        const sortedChunkReportPaths = chunks.map((c: any) => path.join(jobDir, `chunk-${c.chunk_index}`, "xcaf-report.json"));
        const rawGlbPath = path.join(jobDir, "display.raw.glb");
        await aggregateReports(sortedChunkReportPaths, aggregatedReportPath, rawGlbPath);
        const aggregatedMeshReportPath = path.join(jobDir, "mesh-report.json");
        const sortedChunkMeshReportPaths: string[] = [];
        for (const chunk of chunks) {
          const candidate = path.join(jobDir, `chunk-${chunk.chunk_index}`, "mesh-report.json");
          if (await fileExists(candidate)) {
            sortedChunkMeshReportPaths.push(candidate);
          }
        }
        let meshReportPath: string | undefined;
        if (sortedChunkMeshReportPaths.length > 0) {
          await preserveChunkMeshReports(sortedChunkMeshReportPaths, jobDir);
          await aggregateMeshReports(sortedChunkMeshReportPaths, aggregatedMeshReportPath);
          meshReportPath = aggregatedMeshReportPath;
        }

        const displayGlbPath = path.join(jobDir, "display.glb");
        const statsPath = path.join(jobDir, "stats.json");
        const materialDebugPath = path.join(jobDir, "material-debug.json");

        let nativeQualityDetails = await writeXcafCompatibilityFiles({
          reportPath: aggregatedReportPath,
          statsPath,
          materialDebugPath,
          sourcePath: input.sourcePath,
          displayGlbPath: rawGlbPath,
          quality: input.quality
        });

        let optimizationResult: any = null;
        if (input.glbOptimizationMode === "meshopt") {
          throwIfAborted(input.signal);
          await input.onProgress?.(85, "Optimizing GLB");
          try {
            const { optimizeDisplayGlb } = await import("./glbOptimizer.js");
            optimizationResult = await optimizeDisplayGlb({
              requestedMode: "meshopt",
              rawGlbPath,
              displayGlbPath,
              conversionLogPath
            });
          } catch (optError) {
            console.error("GLB optimizer threw exception:", optError);
            await fs.promises.copyFile(rawGlbPath, displayGlbPath);
            const rawSize = (await fs.promises.stat(rawGlbPath)).size;
            optimizationResult = {
              requestedMode: "meshopt",
              status: "failed",
              tool: "@gltf-transform direct APIs + meshoptimizer",
              toolVersion: "4.4.0 / 1.0.1",
              quantization: { position: 16, normal: 12, texcoord: 14, generic: 16, color: 8 },
              rawSizeBytes: rawSize,
              displaySizeBytes: rawSize,
              requiresMeshoptDecoder: false,
              validation: { passed: false, message: optError instanceof Error ? optError.message : String(optError) },
              fallbackUsed: true,
              message: `Optimizer exception: ${optError instanceof Error ? optError.message : String(optError)}`
            };
            await fs.promises.appendFile(conversionLogPath, `\nGLB optimization exception: ${optError}\n`);
          }
        } else {
          await fs.promises.copyFile(rawGlbPath, displayGlbPath);
          const rawSize = (await fs.promises.stat(displayGlbPath)).size;
          optimizationResult = {
            requestedMode: "disabled",
            status: "disabled",
            tool: "@gltf-transform direct APIs + meshoptimizer",
            toolVersion: "4.4.0 / 1.0.1",
            quantization: { position: 16, normal: 12, texcoord: 14, generic: 16, color: 8 },
            rawSizeBytes: rawSize,
            displaySizeBytes: rawSize,
            requiresMeshoptDecoder: false,
            validation: { passed: false, message: "not run because optimization is disabled" },
            fallbackUsed: false,
            message: "Meshopt optimization disabled; published raw GLB."
          };
        }

        const reductionPercent = optimizationResult.rawSizeBytes > 0
          ? Number(((1 - optimizationResult.displaySizeBytes / optimizationResult.rawSizeBytes) * 100).toFixed(2))
          : 0;
        throwIfAborted(input.signal);
        await input.onProgress?.(95, "Validating final artifact");

        const statsContent = await fs.promises.readFile(statsPath, "utf8");
        const statsObj = JSON.parse(statsContent);
        statsObj.outputGlbSizeBytes = optimizationResult.displaySizeBytes;
        statsObj.optimization = {
          requestedMode: optimizationResult.requestedMode,
          status: optimizationResult.status,
          rawSizeBytes: optimizationResult.rawSizeBytes,
          displaySizeBytes: optimizationResult.displaySizeBytes,
          reductionPercent,
          tool: optimizationResult.tool,
          toolVersion: optimizationResult.toolVersion,
          quantization: optimizationResult.quantization,
          validation: optimizationResult.validation,
          fallbackUsed: optimizationResult.fallbackUsed,
          message: optimizationResult.message
        };
        chunkingStats.totalWallClockSeconds = Number(((Date.now() - jobStartTime) / 1000).toFixed(2));
        statsObj.largeStepChunking = chunkingStats;
        await fs.promises.writeFile(statsPath, JSON.stringify(statsObj, null, 2) + "\n");

        const now = new Date().toISOString();
        const manifestPath = path.join(jobDir, "manifest.json");
        await fs.promises.writeFile(
          manifestPath,
          `${JSON.stringify(
            {
              slug: input.slug,
              status: "ready",
              displayFile: "display.glb",
              generatedBy: "converter-worker",
              generatedAt: now,
              quality: input.quality,
              nativeQualityPreset: nativeQualityDetails.preset,
              nativeDeflection: {
                linear: nativeQualityDetails.linearDeflection,
                angular: nativeQualityDetails.angularDeflection,
                relative: nativeQualityDetails.relative
              },
              adaptiveMesh: {
                enabled: nativeQualityDetails.adaptiveEnabled,
                mode: nativeQualityDetails.adaptiveMode,
                profile: nativeQualityDetails.adaptiveProfile
              },
              converterBackend: input.converterBackend,
              artifacts: {
                displayGlb: "display.glb",
                manifest: "manifest.json",
                stats: "stats.json",
                materialDebug: "material-debug.json",
                xcafReport: "xcaf-report.json",
                meshReport: meshReportPath ? "mesh-report.json" : null,
                conversionLog: "conversion.log"
              },
              optimization: statsObj.optimization,
              largeStepChunking: chunkingStats
            },
            null,
            2
          )}\n`
        );

        await cleanUpChunks(chunks, jobDir);

        return {
          displayGlbPath,
          manifestPath,
          statsPath,
          materialDebugPath,
          conversionLogPath,
          xcafReportPath: aggregatedReportPath,
          meshReportPath
        };
      }
    }
  }

  // NORMAL PATH START
  console.log(`Converter backend: ${input.converterBackend}`);
  console.log(`Converter input path: ${input.sourcePath}`);
  console.log(`Converter output path: ${jobDir}`);
  const nativePreset = nativeQualityPreset(input.quality);
  console.log(`Semantic quality: ${input.quality}`);
  console.log(`Native preset: ${nativePreset}`);

  throwIfAborted(input.signal);
  await input.onProgress?.(15, "Converting - reading STEP and meshing");
  if (input.converterBackend === "occt-js") {
    await runOcctJsConverter({
      converterCli: input.converterCli,
      sourcePath: input.sourcePath,
      outputDir: jobDir,
      quality: occtJsQualityPreset(input.quality), signal: input.signal
    });
  } else {
    await runXcafBaselineConverter({
      xcafConverterBin: input.xcafConverterBin,
      sourcePath: input.sourcePath,
      outputDir: jobDir,
      quality: input.quality,
      xcafColourMode: input.xcafColourMode,
      signal: input.signal,
      onProgress: input.onProgress
    });
  }

  const rawGlbPath = path.join(jobDir, "display.raw.glb");
  const displayGlbPath = path.join(jobDir, "display.glb");
  const statsPath = path.join(jobDir, "stats.json");
  const materialDebugPath = path.join(jobDir, "material-debug.json");
  const xcafReportPath = path.join(jobDir, "xcaf-report.json");
  const meshReportPath = path.join(jobDir, "mesh-report.json");
  throwIfAborted(input.signal);
  await input.onProgress?.(70, "Converting - writing raw GLB");

  let nativeQualityDetails: NativeQualityDetails = {
    preset: nativePreset,
    linearDeflection: nativeDeflections[nativePreset].linear,
    angularDeflection: nativeDeflections[nativePreset].angular,
    relative: true,
    adaptiveEnabled: false,
    adaptiveMode: "off",
    adaptiveProfile: "standard"
  };

  if (input.converterBackend === "occt-js") {
    await assertFile(rawGlbPath, "occt-js converter did not produce display.raw.glb");
    await assertFile(materialDebugPath, "occt-js converter did not produce material-debug.json");
  } else {
    await assertFile(displayGlbPath, "xcaf-baseline converter did not produce display.glb");
    await assertFile(xcafReportPath, "xcaf-baseline converter did not produce xcaf-report.json");
    nativeQualityDetails = await writeXcafCompatibilityFiles({
      reportPath: xcafReportPath,
      statsPath,
      materialDebugPath,
      sourcePath: input.sourcePath,
      displayGlbPath,
      quality: input.quality
    });
  }
  const hasMeshReport = input.converterBackend === "xcaf-baseline" && (await fileExists(meshReportPath));

  await assertFile(statsPath, "converter did not produce stats.json");
  await assertFile(conversionLogPath, "converter did not produce conversion.log");

  let optimizationResult: any = null;

  if (input.glbOptimizationMode === "meshopt") {
    throwIfAborted(input.signal);
    await input.onProgress?.(85, "Optimizing GLB");
    if (input.converterBackend === "xcaf-baseline") {
      await fs.promises.rename(displayGlbPath, rawGlbPath);
    }
    try {
      const { optimizeDisplayGlb } = await import("./glbOptimizer.js");
      optimizationResult = await optimizeDisplayGlb({
        requestedMode: "meshopt",
        rawGlbPath,
        displayGlbPath,
        conversionLogPath
      });
    } catch (optError) {
      console.error("GLB optimizer threw exception:", optError);
      await fs.promises.copyFile(rawGlbPath, displayGlbPath);
      const rawSize = (await fs.promises.stat(rawGlbPath)).size;
      optimizationResult = {
        requestedMode: "meshopt",
        status: "failed",
        tool: "@gltf-transform direct APIs + meshoptimizer",
        toolVersion: "4.4.0 / 1.0.1",
        quantization: { position: 16, normal: 12, texcoord: 14, generic: 16, color: 8 },
        rawSizeBytes: rawSize,
        displaySizeBytes: rawSize,
        requiresMeshoptDecoder: false,
        validation: { passed: false, message: optError instanceof Error ? optError.message : String(optError) },
        fallbackUsed: true,
        message: `Optimizer exception: ${optError instanceof Error ? optError.message : String(optError)}`
      };
      await fs.promises.appendFile(conversionLogPath, `\nGLB optimization exception: ${optError}\n`);
    }
  } else {
    if (input.converterBackend === "occt-js") {
      await fs.promises.copyFile(rawGlbPath, displayGlbPath);
    }
    const rawSize = (await fs.promises.stat(displayGlbPath)).size;
    optimizationResult = {
      requestedMode: "disabled",
      status: "disabled",
      tool: "@gltf-transform direct APIs + meshoptimizer",
      toolVersion: "4.4.0 / 1.0.1",
      quantization: { position: 16, normal: 12, texcoord: 14, generic: 16, color: 8 },
      rawSizeBytes: rawSize,
      displaySizeBytes: rawSize,
      requiresMeshoptDecoder: false,
      validation: { passed: false, message: "not run because optimization is disabled" },
      fallbackUsed: false,
      message: "Meshopt optimization disabled; published raw GLB."
    };
  }

  const reductionPercent = optimizationResult.rawSizeBytes > 0
    ? Number(((1 - optimizationResult.displaySizeBytes / optimizationResult.rawSizeBytes) * 100).toFixed(2))
    : 0;
  throwIfAborted(input.signal);
  await input.onProgress?.(95, "Validating final artifact");

  // Update stats.json to reflect the final display.glb size and include optimization/chunking metadata
  const statsContent = await fs.promises.readFile(statsPath, "utf8");
  const statsObj = JSON.parse(statsContent);
  statsObj.outputGlbSizeBytes = optimizationResult.displaySizeBytes;
  statsObj.optimization = {
    requestedMode: optimizationResult.requestedMode,
    status: optimizationResult.status,
    rawSizeBytes: optimizationResult.rawSizeBytes,
    displaySizeBytes: optimizationResult.displaySizeBytes,
    reductionPercent,
    tool: optimizationResult.tool,
    toolVersion: optimizationResult.toolVersion,
    quantization: optimizationResult.quantization,
    validation: optimizationResult.validation,
    fallbackUsed: optimizationResult.fallbackUsed,
    message: optimizationResult.message
  };
  chunkingStats.totalWallClockSeconds = Number(((Date.now() - jobStartTime) / 1000).toFixed(2));
  statsObj.largeStepChunking = chunkingStats;
  await fs.promises.writeFile(statsPath, JSON.stringify(statsObj, null, 2) + "\n");

  const now = new Date().toISOString();
  const manifestPath = path.join(jobDir, "manifest.json");
  await fs.promises.writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        slug: input.slug,
        status: "ready",
        displayFile: "display.glb",
        generatedBy: "converter-worker",
        generatedAt: now,
        quality: input.quality,
        nativeQualityPreset: nativeQualityDetails.preset,
        nativeDeflection: {
          linear: nativeQualityDetails.linearDeflection,
          angular: nativeQualityDetails.angularDeflection,
          relative: nativeQualityDetails.relative
        },
        adaptiveMesh: {
          enabled: nativeQualityDetails.adaptiveEnabled,
          mode: nativeQualityDetails.adaptiveMode,
          profile: nativeQualityDetails.adaptiveProfile
        },
        converterBackend: input.converterBackend,
        artifacts: {
          displayGlb: "display.glb",
          manifest: "manifest.json",
          stats: "stats.json",
          materialDebug: "material-debug.json",
          xcafReport: input.converterBackend === "xcaf-baseline" ? "xcaf-report.json" : null,
          meshReport: hasMeshReport ? "mesh-report.json" : null,
          conversionLog: "conversion.log"
        },
        optimization: statsObj.optimization,
        largeStepChunking: chunkingStats
      },
      null,
      2
    )}\n`
  );

  return {
    displayGlbPath,
    manifestPath,
    statsPath,
    materialDebugPath,
    conversionLogPath,
    xcafReportPath: input.converterBackend === "xcaf-baseline" ? xcafReportPath : undefined,
    meshReportPath: hasMeshReport ? meshReportPath : undefined
  };
}

function runOcctJsConverter(input: {
  converterCli: string;
  sourcePath: string;
  outputDir: string;
  quality: string;
  signal?: AbortSignal;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = child_process.spawn(
      process.execPath,
      [
        input.converterCli,
        "--input",
        input.sourcePath,
        "--outdir",
        input.outputDir,
        "--quality",
        input.quality
      ],
      {
        stdio: ["ignore", "inherit", "inherit"]
      }
    );
    const abort = () => child.kill("SIGTERM");
    input.signal?.addEventListener("abort", abort, { once: true });

    child.on("error", reject);
    child.on("exit", (code) => {
      input.signal?.removeEventListener("abort", abort);
      if (input.signal?.aborted) return reject(new DOMException("Conversion cancelled.", "AbortError"));
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`converter exited with code ${code ?? "unknown"}`));
    });
  });
}

async function runXcafBaselineConverter(input: {
  xcafConverterBin: string;
  sourcePath: string;
  outputDir: string;
  quality: ConversionQuality;
  xcafColourMode: "xcaf-baseline" | "step-presentation";
  signal?: AbortSignal;
  onProgress?: (percent: number, label: string) => void | Promise<void>;
}): Promise<void> {
  const stat = await fs.promises.stat(input.xcafConverterBin).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new Error(`xcaf-baseline converter binary is missing: ${input.xcafConverterBin}`);
  }

  const nativeQuality = nativeQualityPreset(input.quality);
  const deflection = nativeDeflections[nativeQuality];

  console.log(`XCAF colour mode: ${input.xcafColourMode}`);
  console.log("Converter colour space: raw");
  console.log(`Native XCAF binary: ${input.xcafConverterBin}`);
  console.log(`Semantic quality: ${input.quality}`);
  console.log(`Native XCAF quality: ${nativeQuality}`);
  console.log(`Native deflection: linear=${deflection.linear}, angular=${deflection.angular}, relative=true`);
  const adaptiveMesh = meshiqAdaptiveMeshMode();
  const adaptiveProfile = meshiqAdaptiveMeshProfile();
  console.log(`MeshIQ adaptive mesh: ${adaptiveMesh}`);
  console.log(`MeshIQ adaptive profile: ${adaptiveMesh === "on" ? adaptiveProfile : "standard"}`);

  const args = [
    input.sourcePath,
    input.outputDir,
    nativeQuality,
    "--colour-mode",
    input.xcafColourMode,
    "--colour-space",
    "raw"
  ];

  // Read environment flags and push them to args
  const parallelMesh = process.env.XCAF_PARALLEL_MESH === "off" ? "off" : "on";
  args.push("--parallel-mesh", parallelMesh);
  if (adaptiveMesh === "on") {
    args.push("--adaptive-mesh", "on");
    args.push("--adaptive-mesh-profile", adaptiveProfile);
  }

  if (process.env.DEBUG_SUPER_COARSE_MESH === "true") {
    args.push("--debug-super-coarse-mesh");
  }
  if (process.env.DEBUG_SKIP_RAW_STEP_STYLES === "true") {
    args.push("--debug-skip-raw-step-styles");
  }
  if (process.env.DEBUG_DISABLE_STYLE_CACHE === "true") {
    args.push("--debug-disable-style-cache");
  }
  if (process.env.DEBUG_LEGACY_TRANSFORM === "true") {
    args.push("--debug-legacy-transform");
  }

  // Mesh reuse is ON by default. Set DEBUG_DISABLE_MESH_REUSE=true to kill-switch it.
  const meshReuseKillSwitch = process.env.DEBUG_DISABLE_MESH_REUSE === "true";
  if (meshReuseKillSwitch) {
    console.log("Mesh reuse: disabled (kill switch DEBUG_DISABLE_MESH_REUSE=true)");
    args.push("--debug-disable-mesh-reuse");
  } else {
    console.log("Mesh reuse: enabled (default)");
    args.push("--enable-mesh-reuse");
  }

  await spawnProcess(input.xcafConverterBin, args, input.signal, input.onProgress);

  const conversionLogPath = path.join(input.outputDir, "conversion.log");
  const existingLog = await fs.promises.readFile(conversionLogPath, "utf8").catch(() => "");
  const meshReuseMode = meshReuseKillSwitch ? "disabled (kill switch)" : "enabled (default)";
  const header = [
    `Converter backend: xcaf-baseline`,
    `Input path: ${input.sourcePath}`,
    `Output path: ${input.outputDir}`,
    `Semantic quality: ${input.quality}`,
    `Native preset: ${nativeQuality}`,
    `Native deflection: linear=${deflection.linear}, angular=${deflection.angular}, relative=true`,
    `MeshIQ adaptive mesh: ${adaptiveMesh}`,
    `MeshIQ adaptive profile: ${adaptiveMesh === "on" ? adaptiveProfile : "standard"}`,
    `XCAF colour mode: ${input.xcafColourMode}`,
    `Colour space: raw`,
    `Mesh reuse: ${meshReuseMode}`,
    `Material rules: disabled for xcaf-baseline`,
    ""
  ].join("\n");
  await fs.promises.writeFile(conversionLogPath, `${header}${existingLog}`);
}

function spawnProcess(
  command: string,
  args: string[],
  signal?: AbortSignal,
  onProgress?: (percent: number, label: string) => void | Promise<void>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = child_process.spawn(command, args, {
      stdio: ["ignore", "pipe", "inherit"]
    });

    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      // Forward to standard output so it is visible in console
      process.stdout.write(chunk);

      buffer += chunk.toString("utf8");
      let boundary = buffer.lastIndexOf("\n");
      if (boundary !== -1) {
        const lines = buffer.substring(0, boundary).split("\n");
        buffer = buffer.substring(boundary + 1);

        for (let line of lines) {
          line = line.trim();
          if (!line) continue;

          // Parse progress stages
          if (line.includes("STEP read start")) {
            onProgress?.(18, "Reading STEP file");
          } else if (line.includes("STEP read end")) {
            onProgress?.(25, "Completed reading STEP file");
          } else if (line.includes("XCAF doc transfer start")) {
            onProgress?.(27, "Transferring STEP to XCAF document");
          } else if (line.includes("XCAF doc transfer end")) {
            onProgress?.(32, "Completed XCAF document transfer");
          } else if (line.includes("Parsing raw STEP presentation styles")) {
            onProgress?.(35, "Parsing STEP presentation styles");
          } else if (line.includes("Recursive topology/body scan start")) {
            onProgress?.(38, "Scanning assembly topology");
          } else if (line.includes("Recursive topology/body scan end")) {
            onProgress?.(42, "Completed assembly topology scan");
          } else if (line.includes("Recursive XCAF label traversal start")) {
            onProgress?.(45, "Traversing shapes and generating mesh");
          } else if (line.includes("Recursive XCAF label traversal end")) {
            onProgress?.(65, "Completed shape traversal and meshing");
          } else if (line.includes("Writing display.glb")) {
            onProgress?.(67, "Writing GLB file");
          } else if (line.includes("Writing xcaf-report.json")) {
            onProgress?.(69, "Writing XCAF report");
          } else if (line.includes("Done:")) {
            onProgress?.(70, "Conversion finished");
          } else {
            // Regex match for meshing shape
            // format: "Meshing shape X / Y: name=..." or "Meshed shape X / Y: elapsedMs=..."
            const meshMatch = line.match(/(?:Meshing|Meshed) shape (\d+) \/ (\d+)/i);
            if (meshMatch) {
              const current = parseInt(meshMatch[1], 10);
              const total = parseInt(meshMatch[2], 10);
              if (total > 0) {
                const fraction = current / total;
                const percent = Math.min(65, Math.floor(45 + fraction * 20));
                onProgress?.(percent, `Meshing shape ${current} of ${total}`);
              }
            }
          }
        }
      }
    });

    const abort = () => {
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abort, { once: true });

    child.on("error", reject);
    child.on("exit", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(new DOMException("Conversion cancelled.", "AbortError"));
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Conversion cancelled.", "AbortError");
}
async function writeXcafCompatibilityFiles(input: {
  reportPath: string;
  statsPath: string;
  materialDebugPath: string;
  sourcePath: string;
  displayGlbPath: string;
  quality: ConversionQuality;
}): Promise<NativeQualityDetails> {
  const report = JSON.parse(await fs.promises.readFile(input.reportPath, "utf8")) as {
    openCascadeVersion?: string;
    summary?: Record<string, unknown>;
    quality?: {
      preset?: NativeQualityPreset;
      linearDeflection?: number;
      angularDeflection?: number;
      relative?: boolean;
      adaptiveEnabled?: boolean;
      adaptiveMode?: string;
      adaptiveProfile?: string;
    };
    colourMode?: { mode?: string };
    colourSpace?: { mode?: string };
    finalGlbColourAudit?: unknown;
    colouredPrimitivesBySource?: unknown;
    rawStepStyleResolver?: unknown;
    componentsStayedDefaultGrey?: unknown;
  };
  const sourceStat = await fs.promises.stat(input.sourcePath);
  const glbStat = await fs.promises.stat(input.displayGlbPath);

  const stats = {
    success: true,
    converterBackend: "xcaf-baseline",
    sourceFileName: path.basename(input.sourcePath),
    sourceFileSizeBytes: sourceStat.size,
    outputGlbSizeBytes: glbStat.size,
    semanticQuality: input.quality,
    qualityPreset: input.quality,
    nativeQualityPreset: report.quality?.preset,
    nativeLinearDeflection: report.quality?.linearDeflection,
    nativeAngularDeflection: report.quality?.angularDeflection,
    nativeRelativeDeflection: report.quality?.relative,
    adaptiveMesh: {
      enabled: report.quality?.adaptiveEnabled ?? false,
      mode: report.quality?.adaptiveMode ?? "off",
      profile: report.quality?.adaptiveProfile ?? "standard"
    },
    openCascadeVersion: report.openCascadeVersion,
    colourMode: report.colourMode?.mode,
    colourSpace: report.colourSpace?.mode,
    triangleCount: report.summary?.triangles ?? 0,
    nodeCount: report.summary?.nodeCount ?? 0,
    meshCount: report.summary?.meshesPrimitivesExported ?? report.summary?.primitiveCount ?? 0,
    materialCount: report.summary?.materialCount ?? 0,
    processingSeconds: report.summary?.conversionSeconds ?? 0,
    xcafSummary: report.summary ?? {},
    meshReuse: {
      enabled: report.summary?.reusedInstances !== undefined,
      reusedInstances: report.summary?.reusedInstances ?? null,
      freshInstances: report.summary?.freshInstances ?? null,
      tessellationCacheHits: report.summary?.tessellationCacheHits ?? null,
      tessellationCacheMisses: report.summary?.tessellationCacheMisses ?? null,
      uniqueStoredTriangles: report.summary?.uniqueStoredTriangles ?? null
    },
    warningMessages: [],
    errorMessages: []
  };

  const materialDebug = {
    converterBackend: "xcaf-baseline",
    materialRules: "disabled",
    colourMode: report.colourMode,
    colourSpace: report.colourSpace,
    finalGlbColourAudit: report.finalGlbColourAudit ?? [],
    colouredPrimitivesBySource: report.colouredPrimitivesBySource ?? {},
    rawStepStyleResolver: report.rawStepStyleResolver ?? {},
    componentsStayedDefaultGrey: report.componentsStayedDefaultGrey ?? [],
    xcafReportFile: "xcaf-report.json"
  };

  await fs.promises.writeFile(input.statsPath, `${JSON.stringify(stats, null, 2)}\n`);
  await fs.promises.writeFile(input.materialDebugPath, `${JSON.stringify(materialDebug, null, 2)}\n`);

  const fallbackPreset = nativeQualityPreset(input.quality);
  return {
    preset: report.quality?.preset ?? fallbackPreset,
    linearDeflection: report.quality?.linearDeflection ?? nativeDeflections[fallbackPreset].linear,
    angularDeflection: report.quality?.angularDeflection ?? nativeDeflections[fallbackPreset].angular,
    relative: report.quality?.relative ?? true,
    adaptiveEnabled: report.quality?.adaptiveEnabled ?? false,
    adaptiveMode: report.quality?.adaptiveMode ?? "off",
    adaptiveProfile: report.quality?.adaptiveProfile ?? "standard"
  };
}

type NativeQualityDetails = {
  preset: NativeQualityPreset;
  linearDeflection: number;
  angularDeflection: number;
  relative: boolean;
  adaptiveEnabled: boolean;
  adaptiveMode: string;
  adaptiveProfile: string;
};

async function assertFile(filePath: string, message: string): Promise<void> {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile() || stat.size === 0) {
    throw new Error(message);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  return Boolean(stat && stat.isFile() && stat.size > 0);
}

async function runPlanner(input: {
  plannerBin: string;
  sourcePath: string;
  outputDir: string;
  targetChunks: number;
  signal?: AbortSignal;
}): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = child_process.spawn(
      input.plannerBin,
      [
        input.sourcePath,
        input.outputDir,
        "--target-chunks",
        String(input.targetChunks)
      ],
      { stdio: ["ignore", "pipe", "inherit"] }
    );

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      process.stdout.write(chunk);
    });

    const abort = () => child.kill("SIGTERM");
    input.signal?.addEventListener("abort", abort, { once: true });

    child.on("error", reject);
    child.on("exit", (code) => {
      input.signal?.removeEventListener("abort", abort);
      if (input.signal?.aborted) return reject(new DOMException("Conversion cancelled.", "AbortError"));
      resolve({ stdout, code: code ?? -1 });
    });
  });
}

async function aggregateReports(
  chunkReportPaths: string[],
  mergedReportPath: string,
  rawGlbPath: string
): Promise<void> {
  const reports: any[] = [];
  for (const p of chunkReportPaths) {
    reports.push(JSON.parse(await fs.promises.readFile(p, "utf8")));
  }

  const first = reports[0] || {};
  const merged: any = {
    inputFile: first.inputFile,
    openCascadeVersion: first.openCascadeVersion,
    outputs: {
      glb: "display.glb",
      report: "xcaf-report.json",
      log: "conversion.log"
    },
    quality: first.quality,
    colourSpace: first.colourSpace,
    colourMode: first.colourMode,
    colourPriority: first.colourPriority,
    summary: {},
    filtering: first.filtering || { enabled: false }
  };

  const sumKeys = [
    "freeShapes", "labelsComponentsProcessed", "namedObjects", "colouredObjects",
    "uniqueColours", "layers", "shapesTessellated", "nodeCount", "meshesPrimitivesExported",
    "primitiveCount", "materialCount", "vertices", "triangles", "skippedShapes",
    "failedShapes", "defaultMaterialUsage", "rawStepStyledItemFaceUses",
    "rawStepAmbiguousRepresentationRejects", "rawStepBroadRepresentationRejects",
    "reusedInstances", "freshInstances", "tessellationCacheHits", "tessellationCacheMisses",
    "uniqueStoredTriangles", "repeatedComponentGroups", "repeatedComponentColourMismatches",
    "glbBytes"
  ];

  for (const k of sumKeys) {
    merged.summary[k] = reports.reduce((sum, r) => sum + ((r.summary && r.summary[k]) || 0), 0);
  }
  merged.summary.conversionSeconds = reports.reduce((sum, r) => sum + ((r.summary && r.summary.conversionSeconds) || 0), 0);

  try {
    const glbStat = await fs.promises.stat(rawGlbPath);
    merged.summary.glbBytes = glbStat.size;
  } catch (e) {}

  let globalMin = [Infinity, Infinity, Infinity];
  let globalMax = [-Infinity, -Infinity, -Infinity];
  let hasBbox = false;
  for (const r of reports) {
    if (r.globalBoundingBox && r.globalBoundingBox.min && r.globalBoundingBox.max) {
      for (let i = 0; i < 3; i++) {
        globalMin[i] = Math.min(globalMin[i], r.globalBoundingBox.min[i]);
        globalMax[i] = Math.max(globalMax[i], r.globalBoundingBox.max[i]);
      }
      hasBbox = true;
    }
  }

  if (hasBbox) {
    const diag = Math.sqrt(
      Math.pow(globalMax[0] - globalMin[0], 2) +
      Math.pow(globalMax[1] - globalMin[1], 2) +
      Math.pow(globalMax[2] - globalMin[2], 2)
    );
    merged.globalBoundingBox = {
      min: globalMin,
      max: globalMax,
      diagonal: diag
    };
  } else {
    merged.globalBoundingBox = first.globalBoundingBox;
  }

  merged.coloursBySource = Object.assign({}, ...reports.map(r => r.coloursBySource || {}));
  merged.colouredPrimitivesBySource = Object.assign({}, ...reports.map(r => r.colouredPrimitivesBySource || {}));
  merged.rawStepStyleResolver = Object.assign({}, ...reports.map(r => r.rawStepStyleResolver || {}));

  const arrayKeys = [
    "finalGlbColourAudit", "rawStepColourAudit", "rawStepDerivedComponents",
    "componentsStayedDefaultGrey", "uniqueColourValues", "layers",
    "defaultPrimitiveGroups", "topDefaultHeavyLabels", "repeatedComponentColourMismatches",
    "siblingColourComparison", "diagnosticNameMatches"
  ];
  for (const k of arrayKeys) {
    merged[k] = reports.reduce((acc, r) => acc.concat(r[k] || []), []);
  }

  if (first.objects) {
    merged.objects = reports.reduce((acc, r) => acc.concat(r.objects || []), []);
  }
  if (first.materials) {
    merged.materials = reports.reduce((acc, r) => acc.concat(r.materials || []), []);
  }

  await fs.promises.writeFile(mergedReportPath, JSON.stringify(merged, null, 2) + "\n");
}

async function preserveChunkMeshReports(chunkMeshReportPaths: string[], jobDir: string): Promise<void> {
  const reportsDir = path.join(jobDir, "chunk-mesh-reports");
  await fs.promises.mkdir(reportsDir, { recursive: true });
  for (const reportPath of chunkMeshReportPaths) {
    const match = reportPath.match(/chunk-(\d+)[\\/]+mesh-report\.json$/);
    const chunkIndex = match ? match[1] : String(chunkMeshReportPaths.indexOf(reportPath));
    await fs.promises.copyFile(reportPath, path.join(reportsDir, `chunk-${chunkIndex}-mesh-report.json`));
  }
}

async function aggregateMeshReports(
  chunkMeshReportPaths: string[],
  mergedMeshReportPath: string
): Promise<void> {
  const reports = await Promise.all(
    chunkMeshReportPaths.map(async (reportPath) => JSON.parse(await fs.promises.readFile(reportPath, "utf8")))
  );
  const first = reports[0] || {};
  const parts = reports.flatMap((report) => Array.isArray(report.parts) ? report.parts : []);
  const totals = {
    trianglesBeforeSimplification: 0,
    trianglesAfterSimplification: 0,
    verticesBeforeSimplification: 0,
    verticesAfterSimplification: 0,
    primitiveCount: 0,
    partCount: 0,
    meshingTimeMs: 0,
    simplificationTimeMs: 0
  };
  for (const report of reports) {
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
      totals[key] += Number(report.totals?.[key] ?? 0);
    }
  }

  let globalMin = [Infinity, Infinity, Infinity];
  let globalMax = [-Infinity, -Infinity, -Infinity];
  let hasBounds = false;
  for (const part of parts) {
    const min = part.boundingBox?.min;
    const max = part.boundingBox?.max;
    if (Array.isArray(min) && Array.isArray(max) && min.length === 3 && max.length === 3) {
      for (let i = 0; i < 3; i++) {
        globalMin[i] = Math.min(globalMin[i], Number(min[i]));
        globalMax[i] = Math.max(globalMax[i], Number(max[i]));
      }
      hasBounds = true;
    }
  }
  const diagonal = hasBounds
    ? Math.sqrt(
        Math.pow(globalMax[0] - globalMin[0], 2) +
        Math.pow(globalMax[1] - globalMin[1], 2) +
        Math.pow(globalMax[2] - globalMin[2], 2)
      )
    : 0;
  if (!hasBounds) {
    globalMin = [0, 0, 0];
    globalMax = [0, 0, 0];
  }

  const rankPart = (part: any) => ({
    stableObjectId: part.stableObjectId,
    displayName: part.displayName,
    labelPath: part.labelPath,
    instancePath: part.instancePath,
    bboxDiagonal: Number(part.boundingBox?.diagonal ?? 0),
    sizeRatio: Number(part.sizeRatio ?? 0),
    triangleCount: Number(part.trianglesBeforeSimplification ?? 0),
    vertexCount: Number(part.verticesBeforeSimplification ?? 0),
    densityScore: Number(part.densityScore ?? 0),
    meshingTimeMs: part.meshingTimeMs ?? null
  });
  const topTinyDenseParts = [...parts]
    .sort((a, b) => {
      const scoreA = (1 / Math.max(Number(a.sizeRatio ?? 0), 0.000001)) *
        Math.max(Number(a.densityScore ?? 0), 0) *
        Math.log1p(Number(a.trianglesBeforeSimplification ?? 0));
      const scoreB = (1 / Math.max(Number(b.sizeRatio ?? 0), 0.000001)) *
        Math.max(Number(b.densityScore ?? 0), 0) *
        Math.log1p(Number(b.trianglesBeforeSimplification ?? 0));
      return scoreB - scoreA;
    })
    .slice(0, 20)
    .map(rankPart);
  const topLargeSparseParts = [...parts]
    .sort((a, b) => {
      const scoreA = Number(a.sizeRatio ?? 0) /
        Math.max(Number(a.densityScore ?? 0), 0.000001) /
        Math.max(1, Math.log1p(Number(a.trianglesBeforeSimplification ?? 0)));
      const scoreB = Number(b.sizeRatio ?? 0) /
        Math.max(Number(b.densityScore ?? 0), 0.000001) /
        Math.max(1, Math.log1p(Number(b.trianglesBeforeSimplification ?? 0)));
      return scoreB - scoreA;
    })
    .slice(0, 20)
    .map(rankPart);
  const topSlowMeshParts = [...parts]
    .sort((a, b) => Number(b.meshingTimeMs ?? -1) - Number(a.meshingTimeMs ?? -1))
    .slice(0, 20)
    .map(rankPart);

  const merged = {
    schemaVersion: 1,
    converterBackend: first.converterBackend ?? "xcaf-baseline",
    sourceFileName: first.sourceFileName,
    quality: first.quality,
    assemblyBoundingBox: {
      min: globalMin,
      max: globalMax,
      diagonal
    },
    totals,
    parts,
    rankings: {
      topTinyDenseParts,
      topLargeSparseParts,
      topSlowMeshParts
    },
    warnings: [
      "Aggregated from chunk-level mesh-report.json files; chunk reports are preserved under chunk-mesh-reports/.",
      ...reports.flatMap((report) => Array.isArray(report.warnings) ? report.warnings : [])
    ],
    recommendations: first.recommendations ?? []
  };
  await fs.promises.writeFile(mergedMeshReportPath, JSON.stringify(merged, null, 2) + "\n");
}

async function cleanUpChunks(chunks: any[], jobDir: string): Promise<void> {
  for (const chunk of chunks) {
    const idx = chunk.chunk_index;
    const chunkOutputDir = path.join(jobDir, `chunk-${idx}`);
    const labelListPath = path.join(jobDir, `chunk-${idx}-label-list.txt`);
    await fs.promises.rm(chunkOutputDir, { recursive: true, force: true }).catch(() => {});
    await fs.promises.rm(labelListPath, { force: true }).catch(() => {});
  }
}

async function appendLog(logPath: string, message: string): Promise<void> {
  await fs.promises.appendFile(logPath, message).catch(() => {});
}
