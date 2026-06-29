import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import multer from "multer";
import { getFolderById, getModelBySlug } from "../db.js";
import { chunkedUploadsRoot } from "../storage.js";
import { parseRevisionMetadata, registerModelAndJob, registerRevisionAndJob } from "./models.js";
import { parseConversionQuality } from "../quality.js";
import { parseMeshiqAdaptiveSmoothing } from "../meshiq.js";
import {
  authorizeRole,
  authorizeModelAccess,
  authorizeUploadHandle,
  UPLOAD_ROLE,
  type AccessResult
} from "../auth/index.js";

// Send the standard JSON error for a failed authorization result. Returns true
// when the response was sent (caller stops), false when access is allowed.
function denied(res: express.Response, access: AccessResult): boolean {
  if (access.ok) return false;
  res.status(access.status).json({ error: access.error });
  return true;
}

const MAX_UPLOAD_BYTES = 524288000;       // 500 MB
const MAX_UPLOAD_CHUNK_BYTES = 52428800; // 50 MB
const MAX_GLB_BYTES = 262144000;         // 250 MB

const allowedExtensions = new Set([".step", ".stp", ".glb", ".gltf"]);
const uuidRegex = /^[a-f0-9-]{36}$/;

/**
 * Memory Tradeoff Documentation:
 * We use multer's memoryStorage for single-chunk uploads.
 * Since chunks are uploaded sequentially by the client and limited to strictly 50 MB,
 * the peak memory usage per request is capped at 50 MB.
 * The chunk is immediately written to disk upon receipt, releasing the memory.
 */
const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_CHUNK_BYTES + 1024 * 1024
  }
});

export const uploadsRouter = express.Router();

// Helper to parse optional project folder ID
function parseProjectId(value: unknown): number | null {
  if (value === undefined || value === null || value === "" || value === "null") {
    return null;
  }
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) {
    throw new Error("Invalid project ID.");
  }
  return id;
}

// Initialize a chunked upload
uploadsRouter.post("/init", (req, res) => {
  try {
    const { filename, sizeBytes, projectId, quality, meshiqAdaptiveSmoothing, modelSlug } = req.body || {};

    // Starting an upload (new model or new revision) requires member+ (finding 6).
    if (denied(res, authorizeRole(req, UPLOAD_ROLE))) return;

    if (typeof filename !== "string" || !filename) {
      res.status(400).json({ error: "filename is required." });
      return;
    }

    const cleanFilename = path.basename(filename);
    const ext = path.extname(cleanFilename).toLowerCase();
    if (!allowedExtensions.has(ext)) {
      res.status(400).json({ error: "Only .step, .stp, .glb, and .gltf files are accepted." });
      return;
    }

    const size = Number(sizeBytes);
    if (!Number.isInteger(size) || size <= 0) {
      res.status(400).json({ error: "sizeBytes must be a positive integer." });
      return;
    }

    const isStep = ext === ".step" || ext === ".stp";
    const isGlb = ext === ".glb" || ext === ".gltf";

    if (isStep && size > MAX_UPLOAD_BYTES) {
      res.status(400).json({ error: "STEP/STP files must be under 500 MB." });
      return;
    }
    if (isGlb && size > MAX_GLB_BYTES) {
      res.status(400).json({ error: "GLB/GLTF files must be under 250 MB." });
      return;
    }

    let parsedFolderId: number | null = null;
    try {
      parsedFolderId = parseProjectId(projectId);
    } catch {
      res.status(400).json({ error: "Invalid project ID format." });
      return;
    }

    if (parsedFolderId !== null && req.authEnabled) {
      res.status(403).json({ error: "Projects are not available in workspace mode." });
      return;
    }
    if (parsedFolderId !== null && !getFolderById(parsedFolderId)) {
      res.status(400).json({ error: "Selected project was not found." });
      return;
    }

    let parsedQuality: ReturnType<typeof parseConversionQuality>;
    let parsedMeshiqAdaptiveSmoothing: ReturnType<typeof parseMeshiqAdaptiveSmoothing>;
    try {
      parsedQuality = parseConversionQuality(quality);
      parsedMeshiqAdaptiveSmoothing = parseMeshiqAdaptiveSmoothing(meshiqAdaptiveSmoothing);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid upload options." });
      return;
    }
    const existingModelSlug = typeof modelSlug === "string" ? modelSlug.trim() : "";
    if (existingModelSlug) {
      // A revision upload must target a model in the caller's workspace (finding 6).
      const targetModel = getModelBySlug(existingModelSlug);
      if (denied(res, authorizeModelAccess(req, targetModel, UPLOAD_ROLE))) return;
    }
    const revisionMetadata = parseRevisionMetadata(req.body, !existingModelSlug);

    const uploadId = crypto.randomUUID();
    const uploadDir = path.join(chunkedUploadsRoot, uploadId);
    fs.mkdirSync(uploadDir, { recursive: true });

    const totalChunks = Math.ceil(size / MAX_UPLOAD_CHUNK_BYTES);
    if (totalChunks < 1 || totalChunks > 10) {
      res.status(400).json({ error: "Invalid file size or chunk size combination." });
      return;
    }

    const metadata = {
      uploadId,
      filename: cleanFilename,
      sizeBytes: size,
      projectId: parsedFolderId,
      quality: parsedQuality,
      meshiqAdaptiveSmoothing: parsedMeshiqAdaptiveSmoothing,
      modelSlug: existingModelSlug || null,
      revisionLabel: revisionMetadata.revisionLabel,
      issuedDate: revisionMetadata.issuedDate,
      makeCurrent: revisionMetadata.makeCurrent,
      allowPublicSelectable: revisionMetadata.allowPublicSelectable,
      organizationId: req.auth?.organization?.id ?? null,
      createdByUserId: req.auth?.user?.id ?? null,
      totalChunks,
      chunkSizeBytes: MAX_UPLOAD_CHUNK_BYTES,
      createdAt: new Date().toISOString()
    };

    fs.writeFileSync(path.join(uploadDir, "metadata.json"), JSON.stringify(metadata, null, 2));

    console.info("chunked_upload_init", {
      uploadId,
      sizeBytes: size,
      totalChunks,
      projectId: parsedFolderId,
      quality: parsedQuality,
      meshiqAdaptiveSmoothing: parsedMeshiqAdaptiveSmoothing
    });

    res.status(201).json({
      uploadId,
      chunkSizeBytes: MAX_UPLOAD_CHUNK_BYTES,
      maxUploadBytes: MAX_UPLOAD_BYTES
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error." });
  }
});

// Receive a chunk
uploadsRouter.post("/:uploadId/chunk", chunkUpload.single("chunk"), (req, res) => {
  try {
    const uploadId = String(req.params.uploadId);
    if (!uuidRegex.test(uploadId)) {
      res.status(400).json({ error: "Invalid uploadId format." });
      return;
    }

    const uploadDir = path.join(chunkedUploadsRoot, uploadId);
    const metadataPath = path.join(uploadDir, "metadata.json");
    if (!fs.existsSync(metadataPath)) {
      res.status(404).json({ error: "Upload not found or expired." });
      return;
    }

    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    // Only the session/org that created the handle may push chunks to it (finding 6).
    if (denied(res, authorizeUploadHandle(req, metadata))) return;

    const chunkIndex = Number(typeof req.query.chunkIndex === "string" ? req.query.chunkIndex : "");
    const totalChunks = Number(typeof req.query.totalChunks === "string" ? req.query.totalChunks : "");

    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= metadata.totalChunks) {
      res.status(400).json({ error: "Invalid chunkIndex." });
      return;
    }

    if (totalChunks !== metadata.totalChunks) {
      res.status(400).json({ error: "Mismatched totalChunks." });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: "No chunk file provided." });
      return;
    }

    // Double check chunk size limit
    if (req.file.size > MAX_UPLOAD_CHUNK_BYTES) {
      res.status(400).json({ error: "Chunk exceeds max chunk size limit." });
      return;
    }

    // Write chunk directly to disk
    const chunkPath = path.join(uploadDir, `chunk-${chunkIndex}`);
    fs.writeFileSync(chunkPath, req.file.buffer);

    console.info("chunked_upload_chunk", { uploadId, chunkIndex, totalChunks, sizeBytes: req.file.size });

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error." });
  }
});

// Complete the chunked upload
uploadsRouter.post("/:uploadId/complete", async (req, res, next) => {
  try {
    const uploadId = String(req.params.uploadId);
    if (!uuidRegex.test(uploadId)) {
      res.status(400).json({ error: "Invalid uploadId format." });
      return;
    }

    const uploadDir = path.join(chunkedUploadsRoot, uploadId);
    const metadataPath = path.join(uploadDir, "metadata.json");
    if (!fs.existsSync(metadataPath)) {
      res.status(404).json({ error: "Upload not found or expired." });
      return;
    }

    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    // The completing session/org must own the handle (finding 6).
    if (denied(res, authorizeUploadHandle(req, metadata))) return;
    if (denied(res, authorizeRole(req, UPLOAD_ROLE))) return;
    // Re-verify revision target ownership at completion: a revision upload must
    // still resolve to a model in the caller's workspace.
    if (typeof metadata.modelSlug === "string" && metadata.modelSlug) {
      const targetModel = getModelBySlug(metadata.modelSlug);
      if (denied(res, authorizeModelAccess(req, targetModel, UPLOAD_ROLE))) return;
    }

    // Verify all chunks exist
    let assembledSize = 0;
    for (let i = 0; i < metadata.totalChunks; i++) {
      const chunkPath = path.join(uploadDir, `chunk-${i}`);
      if (!fs.existsSync(chunkPath)) {
        res.status(400).json({ error: `Missing chunk ${i}.` });
        return;
      }
      assembledSize += fs.statSync(chunkPath).size;
    }

    // Verify assembled size equals expected size
    if (assembledSize !== metadata.sizeBytes) {
      res.status(400).json({ error: `Assembled size (${assembledSize}) does not match expected size (${metadata.sizeBytes}).` });
      return;
    }

    // Stream assembly of chunks to avoid memory accumulation
    const assembledPath = path.join(uploadDir, "assembled.bin");
    const writeStream = fs.createWriteStream(assembledPath);

    for (let i = 0; i < metadata.totalChunks; i++) {
      const chunkPath = path.join(uploadDir, `chunk-${i}`);
      const readStream = fs.createReadStream(chunkPath);
      readStream.pipe(writeStream, { end: false });
      await new Promise<void>((resolve, reject) => {
        readStream.on("end", resolve);
        readStream.on("error", reject);
      });
    }

    writeStream.end();
    await new Promise<void>((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });

    // Create normal model/job using the existing upload pipeline
    const model = metadata.modelSlug
      ? await registerRevisionAndJob({
          modelSlug: metadata.modelSlug,
          sourceFilename: metadata.filename,
          quality: metadata.quality,
          meshiqAdaptiveSmoothing: metadata.meshiqAdaptiveSmoothing,
          originalSizeBytes: metadata.sizeBytes,
          revisionLabel: metadata.revisionLabel,
          issuedDate: metadata.issuedDate,
          makeCurrent: metadata.makeCurrent,
          allowPublicSelectable: metadata.allowPublicSelectable,
          saveOriginalFile: (targetPath) => fs.renameSync(assembledPath, targetPath)
        })
      : await registerModelAndJob({
          sourceFilename: metadata.filename,
          sourceExt: path.extname(metadata.filename).toLowerCase(),
          quality: metadata.quality,
          meshiqAdaptiveSmoothing: metadata.meshiqAdaptiveSmoothing,
          folderId: metadata.projectId,
          originalSizeBytes: metadata.sizeBytes,
          organizationId: metadata.organizationId ?? null,
          createdByUserId: metadata.createdByUserId ?? null,
          revisionLabel: metadata.revisionLabel,
          issuedDate: metadata.issuedDate,
          makeCurrent: metadata.makeCurrent,
          allowPublicSelectable: metadata.allowPublicSelectable,
          saveOriginalFile: (targetPath) => fs.renameSync(assembledPath, targetPath)
        });

    // Clean up all chunks and directory
    fs.rmSync(uploadDir, { recursive: true, force: true });

    console.info("chunked_upload_complete", { uploadId, modelSlug: metadata.modelSlug || (model as any).slug, sizeBytes: metadata.sizeBytes, totalChunks: metadata.totalChunks });

    res.status(201).json(model);
  } catch (error) {
    next(error);
  }
});

// Cancel chunked upload
uploadsRouter.delete("/:uploadId", (req, res) => {
  try {
    const uploadId = String(req.params.uploadId);
    if (!uuidRegex.test(uploadId)) {
      res.status(400).json({ error: "Invalid uploadId format." });
      return;
    }

    const uploadDir = path.join(chunkedUploadsRoot, uploadId);
    const metadataPath = path.join(uploadDir, "metadata.json");
    // Only the owning session/org may cancel a handle (finding 6). A valid handle
    // always has metadata (written during init before the id is returned).
    if (fs.existsSync(metadataPath)) {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      if (denied(res, authorizeUploadHandle(req, metadata))) return;
    }
    if (fs.existsSync(uploadDir)) {
      fs.rmSync(uploadDir, { recursive: true, force: true });
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error." });
  }
});
