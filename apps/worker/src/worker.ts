import path from "node:path";
import fs from "node:fs";
import { WorkerClient, type WorkerJob } from "./client.js";
import { loadConfig } from "./config.js";
import { convertStepJob } from "./converterProcessor.js";

const config = loadConfig();
const client = new WorkerClient(config);

console.log(`Converter worker starting against ${config.serverUrl}`);
console.log(`Poll interval: ${config.pollIntervalMs / 1000}s`);
console.log(`Output dir: ${config.outputDir}`);
console.log(`Converter backend: ${config.converterBackend}`);
console.log(`Converter CLI: ${config.converterCli}`);
console.log(`XCAF converter binary: ${config.xcafConverterBin}`);
console.log(`Converter quality: ${config.quality}`);
if (config.converterBackend === "xcaf-baseline") {
  console.log(`XCAF colour mode: ${config.xcafColourMode}`);
} else {
  console.log(`Material rules mode: ${process.env.MATERIAL_RULES_MODE || "fallback"}`);
}
console.log(`Keep worker output: ${config.keepWorkerOutput}`);
console.log(`Run once: ${config.runOnce}`);

while (true) {
  await pollOnce();
  if (config.runOnce) {
    break;
  }

  await sleep(config.pollIntervalMs);
}

async function pollOnce(): Promise<boolean> {
  const job = await client.getNextJob();
  if (!job) {
    console.log("No pending worker job.");
    return false;
  }

  await processJob(job);
  return true;
}

async function processJob(job: WorkerJob): Promise<void> {
  console.log(`Processing job ${job.id} for ${job.modelSlug}`);
  try {
    await client.startJob(job.id);

    const jobDir = path.join(config.outputDir, job.modelSlug);
    const sourcePath = path.join(jobDir, job.sourceFilename);
    await client.downloadSource(job, sourcePath);
    console.log(`Downloaded source for ${job.modelSlug}`);

    const output = await convertStepJob({
      slug: job.modelSlug,
      sourcePath,
      outputDir: config.outputDir,
      converterBackend: config.converterBackend,
      converterCli: config.converterCli,
      xcafConverterBin: config.xcafConverterBin,
      xcafColourMode: config.xcafColourMode,
      quality: config.quality
    });

    await client.completeJob(job.id, output);
    console.log(`Completed conversion for ${job.modelSlug}`);

    if (!config.keepWorkerOutput) {
      await fs.promises.rm(jobDir, { recursive: true, force: true });
      console.log(`Cleaned worker output for ${job.modelSlug}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown worker error.";
    console.error(`Job ${job.id} failed: ${message}`);

    try {
      const conversionLogPath = path.join(config.outputDir, job.modelSlug, "conversion.log");
      await client.failJob(job.id, message, conversionLogPath);
    } catch (failError) {
      const failMessage = failError instanceof Error ? failError.message : "Unknown fail-reporting error.";
      console.error(`Could not report failure for job ${job.id}: ${failMessage}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
