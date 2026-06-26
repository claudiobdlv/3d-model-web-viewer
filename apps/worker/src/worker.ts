import path from "node:path";
import fs from "node:fs";
import { WorkerClient, type WorkerJob } from "./client.js";
import { loadConfig } from "./config.js";
import { convertStepJob } from "./converterProcessor.js";
import { nativeQualityPreset, resolveSemanticQuality } from "./quality.js";
import { fillAvailableWorkerSlots } from "./workerPool.js";

const config = loadConfig();
const client = new WorkerClient(config);

console.log(`Converter worker starting against ${config.serverUrl}`);
console.log(`Poll interval: ${config.pollIntervalMs / 1000}s`);
console.log(`Maximum concurrent jobs: ${config.maxConcurrentJobs}`);
console.log(`Output dir: ${config.outputDir}`);
console.log(`Converter backend: ${config.converterBackend}`);
console.log(`Converter CLI: ${config.converterCli}`);
console.log(`XCAF converter binary: ${config.xcafConverterBin}`);
console.log(`Converter quality: ${config.quality}`);
if (config.converterBackend === "xcaf-baseline") {
  console.log(`XCAF colour mode: ${config.xcafColourMode}`);
  console.log(`MeshIQ adaptive mesh: ${config.meshiqAdaptiveMesh}`);
  console.log(`MeshIQ adaptive profile: ${config.meshiqAdaptiveMeshProfile}`);
} else {
  console.log(`Material rules mode: ${process.env.MATERIAL_RULES_MODE || "fallback"}`);
}
console.log(`Keep worker output: ${config.keepWorkerOutput}`);
console.log(`Maximum model artifact: ${config.maxModelArtifactBytes} bytes`);
console.log(`GLB optimization mode: ${config.glbOptimizationMode}`);
console.log(`Run once: ${config.runOnce}`);

const activeJobs = new Set<Promise<void>>();
let shutdownRequested = false;

process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);

await runWorkerPool();

async function runWorkerPool(): Promise<void> {
  while (!shutdownRequested) {
    let queueEmpty = false;

    try {
      const fill = await fillAvailableWorkerSlots<WorkerJob>({
        maxConcurrentJobs: config.maxConcurrentJobs,
        activeCount: () => shutdownRequested ? config.maxConcurrentJobs : activeJobs.size,
        claimNext: () => client.getNextJob(),
        start: startTrackedJob
      });
      queueEmpty = fill.queueEmpty;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown polling error.";
      console.error(`Could not claim next job: ${message}`);
      queueEmpty = true;
    }

    if (config.runOnce) break;

    if (activeJobs.size > 0) {
      await Promise.race(activeJobs);
    } else if (queueEmpty) {
      console.log("No pending worker job.");
      await sleep(config.pollIntervalMs);
    }
  }

  if (activeJobs.size > 0) {
    console.log(`Worker shutdown waiting for ${activeJobs.size} active job(s).`);
    await Promise.allSettled(activeJobs);
  }
  console.log("Converter worker stopped cleanly.");
}

function startTrackedJob(job: WorkerJob): void {
  let task: Promise<void>;
  task = processJob(job).finally(() => {
    activeJobs.delete(task);
    console.log(
      `Job ${job.id} for ${job.modelSlug} finished; active jobs: ${activeJobs.size}/${config.maxConcurrentJobs}`
    );
  });
  activeJobs.add(task);
  console.log(
    `Job ${job.id} for ${job.modelSlug} started; active jobs: ${activeJobs.size}/${config.maxConcurrentJobs}`
  );
}

function requestShutdown(): void {
  if (shutdownRequested) return;
  shutdownRequested = true;
  console.log(`Worker shutdown requested; active jobs: ${activeJobs.size}/${config.maxConcurrentJobs}`);
}

async function processJob(job: WorkerJob): Promise<void> {
  const quality = resolveSemanticQuality(job.quality, config.quality);
  const nativePreset = nativeQualityPreset(quality);
  const meshiqAdaptiveSmoothing = job.meshiqAdaptiveSmoothing ?? "off";
  console.log(`Processing claimed job ${job.id} for ${job.modelSlug}`);
  console.log(`Job quality: ${quality}; native XCAF preset: ${nativePreset}`);
  console.log(`Job MeshIQ adaptive smoothing: ${meshiqAdaptiveSmoothing}`);
  const controller = new AbortController();
  let monitorStopped = false;
  const monitor = monitorCancellation(job.id, controller, () => monitorStopped);
  try {
    const jobDir = path.join(config.outputDir, job.modelSlug);
    const sourcePath = path.join(jobDir, job.sourceFilename);
    await client.updateProgress(job.id, 10, "Converting - downloading source");
    await client.downloadSource(job, sourcePath, controller.signal);
    console.log(`Downloaded source for ${job.modelSlug}`);

    const output = await convertStepJob({
      slug: job.modelSlug,
      sourcePath,
      outputDir: config.outputDir,
      converterBackend: config.converterBackend,
      converterCli: config.converterCli,
      xcafConverterBin: config.xcafConverterBin,
      xcafColourMode: config.xcafColourMode,
      quality,
      meshiqAdaptiveSmoothing,
      glbOptimizationMode: config.glbOptimizationMode,
      signal: controller.signal,
      onProgress: (percent, label) => client.updateProgress(job.id, percent, label),
      largeStepChunkingMode: config.largeStepChunkingMode,
      largeStepChunkConcurrencyMode: config.largeStepChunkConcurrencyMode,
      largeStepAutoMinFileSizeMb: config.largeStepAutoMinFileSizeMb,
      largeStepAutoPlannerFileSizeMb: config.largeStepAutoPlannerFileSizeMb,
      largeStepAutoPrescanEnabled: config.largeStepAutoPrescanEnabled,
      largeStepForcePlanner: config.largeStepForcePlanner,
      largeStepLeafCountThreshold: config.largeStepLeafCountThreshold,
      largeStepFaceCountThreshold: config.largeStepFaceCountThreshold,
      largeStepWorkScoreThreshold: config.largeStepWorkScoreThreshold,
      largeStepMinExpectedSpeedupFraction: config.largeStepMinExpectedSpeedupFraction,
      largeStepTargetChunks: config.largeStepTargetChunks,
      largeStepAutoMaxTargetChunks: config.largeStepAutoMaxTargetChunks,
      largeStepMinConcurrentChunks: config.largeStepMinConcurrentChunks,
      largeStepInitialConcurrentChunks: config.largeStepInitialConcurrentChunks,
      largeStepMaxConcurrentChunks: config.largeStepMaxConcurrentChunks,
      largeStepResourcePollSeconds: config.largeStepResourcePollSeconds,
      largeStepMaxWorkerMemoryFraction: config.largeStepMaxWorkerMemoryFraction,
      largeStepMinFreeMemoryMb: config.largeStepMinFreeMemoryMb,
      largeStepMaxSwapGrowthMb: config.largeStepMaxSwapGrowthMb,
      largeStepEmergencyMemoryFraction: config.largeStepEmergencyMemoryFraction,
      largeStepScaleUpWarmupSeconds: config.largeStepScaleUpWarmupSeconds,
      largeStepScaleUpCooldownSeconds: config.largeStepScaleUpCooldownSeconds,
      largeStepEstimatedChunkMemoryMb: config.largeStepEstimatedChunkMemoryMb,
      largeStepScaleUpMinFreeAfterReserveMb: config.largeStepScaleUpMinFreeAfterReserveMb,
      largeStepMemoryBasedMaxCapEnabled: config.largeStepMemoryBasedMaxCapEnabled,
      largeStepChunkFallbackMode: config.largeStepChunkFallbackMode
    });

    if (controller.signal.aborted) throw new DOMException("Conversion cancelled.", "AbortError");
    await client.completeJob(job.id, output);
    console.log(`Completed conversion for ${job.modelSlug}`);

    if (!config.keepWorkerOutput) {
      await fs.promises.rm(jobDir, { recursive: true, force: true });
      console.log(`Cleaned worker output for ${job.modelSlug}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown worker error.";
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      console.log(`Job ${job.id} cancelled; native converter termination was requested.`);
      try { await client.acknowledgeCancelled(job.id); } catch (cancelError) {
        console.error(`Could not acknowledge cancellation for job ${job.id}:`, cancelError);
      }
      return;
    }
    console.error(`Job ${job.id} failed: ${message}`);

    try {
      const conversionLogPath = path.join(config.outputDir, job.modelSlug, "conversion.log");
      if (message.includes("exceeded the") && message.includes("display limit")) {
        try {
          if (fs.existsSync(conversionLogPath)) {
            fs.appendFileSync(conversionLogPath, `\n\nERROR: ${message}\n`);
          }
        } catch (appendErr) {
          console.error("Could not append to conversion log:", appendErr);
        }
      }
      await client.failJob(job.id, message, conversionLogPath);
    } catch (failError) {
      const failMessage = failError instanceof Error ? failError.message : "Unknown fail-reporting error.";
      console.error(`Could not report failure for job ${job.id}: ${failMessage}`);
    }
  } finally {
    monitorStopped = true;
    await monitor;
  }
}

async function monitorCancellation(jobId: number, controller: AbortController, stopped: () => boolean): Promise<void> {
  while (!stopped() && !controller.signal.aborted) {
    await sleep(1000);
    if (stopped()) return;
    try {
      const state = await client.getJobState(jobId);
      if (state.cancellationRequested || state.status === "cancelling" || state.status === "cancelled") {
        controller.abort();
        return;
      }
    } catch (error) {
      console.warn(`Could not check cancellation state for job ${jobId}:`, error);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
