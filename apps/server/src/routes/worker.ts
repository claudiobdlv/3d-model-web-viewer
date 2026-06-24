import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";
import {
  getJobForWorker,
  claimNextWorkerJob,
  markJobFailed,
  markJobCancelled,
  markJobProcessing,
  markJobReady,
  updateJobProgress,
  deleteModelBySlug,
  getRevisionById
} from "../db.js";
import {
  getLogDir,
  getModelDir,
  getUploadDir,
  getWorkerOutputDir,
  isSafeSlug,
  getRevisionModelDir,
  getRevisionLogDir,
  resolveSourcePath,
  resolveDisplayGlbPath
} from "../storage.js";
import { workerJobPayload } from "../workerPayload.js";

const developmentWorkerToken = "dev-worker-token";
const workerToken = process.env.WORKER_API_TOKEN || developmentWorkerToken;
const defaultMaxModelArtifactBytes = 262144000;
const maxModelArtifactBytes = readPositiveInteger(
  process.env.MAX_MODEL_ARTIFACT_BYTES,
  defaultMaxModelArtifactBytes,
  "MAX_MODEL_ARTIFACT_BYTES"
);

if (!process.env.WORKER_API_TOKEN) {
  console.warn(
    "WORKER_API_TOKEN is not set. Worker API is using the default development token; set WORKER_API_TOKEN for deployed environments."
  );
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    // Converted GLBs can be substantially larger than their STEP sources.
    fileSize: maxModelArtifactBytes
  }
});

const failureUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024
  }
});

export const workerRouter = express.Router();

workerRouter.use((req, res, next) => {
  const expectedHeader = `Bearer ${workerToken}`;
  if (req.header("authorization") !== expectedHeader) {
    res.status(401).json({ error: "Worker API token is missing or invalid." });
    return;
  }

  next();
});

workerRouter.get("/jobs/next", (_req, res) => {
  const job = claimNextWorkerJob();
  if (!job) {
    res.json({ job: null });
    return;
  }

  res.json({
    job: workerJobPayload(job)
  });
});

workerRouter.post("/jobs/:jobId/start", (req, res) => {
  const jobId = Number(req.params.jobId);
  const job = getValidStepJob(jobId);
  if (!job) {
    res.status(404).json({ error: "Worker job not found." });
    return;
  }

  if (job.status !== "uploaded" && job.status !== "queued") {
    res.status(409).json({ error: `Worker job is already ${job.status}.` });
    return;
  }

  markJobProcessing(job.id);
  res.json({ ok: true });
});

workerRouter.get("/jobs/:jobId/source", (req, res) => {
  const jobId = Number(req.params.jobId);
  const job = getValidStepJob(jobId);
  if (!job) {
    res.status(404).json({ error: "Worker job not found." });
    return;
  }

  const revision = job.revision_id ? getRevisionById(job.revision_id) : null;
  const sourcePath = resolveSourcePath({ slug: job.model_slug, source_ext: job.source_ext }, revision);

  if (!fs.existsSync(sourcePath)) {
    res.status(404).json({ error: "Source file not found." });
    return;
  }

  res.download(sourcePath, job.source_filename);
});

workerRouter.get("/jobs/:jobId/state", (req, res) => {
  const job = getValidStepJob(Number(req.params.jobId));
  if (!job) return void res.status(404).json({ error: "Worker job not found." });
  res.json({ status: job.status, cancellationRequested: Boolean(job.cancellation_requested_at) });
});

workerRouter.post("/jobs/:jobId/progress", (req, res) => {
  const job = getValidStepJob(Number(req.params.jobId));
  const percent = Number(req.body?.percent);
  const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
  if (!job) return void res.status(404).json({ error: "Worker job not found." });
  if (!Number.isFinite(percent) || !label) return void res.status(400).json({ error: "percent and label are required." });
  if (!updateJobProgress(job.id, percent, label)) return void res.status(409).json({ error: "Job is no longer active." });
  res.json({ ok: true });
});

workerRouter.post("/jobs/:jobId/cancelled", async (req, res, next) => {
  try {
    const job = getValidStepJob(Number(req.params.jobId));
    if (!job) return void res.status(404).json({ error: "Worker job not found." });
    const model = markJobCancelled(job.id);
    if (model?.pending_delete_at) {
      await Promise.all([getUploadDir(model.slug), getModelDir(model.slug), getLogDir(model.slug), getWorkerOutputDir(model.slug)]
        .map((directory) => fs.promises.rm(directory, { recursive: true, force: true })));
      deleteModelBySlug(model.slug);
    }
    res.json({ ok: true, status: "cancelled" });
  } catch (error) { next(error); }
});

workerRouter.post(
  "/jobs/:jobId/complete",
  upload.fields([
    { name: "display.glb", maxCount: 1 },
    { name: "displayGlb", maxCount: 1 },
    { name: "manifest.json", maxCount: 1 },
    { name: "manifest", maxCount: 1 },
    { name: "stats.json", maxCount: 1 },
    { name: "stats", maxCount: 1 },
    { name: "material-debug.json", maxCount: 1 },
    { name: "materialDebug", maxCount: 1 },
    { name: "xcaf-report.json", maxCount: 1 },
    { name: "xcafReport", maxCount: 1 },
    { name: "conversion.log", maxCount: 1 },
    { name: "conversionLog", maxCount: 1 }
  ]),
  (req, res) => {
    const jobId = Number(req.params.jobId);
    const job = getValidStepJob(jobId);
    if (!job) {
      res.status(404).json({ error: "Worker job not found." });
      return;
    }
    if (job.status !== "processing" || job.cancellation_requested_at) {
      res.status(409).json({ error: "Job was cancelled and cannot publish artifacts." });
      return;
    }

    const files = req.files as Record<string, Express.Multer.File[] | undefined>;
    const displayGlb = firstFile(files, "display.glb", "displayGlb");
    if (!displayGlb) {
      res.status(400).json({ error: "display.glb upload is required." });
      return;
    }

    const modelDir = job.revision_id
      ? getRevisionModelDir(job.model_slug, job.revision_id)
      : getModelDir(job.model_slug);
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, "display.glb"), displayGlb.buffer);

    const manifest = firstFile(files, "manifest.json", "manifest");
    if (manifest) {
      fs.writeFileSync(path.join(modelDir, "manifest.json"), manifest.buffer);
    }

    const stats = firstFile(files, "stats.json", "stats");
    if (stats) {
      fs.writeFileSync(path.join(modelDir, "stats.json"), stats.buffer);
    }

    const materialDebug = firstFile(files, "material-debug.json", "materialDebug");
    if (materialDebug) {
      fs.writeFileSync(path.join(modelDir, "material-debug.json"), materialDebug.buffer);
    }

    const xcafReport = firstFile(files, "xcaf-report.json", "xcafReport");
    if (xcafReport) {
      fs.writeFileSync(path.join(modelDir, "xcaf-report.json"), xcafReport.buffer);
    }

    const conversionLog = firstFile(files, "conversion.log", "conversionLog");
    if (conversionLog) {
      const logDir = job.revision_id
        ? getRevisionLogDir(job.model_slug, job.revision_id)
        : getLogDir(job.model_slug);
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, "conversion.log"), conversionLog.buffer);
    }

    if (!markJobReady(job.id, "Worker completed STEP/STP conversion.", displayGlb.size)) {
      fs.rmSync(modelDir, { recursive: true, force: true });
      const logDir = job.revision_id
        ? getRevisionLogDir(job.model_slug, job.revision_id)
        : getLogDir(job.model_slug);
      fs.rmSync(logDir, { recursive: true, force: true });
      res.status(409).json({ error: "Job was cancelled while artifacts were being received; artifacts were discarded." });
      return;
    }
    res.json({ ok: true, status: "ready" });
  }
);

workerRouter.post("/jobs/:jobId/fail", failureUpload.single("conversion.log"), (req, res) => {
  const jobId = Number(req.params.jobId);
  const job = getValidStepJob(jobId);
  if (!job) {
    res.status(404).json({ error: "Worker job not found." });
    return;
  }

  const message =
    typeof req.body?.message === "string" && req.body.message.trim()
      ? req.body.message.trim().slice(0, 2000)
      : "Worker failed without an error message.";

  if (req.file) {
    const logDir = job.revision_id
      ? getRevisionLogDir(job.model_slug, job.revision_id)
      : getLogDir(job.model_slug);
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, "conversion.log"), req.file.buffer);
  }

  if (job.cancellation_requested_at || job.status === "cancelling") {
    markJobCancelled(job.id, `Cancelled: ${message}`);
    res.json({ ok: true, status: "cancelled" });
    return;
  }
  markJobFailed(job.id, message);
  res.json({ ok: true, status: "failed" });
});

function firstFile(
  files: Record<string, Express.Multer.File[] | undefined>,
  ...fieldNames: string[]
): Express.Multer.File | undefined {
  for (const fieldName of fieldNames) {
    const file = files[fieldName]?.[0];
    if (file) {
      return file;
    }
  }

  return undefined;
}

function getValidStepJob(jobId: number) {
  if (!Number.isInteger(jobId) || jobId < 1) {
    return undefined;
  }

  const job = getJobForWorker(jobId);
  if (!job || !isSafeSlug(job.model_slug) || ![".step", ".stp"].includes(job.source_ext)) {
    return undefined;
  }

  return job;
}

function readPositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer number of bytes.`);
  }
  return parsed;
}
