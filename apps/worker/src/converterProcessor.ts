import child_process from "node:child_process";
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
  largeStepChunkingMode?: "disabled" | "direct-filter";
  largeStepFileSizeThresholdMb?: number;
  largeStepLeafCountThreshold?: number;
  largeStepFaceCountThreshold?: number;
  largeStepTargetChunks?: number;
  largeStepMaxConcurrentChunks?: number;
  largeStepChunkFallbackMode?: "fail" | "full-conversion";
};

export type ConverterProcessorOutput = {
  displayGlbPath: string;
  manifestPath: string;
  statsPath: string;
  materialDebugPath: string;
  conversionLogPath: string;
  xcafReportPath?: string;
};

export async function convertStepJob(input: ConverterProcessorInput): Promise<ConverterProcessorOutput> {
  const jobDir = path.join(input.outputDir, input.slug);
  fs.mkdirSync(jobDir, { recursive: true });

  const largeStepChunkingMode = input.largeStepChunkingMode ?? "disabled";
  const largeStepFileSizeThresholdMb = input.largeStepFileSizeThresholdMb ?? 80;
  const largeStepLeafCountThreshold = input.largeStepLeafCountThreshold ?? 2000;
  const largeStepFaceCountThreshold = input.largeStepFaceCountThreshold ?? 50000;
  const largeStepTargetChunks = input.largeStepTargetChunks ?? 3;
  const largeStepMaxConcurrentChunks = input.largeStepMaxConcurrentChunks ?? 3;
  const largeStepChunkFallbackMode = input.largeStepChunkFallbackMode ?? "fail";

  const conversionLogPath = path.join(jobDir, "conversion.log");

  const chunkingStats: any = {
    mode: largeStepChunkingMode,
    status: "disabled"
  };

  let useChunking = false;
  const ext = path.extname(input.sourcePath).toLowerCase();
  const isStep = ext === ".step" || ext === ".stp";

  if (largeStepChunkingMode === "direct-filter") {
    if (!isStep) {
      chunkingStats.status = "skipped";
      chunkingStats.skipReason = "Not a STEP/STP file";
      await appendLog(conversionLogPath, `[CHUNKING] Skipped chunking: file extension is "${ext}" (only STEP/STP supported).\n`);
    } else if (input.converterBackend !== "xcaf-baseline") {
      chunkingStats.status = "skipped";
      chunkingStats.skipReason = `Converter backend is "${input.converterBackend}" (only xcaf-baseline supported)`;
      await appendLog(conversionLogPath, `[CHUNKING] Skipped chunking: backend is "${input.converterBackend}" (only xcaf-baseline supported).\n`);
    } else {
      const sourceStat = await fs.promises.stat(input.sourcePath);
      const fileSizeMb = sourceStat.size / (1024 * 1024);
      if (fileSizeMb < largeStepFileSizeThresholdMb) {
        chunkingStats.status = "skipped";
        chunkingStats.skipReason = `File size ${fileSizeMb.toFixed(2)} MB is below threshold ${largeStepFileSizeThresholdMb} MB`;
        await appendLog(conversionLogPath, `[CHUNKING] Skipped chunking: file size ${fileSizeMb.toFixed(2)} MB is below threshold ${largeStepFileSizeThresholdMb} MB.\n`);
      } else {
        useChunking = true;
      }
    }
  }

  if (useChunking) {
    const plannerBin = path.join(path.dirname(input.xcafConverterBin), "xcaf-step-planner");
    await input.onProgress?.(12, "Planning large model");
    await appendLog(conversionLogPath, `[CHUNKING] Running planner: ${plannerBin} with target chunks ${largeStepTargetChunks}\n`);

    let plannerResult: { stdout: string; code: number } | null = null;
    try {
      plannerResult = await runPlanner({
        plannerBin,
        sourcePath: input.sourcePath,
        outputDir: jobDir,
        targetChunks: largeStepTargetChunks,
        signal: input.signal
      });
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

    if (useChunking && plannerResult) {
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
        let plan: any;
        try {
          plan = JSON.parse(await fs.promises.readFile(planPath, "utf8"));
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

        if (useChunking && plan) {
          const leafCount = plan.model_summary?.total_leaf_shape_count ?? 0;
          const faceCount = plan.model_summary?.total_face_count ?? 0;
          const recommended = plan.chunking_recommendation?.chunking_enabled === true;

          chunkingStats.planner = {
            leafCount,
            faceCount,
            recommended
          };

          const shouldChunk =
            leafCount > largeStepLeafCountThreshold ||
            faceCount > largeStepFaceCountThreshold ||
            recommended;

          if (!shouldChunk) {
            chunkingStats.status = "skipped";
            chunkingStats.skipReason = `Thresholds not exceeded (leaves=${leafCount}, faces=${faceCount}, recommended=${recommended})`;
            await appendLog(conversionLogPath, `[CHUNKING] Skipped chunking: thresholds not met. Leaves=${leafCount}, Faces=${faceCount}, Recommended=${recommended}.\n`);
            useChunking = false;
          } else {
            chunkingStats.targetChunks = plan.chunking_recommendation?.target_chunks ?? largeStepTargetChunks;
            chunkingStats.actualChunks = plan.chunks?.length ?? 0;
          }
        }
      }
    }
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

    const maxConcurrency = Math.min(largeStepMaxConcurrentChunks, chunks.length);
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
    let nextIndex = 0;
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
          stdio: ["ignore", "pipe", "inherit"]
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

    try {
      const worker = async () => {
        while (nextIndex < chunks.length) {
          if (input.signal?.aborted) {
            throw new DOMException("Conversion cancelled.", "AbortError");
          }
          const chunk = chunks[nextIndex++];
          await runChunk(chunk);
        }
      };
      const workers = Array.from({ length: maxConcurrency }, () => worker());
      await Promise.all(workers);

      if (input.signal) {
        input.signal.removeEventListener("abort", abortListener);
      }
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
              converterBackend: input.converterBackend,
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
          xcafReportPath: aggregatedReportPath
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
  throwIfAborted(input.signal);
  await input.onProgress?.(70, "Converting - writing raw GLB");

  let nativeQualityDetails: NativeQualityDetails = {
    preset: nativePreset,
    linearDeflection: nativeDeflections[nativePreset].linear,
    angularDeflection: nativeDeflections[nativePreset].angular,
    relative: true
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
        converterBackend: input.converterBackend,
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
    xcafReportPath: input.converterBackend === "xcaf-baseline" ? xcafReportPath : undefined
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
    relative: report.quality?.relative ?? true
  };
}

type NativeQualityDetails = {
  preset: NativeQualityPreset;
  linearDeflection: number;
  angularDeflection: number;
  relative: boolean;
};

async function assertFile(filePath: string, message: string): Promise<void> {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile() || stat.size === 0) {
    throw new Error(message);
  }
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
