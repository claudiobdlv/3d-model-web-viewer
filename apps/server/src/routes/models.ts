import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";
import {
  createJob,
  createModel,
  createRevisionForModel,
  deleteRevisionById,
  deleteModelBySlug,
  getFolderById,
  getModelBySlug,
  getNextRevisionFileVersionNumber,
  getRevisionByLabel,
  getRevisionForModel,
  listModels,
  moveModelToFolder,
  renameModel,
  requestModelCancellation,
  restoreModel,
  saveModelDefaultView,
  trashModel,
  type ModelListOptions,
  getCurrentRevisionForModel,
  listRevisionsForModel,
  markRevisionViewerReady,
  replaceRevisionFileVersion,
  setCurrentRevision,
  setRevisionConversionJob,
  updateRevisionPublicSelectable
} from "../db.js";
import {
  createSlug,
  getLogDir,
  getModelDir,
  getUploadDir,
  getWorkerOutputDir,
  isSafeSlug,
  getRevisionModelDir,
  getRevisionUploadDir,
  getRevisionVersionModelDir,
  getRevisionVersionUploadDir,
  toStorageRelativePath
} from "../storage.js";
import { parseConversionQuality, type ConversionQuality } from "../quality.js";
import { getLargeStepChunkingSummary } from "../utils/largeStepChunkingSummary.js";

const allowedExtensions = new Set([".step", ".stp", ".glb", ".gltf"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 524288000
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedExtensions.has(ext)) {
      cb(new Error("Only .step, .stp, .glb, and .gltf files are accepted."));
      return;
    }
    cb(null, true);
  }
});

export const modelsRouter = express.Router();

modelsRouter.get("/", (req, res) => {
  try {
    const list = listModels(parseListOptions(req.query));
    const listWithSummary = list.map((model) => {
      const summary = getLargeStepChunkingSummary(model.slug, false);
      return summary ? { ...model, largeStepChunkingSummary: summary } : model;
    });
    res.json(listWithSummary);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid list options." });
  }
});

modelsRouter.post("/batch", async (req, res) => {
  const action = req.body?.action;
  const slugs = req.body?.slugs;
  const allowedActions = new Set(["trash", "restore", "deleteForever", "moveToProject"]);
  if (!allowedActions.has(action)) {
    res.status(400).json({ error: "Invalid batch action." });
    return;
  }
  if (!Array.isArray(slugs) || slugs.length < 1 || slugs.length > 100) {
    res.status(400).json({ error: "slugs must contain between 1 and 100 items." });
    return;
  }

  let projectId: number | null = null;
  if (action === "moveToProject") {
    try {
      projectId = parseOptionalFolderId(req.body?.projectId);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid project id." });
      return;
    }
    if (projectId !== null && !getFolderById(projectId)) {
      res.status(400).json({ error: "Project not found." });
      return;
    }
  }

  const updated: string[] = [];
  const failed: Array<{ slug: string; reason: string }> = [];
  for (const value of slugs) {
    const slug = typeof value === "string" ? value : "";
    if (!isSafeSlug(slug)) {
      failed.push({ slug, reason: "Invalid model slug." });
      continue;
    }
    const model = getModelBySlug(slug, true);
    if (!model) {
      failed.push({ slug, reason: "Model not found." });
      continue;
    }

    try {
      if (action === "trash") {
        if (model.deleted_at) throw new Error("Model is already in the recycling bin.");
        trashModel(slug);
        requestModelCancellation(slug);
      } else if (action === "restore") {
        if (!model.deleted_at) throw new Error("Model is not in the recycling bin.");
        restoreModel(slug);
      } else if (action === "moveToProject") {
        if (model.deleted_at) throw new Error("Deleted models cannot be moved.");
        moveModelToFolder(slug, projectId);
      } else {
        if (!model.deleted_at) throw new Error("Model must be in the recycling bin before permanent deletion.");
        await permanentlyDeleteModel(slug);
      }
      updated.push(slug);
    } catch (error) {
      failed.push({ slug, reason: error instanceof Error ? error.message : "Action failed." });
    }
  }

  res.json({ updated, failed });
});

modelsRouter.get("/:slug", (req, res) => {
  const { slug } = req.params;
  if (!isSafeSlug(slug)) {
    res.status(400).json({ error: "Invalid model slug." });
    return;
  }

  const model = getModelBySlug(slug);
  if (!model) {
    res.status(404).json({ error: "Model not found." });
    return;
  }

  const currentRevision = getCurrentRevisionForModel(model.id);
  const revisions = listRevisionsForModel(model.id);
  const modelWithRevisions = {
    ...model,
    currentRevision: currentRevision || null,
    revisions: revisions || []
  };

  const summary = getLargeStepChunkingSummary(slug, true);
  res.json(summary ? { ...modelWithRevisions, largeStepChunkingSummary: summary } : modelWithRevisions);
});

export async function registerModelAndJob({
  sourceFilename,
  sourceExt,
  quality,
  folderId,
  originalSizeBytes,
  saveOriginalFile,
  revisionLabel,
  issuedDate,
  makeCurrent = true,
  allowPublicSelectable = true,
}: {
  sourceFilename: string;
  sourceExt: string;
  quality: ConversionQuality;
  folderId: number | null;
  originalSizeBytes: number;
  saveOriginalFile: (targetPath: string) => void | Promise<void>;
  revisionLabel?: string;
  issuedDate?: string;
  makeCurrent?: boolean;
  allowPublicSelectable?: boolean;
}) {
  const slug = createSlug(sourceFilename);
  const isGlb = sourceExt === ".glb";
  const isStep = sourceExt === ".step" || sourceExt === ".stp";
  const status = isGlb ? "ready" : "uploaded";
  const model = createModel({
    slug,
    name: path.parse(sourceFilename).name,
    sourceFilename,
    sourceExt,
    status,
    hasDisplayGlb: isGlb,
    glbSizeBytes: isGlb ? originalSizeBytes : null,
    originalSizeBytes,
    folderId
  });

  let revisionId: number | null = null;
  try {
    const revision = createRevisionForModel({
      modelId: model.id,
      revisionLabel: revisionLabel || "1",
      issuedDate,
      qualityPreset: quality,
      status,
      sourceFilename,
      sourcePath: (id) => toStorageRelativePath(path.join(getRevisionUploadDir(slug, id), `original${sourceExt}`)),
      displayGlbPath: (id) => toStorageRelativePath(path.join(getRevisionModelDir(slug, id), "display.glb")),
      sourceSizeBytes: originalSizeBytes,
      glbSizeBytes: isGlb ? originalSizeBytes : null,
      isCurrent: makeCurrent ? 1 : 0,
      isPubliclySelectable: allowPublicSelectable ? 1 : 0
    });
    revisionId = revision.id;
    const sourcePath = path.join(getRevisionUploadDir(slug, revision.id), `original${sourceExt}`);
    const modelDir = getRevisionModelDir(slug, revision.id);
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(modelDir, { recursive: true });
    await saveOriginalFile(sourcePath);
    if (isGlb) {
      fs.copyFileSync(sourcePath, path.join(modelDir, "display.glb"));
    }
    writeRevisionManifest(modelDir, {
      slug,
      revisionId: revision.id,
      revisionLabel: revision.revision_label,
      name: model.name,
      sourceFilename,
      sourceExt,
      status,
      quality,
      folderId
    });

    const job = createJob({
      modelId: model.id,
      modelSlug: model.slug,
      revisionId: revision.id,
      type: isStep ? "step-to-glb" : "viewer-ready",
      status,
      quality,
      message: uploadJobMessage(isGlb, isStep)
    });
    setRevisionConversionJob(revision.id, job.id);
    return getModelBySlug(model.slug)!;
  } catch (error) {
    if (revisionId) deleteRevisionById(revisionId);
    deleteModelBySlug(model.slug);
    fs.rmSync(getUploadDir(slug), { recursive: true, force: true });
    fs.rmSync(getModelDir(slug), { recursive: true, force: true });
    throw error;
  }
}

modelsRouter.post("/", upload.single("modelFile"), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).send("No model file was uploaded.");
      return;
    }

    const sourceFilename = path.basename(req.file.originalname);
    const sourceExt = path.extname(sourceFilename).toLowerCase();
    const quality = parseConversionQuality(req.body?.quality);
    const revisionMetadata = parseRevisionMetadata(req.body, true);
    const folderId = parseUploadProjectId(req.body);
    if (folderId !== null && !getFolderById(folderId)) {
      res.status(400).send("Selected project was not found.");
      return;
    }

    const isStep = sourceExt === ".step" || sourceExt === ".stp";
    const isGlb = sourceExt === ".glb" || sourceExt === ".gltf";

    if (isGlb && req.file.size > 262144000) {
      res.status(400).send("GLB/GLTF files must be under 250 MB.");
      return;
    }
    if (isStep && req.file.size > 524288000) {
      res.status(400).send("STEP/STP files must be under 500 MB.");
      return;
    }

    const file = req.file;
    const model = await registerModelAndJob({
      sourceFilename,
      sourceExt,
      quality,
      folderId,
      originalSizeBytes: file.size,
      ...revisionMetadata,
      saveOriginalFile: (targetPath) => {
        fs.writeFileSync(targetPath, file.buffer);
      }
    });

    if (req.accepts(["json", "html"]) === "json") {
      res.status(201).json(model);
      return;
    }

    res.redirect(303, "/admin");
  } catch (error) {
    next(error);
  }
});

modelsRouter.post("/:slug/revisions", upload.fields([{ name: "modelFile", maxCount: 1 }, { name: "file", maxCount: 1 }]), async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    if (!isSafeSlug(slug)) return void res.status(400).json({ error: "Invalid model slug." });
    const model = getModelBySlug(slug);
    if (!model) return void res.status(404).json({ error: "Model not found." });
    const file = getUploadedModelFile(req);
    if (!file) return void res.status(400).json({ error: "No model file was uploaded." });

    const metadata = parseRevisionMetadata(req.body, false);
    const result = await registerRevisionAndJob({
      modelSlug: slug,
      sourceFilename: path.basename(file.originalname),
      quality: parseConversionQuality(req.body?.quality),
      originalSizeBytes: file.size,
      ...metadata,
      saveOriginalFile: (targetPath) => fs.writeFileSync(targetPath, file.buffer)
    });
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

export async function registerRevisionAndJob(input: {
  modelSlug: string;
  sourceFilename: string;
  quality: ConversionQuality;
  originalSizeBytes: number;
  revisionLabel?: string;
  issuedDate?: string;
  makeCurrent?: boolean;
  allowPublicSelectable?: boolean;
  saveOriginalFile: (targetPath: string) => void | Promise<void>;
}) {
  const model = getModelBySlug(input.modelSlug);
  if (!model) throw new Error("Model not found.");
  const previousCurrent = getCurrentRevisionForModel(model.id);
  const sourceExt = path.extname(input.sourceFilename).toLowerCase();
  validateUploadSize(sourceExt, input.originalSizeBytes);
  const revisionLabel = input.revisionLabel?.trim() || undefined;
  if (revisionLabel && getRevisionByLabel(model.id, revisionLabel)) {
    const error = new Error("A revision with this label already exists for the model.");
    (error as Error & { statusCode?: number }).statusCode = 409;
    throw error;
  }
  const isGlb = sourceExt === ".glb";
  const isStep = sourceExt === ".step" || sourceExt === ".stp";
  const status = isGlb ? "ready" : "uploaded";
  let revisionId: number | null = null;
  try {
    const revision = createRevisionForModel({
      modelId: model.id,
      revisionLabel,
      issuedDate: input.issuedDate,
      qualityPreset: input.quality,
      status,
      sourceFilename: input.sourceFilename,
      sourcePath: (id) => toStorageRelativePath(path.join(getRevisionUploadDir(model.slug, id), `original${sourceExt}`)),
      displayGlbPath: (id) => toStorageRelativePath(path.join(getRevisionModelDir(model.slug, id), "display.glb")),
      sourceSizeBytes: input.originalSizeBytes,
      glbSizeBytes: isGlb ? input.originalSizeBytes : null,
      isCurrent: (input.makeCurrent ?? true) ? 1 : 0,
      isPubliclySelectable: (input.allowPublicSelectable ?? true) ? 1 : 0
    });
    revisionId = revision.id;
    const sourcePath = path.join(getRevisionUploadDir(model.slug, revision.id), `original${sourceExt}`);
    const modelDir = getRevisionModelDir(model.slug, revision.id);
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(modelDir, { recursive: true });
    await input.saveOriginalFile(sourcePath);
    if (isGlb) fs.copyFileSync(sourcePath, path.join(modelDir, "display.glb"));
    writeRevisionManifest(modelDir, {
      slug: model.slug, revisionId: revision.id, revisionLabel: revision.revision_label, name: model.name,
      sourceFilename: input.sourceFilename, sourceExt, status, quality: input.quality, folderId: model.folder_id
    });
    const job = createJob({
      modelId: model.id,
      modelSlug: model.slug,
      revisionId: revision.id,
      type: isStep ? "step-to-glb" : "viewer-ready",
      status,
      quality: input.quality,
      message: uploadJobMessage(isGlb, isStep)
    });
    setRevisionConversionJob(revision.id, job.id);
    return { revision: getRevisionForModel(model.id, revision.id), job };
  } catch (error) {
    if (revisionId) {
      deleteRevisionById(revisionId);
      fs.rmSync(getRevisionUploadDir(model.slug, revisionId), { recursive: true, force: true });
      fs.rmSync(getRevisionModelDir(model.slug, revisionId), { recursive: true, force: true });
      if ((input.makeCurrent ?? true) && previousCurrent) {
        setCurrentRevision(model.id, previousCurrent.id);
      }
    }
    throw error;
  }
}

modelsRouter.post("/:slug/revisions/:revisionId/replace", upload.fields([{ name: "modelFile", maxCount: 1 }, { name: "file", maxCount: 1 }]), async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    if (!isSafeSlug(slug)) return void res.status(400).json({ error: "Invalid model slug." });
    const model = getModelBySlug(slug);
    if (!model) return void res.status(404).json({ error: "Model not found." });
    const revisionId = Number(req.params.revisionId);
    if (!Number.isInteger(revisionId) || revisionId < 1) return void res.status(400).json({ error: "Invalid revisionId." });
    if (!getRevisionForModel(model.id, revisionId)) return void res.status(404).json({ error: "Revision not found for model." });
    const file = getUploadedModelFile(req);
    if (!file) return void res.status(400).json({ error: "No model file was uploaded." });

    const sourceFilename = path.basename(file.originalname);
    const sourceExt = path.extname(sourceFilename).toLowerCase();
    validateUploadSize(sourceExt, file.size);
    const quality = parseConversionQuality(req.body?.quality);
    const replacementReason = typeof req.body?.replacementReason === "string"
      ? req.body.replacementReason.trim().slice(0, 2000) || null
      : null;
    const isGlb = sourceExt === ".glb";
    const isStep = sourceExt === ".step" || sourceExt === ".stp";
    const version = getNextRevisionFileVersionNumber(revisionId);
    const uploadDir = getRevisionVersionUploadDir(slug, revisionId, version);
    const modelDir = getRevisionVersionModelDir(slug, revisionId, version);
    let databaseCommitted = false;
    try {
      fs.mkdirSync(uploadDir, { recursive: true });
      fs.mkdirSync(modelDir, { recursive: true });
      const sourcePath = path.join(uploadDir, `original${sourceExt}`);
      fs.writeFileSync(sourcePath, file.buffer);
      if (isGlb) fs.copyFileSync(sourcePath, path.join(modelDir, "display.glb"));
      writeRevisionManifest(modelDir, {
        slug, revisionId, revisionLabel: getRevisionForModel(model.id, revisionId)!.revision_label, name: model.name,
        sourceFilename, sourceExt, status: isGlb ? "ready" : "uploaded", quality, folderId: model.folder_id,
        fileVersionNumber: version
      });
      const replaced = replaceRevisionFileVersion({
        modelId: model.id,
        revisionId,
        sourceFilename,
        sourcePath: () => toStorageRelativePath(sourcePath),
        displayGlbPath: () => toStorageRelativePath(path.join(modelDir, "display.glb")),
        qualityPreset: quality,
        replacementReason,
        sourceSizeBytes: file.size,
        fileVersionNumber: version
      });
      databaseCommitted = true;
      const job = createJob({
        modelId: model.id,
        modelSlug: slug,
        revisionId,
        type: isStep ? "step-to-glb" : "viewer-ready",
        status: isGlb ? "ready" : "uploaded",
        quality,
        message: uploadJobMessage(isGlb, isStep)
      });
      setRevisionConversionJob(revisionId, job.id);
      if (isGlb) {
        markRevisionViewerReady(revisionId, model.id, file.size);
      }
      res.status(201).json({ revision: getRevisionForModel(model.id, revisionId), fileVersion: replaced.fileVersion, job });
    } catch (error) {
      if (!databaseCommitted) {
        fs.rmSync(uploadDir, { recursive: true, force: true });
        fs.rmSync(modelDir, { recursive: true, force: true });
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

modelsRouter.patch("/:slug/revisions/:revisionId/current", (req, res) => {
  const context = getRevisionRouteContext(req.params.slug, req.params.revisionId);
  if ("errorStatus" in context) {
    res.status(context.errorStatus!).json({ error: context.error });
    return;
  }
  res.json(setCurrentRevision(context.model.id, context.revision.id));
});

modelsRouter.patch("/:slug/revisions/:revisionId", (req, res) => {
  const context = getRevisionRouteContext(req.params.slug, req.params.revisionId);
  if ("errorStatus" in context) {
    res.status(context.errorStatus!).json({ error: context.error });
    return;
  }
  const keys = Object.keys(req.body || {});
  if (keys.length !== 1 || keys[0] !== "isPubliclySelectable" || typeof req.body.isPubliclySelectable !== "boolean") {
    res.status(400).json({ error: "Only isPubliclySelectable may be updated, and it must be true or false." });
    return;
  }
  res.json(updateRevisionPublicSelectable(context.model.id, context.revision.id, req.body.isPubliclySelectable));
});

modelsRouter.patch("/:slug", (req, res, next) => {
  try {
    const { slug } = req.params;
    if (!isSafeSlug(slug)) {
      res.status(400).json({ error: "Invalid model slug." });
      return;
    }

    const name = typeof req.body?.name === "string" ? req.body.name : "";
    const model = renameModel(slug, name);
    if (!model) {
      res.status(404).json({ error: "Model not found." });
      return;
    }

    res.json(model);
  } catch (error) {
    next(error);
  }
});

modelsRouter.patch("/:slug/folder", (req, res) => {
  const { slug } = req.params;
  if (!isSafeSlug(slug)) {
    res.status(400).json({ error: "Invalid model slug." });
    return;
  }

  const model = getModelBySlug(slug);
  if (!model) {
    res.status(404).json({ error: "Model not found." });
    return;
  }

  const folderId = parseOptionalFolderId(req.body?.folderId);
  if (folderId !== null && !getFolderById(folderId)) {
    res.status(400).json({ error: "Folder not found." });
    return;
  }

  res.json(moveModelToFolder(slug, folderId));
});

modelsRouter.patch("/:slug/project", (req, res) => {
  const { slug } = req.params;
  if (!isSafeSlug(slug)) {
    res.status(400).json({ error: "Invalid model slug." });
    return;
  }
  if (!getModelBySlug(slug)) {
    res.status(404).json({ error: "Model not found." });
    return;
  }
  const projectId = parseOptionalFolderId(req.body?.projectId);
  if (projectId !== null && !getFolderById(projectId)) {
    res.status(400).json({ error: "Project not found." });
    return;
  }
  res.json(moveModelToFolder(slug, projectId));
});

modelsRouter.post("/:slug/trash", (req, res) => {
  const slug = req.params.slug;
  if (!isSafeSlug(slug)) return void res.status(400).json({ error: "Invalid model slug." });
  const model = getModelBySlug(slug, true);
  if (!model) return void res.status(404).json({ error: "Model not found." });
  if (model.deleted_at) return void res.status(409).json({ error: "Model is already in the recycling bin." });
  trashModel(slug);
  requestModelCancellation(slug);
  res.json(getModelBySlug(slug, true));
});

modelsRouter.post("/:slug/restore", (req, res) => {
  const slug = req.params.slug;
  if (!isSafeSlug(slug)) return void res.status(400).json({ error: "Invalid model slug." });
  const model = getModelBySlug(slug, true);
  if (!model) return void res.status(404).json({ error: "Model not found." });
  if (!model.deleted_at) return void res.status(409).json({ error: "Model is not in the recycling bin." });
  res.json(restoreModel(slug));
});

modelsRouter.delete("/:slug/forever", async (req, res, next) => {
  try {
    const slug = req.params.slug;
    if (!isSafeSlug(slug)) return void res.status(400).json({ error: "Invalid model slug." });
    const model = getModelBySlug(slug, true);
    if (!model) return void res.status(404).json({ error: "Model not found." });
    if (!model.deleted_at) return void res.status(409).json({ error: "Model must be in the recycling bin before permanent deletion." });
    res.json({ ok: true, slug, ...(await permanentlyDeleteModel(slug)) });
  } catch (error) {
    next(error);
  }
});

modelsRouter.post("/:slug/default-view", (req, res, next) => {
  try {
    const { slug } = req.params;
    if (!isSafeSlug(slug)) {
      res.status(400).json({ error: "Invalid model slug." });
      return;
    }

    const model = getModelBySlug(slug);
    if (!model) {
      res.status(404).json({ error: "Model not found." });
      return;
    }

    const { defaultView } = req.body;
    let defaultViewJson: string | null = null;

    if (defaultView !== undefined && defaultView !== null) {
      if (typeof defaultView !== "object") {
        res.status(400).json({ error: "Invalid defaultView format." });
        return;
      }

      const { version, cameraPosition, target, rootQuaternion, fov } = defaultView;

      if (version !== 1) {
        res.status(400).json({ error: "Unsupported view version. Must be 1." });
        return;
      }

      if (!Array.isArray(cameraPosition) || cameraPosition.length !== 3 || !cameraPosition.every(Number.isFinite)) {
        res.status(400).json({ error: "Invalid cameraPosition. Must be an array of 3 finite numbers." });
        return;
      }

      if (!Array.isArray(target) || target.length !== 3 || !target.every(Number.isFinite)) {
        res.status(400).json({ error: "Invalid target. Must be an array of 3 finite numbers." });
        return;
      }

      if (rootQuaternion !== undefined && rootQuaternion !== null) {
        if (!Array.isArray(rootQuaternion) || rootQuaternion.length !== 4 || !rootQuaternion.every(Number.isFinite)) {
          res.status(400).json({ error: "Invalid rootQuaternion. Must be an array of 4 finite numbers." });
          return;
        }

        const [qx, qy, qz, qw] = rootQuaternion;
        const sumSq = qx * qx + qy * qy + qz * qz + qw * qw;
        if (Math.abs(sumSq - 1.0) > 0.05) {
          res.status(400).json({ error: "Invalid rootQuaternion length. Quaternion must be normalizable." });
          return;
        }
      }

      if (fov !== undefined && fov !== null) {
        if (typeof fov !== "number" || !Number.isFinite(fov) || fov < 10 || fov > 90) {
          res.status(400).json({ error: "Invalid fov. Must be a finite number between 10 and 90." });
          return;
        }
      }

      defaultViewJson = JSON.stringify({
        version,
        cameraPosition,
        target,
        rootQuaternion: rootQuaternion || null,
        fov: fov || null
      });
    }

    const updatedModel = saveModelDefaultView(slug, defaultViewJson);
    res.json(updatedModel);
  } catch (error) {
    next(error);
  }
});

modelsRouter.delete("/:slug", async (req, res, next) => {
  try {
    const { slug } = req.params;
    if (!isSafeSlug(slug)) {
      res.status(400).json({ error: "Invalid model slug." });
      return;
    }

    const model = getModelBySlug(slug);
    if (!model) {
      res.status(404).json({ error: "Model not found." });
      return;
    }

    const { deletion, removedPaths } = await permanentlyDeleteModel(slug);

    res.json({
      ok: true,
      slug,
      deletedJobs: deletion.deletedJobs,
      deletedModels: deletion.deletedModels,
      removedPaths
    });
  } catch (error) {
    next(error);
  }
});

async function removeModelFiles(slug: string): Promise<string[]> {
  const directories = [
    getUploadDir(slug),
    getModelDir(slug),
    getLogDir(slug),
    getWorkerOutputDir(slug)
  ];
  const removedPaths: string[] = [];

  for (const directory of directories) {
    if (fs.existsSync(directory)) {
      await fs.promises.rm(directory, { recursive: true, force: true });
      removedPaths.push(directory);
    }
  }

  return removedPaths;
}

async function permanentlyDeleteModel(slug: string) {
  const model = getModelBySlug(slug, true);
  if (!model) return { deletion: { deletedJobs: 0, deletedModels: 0 }, removedPaths: [] };
  const cancellation = requestModelCancellation(slug, true);
  if (cancellation.active > 0) {
    return { deletion: { deletedJobs: 0, deletedModels: 0 }, removedPaths: [], pending: true };
  }
  const removedPaths = await removeModelFiles(slug);
  const deletion = deleteModelBySlug(slug);
  return { deletion, removedPaths };
}

function parseOptionalFolderId(value: unknown): number | null {
  if (value === undefined || value === null || value === "" || value === "null") {
    return null;
  }

  const folderId = Number(value);
  if (!Number.isInteger(folderId) || folderId < 1) {
    throw new Error("Invalid folder id.");
  }

  return folderId;
}

function parseUploadProjectId(body: Record<string, unknown> | undefined): number | null {
  const projectValue = body?.projectId;
  const folderValue = body?.folderId;
  if (projectValue !== undefined && folderValue !== undefined && String(projectValue) !== String(folderValue)) {
    throw new Error("projectId and folderId must match when both are provided.");
  }
  return parseOptionalFolderId(projectValue ?? folderValue);
}

export function parseRevisionMetadata(body: Record<string, unknown> | undefined, firstRevision: boolean): {
  revisionLabel?: string;
  issuedDate?: string;
  makeCurrent: boolean;
  allowPublicSelectable: boolean;
} {
  const rawLabel = body?.revisionLabel;
  if (rawLabel !== undefined && typeof rawLabel !== "string") {
    throw new Error("revisionLabel must be a string.");
  }
  const revisionLabel = typeof rawLabel === "string" ? rawLabel.trim() : "";
  if (revisionLabel.length > 100) throw new Error("revisionLabel must be 100 characters or fewer.");

  const rawIssuedDate = body?.issuedDate;
  if (rawIssuedDate !== undefined && rawIssuedDate !== null && typeof rawIssuedDate !== "string") {
    throw new Error("issuedDate must use YYYY-MM-DD format.");
  }
  const issuedDate = typeof rawIssuedDate === "string" ? rawIssuedDate.trim() : "";
  if (issuedDate && !isValidIssuedDate(issuedDate)) {
    throw new Error("issuedDate must be a valid date in YYYY-MM-DD format.");
  }

  return {
    revisionLabel: revisionLabel || (firstRevision ? "1" : undefined),
    issuedDate: issuedDate || undefined,
    makeCurrent: firstRevision ? true : parseBooleanField(body?.makeCurrent, true, "makeCurrent"),
    allowPublicSelectable: firstRevision
      ? parseBooleanField(body?.allowPublicSelectable, true, "allowPublicSelectable")
      : parseBooleanField(body?.allowPublicSelectable, true, "allowPublicSelectable")
  };
}

function parseBooleanField(value: unknown, fallback: boolean, fieldName: string): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  throw new Error(`${fieldName} must be true or false.`);
}

function isValidIssuedDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function getUploadedModelFile(req: express.Request): Express.Multer.File | undefined {
  const files = req.files as Record<string, Express.Multer.File[] | undefined> | undefined;
  return files?.modelFile?.[0] || files?.file?.[0];
}

function getRevisionRouteContext(slugValue: string, revisionIdValue: string) {
  const slug = String(slugValue);
  if (!isSafeSlug(slug)) return { errorStatus: 400 as const, error: "Invalid model slug." };
  const model = getModelBySlug(slug);
  if (!model) return { errorStatus: 404 as const, error: "Model not found." };
  const revisionId = Number(revisionIdValue);
  if (!Number.isInteger(revisionId) || revisionId < 1) return { errorStatus: 400 as const, error: "Invalid revisionId." };
  const revision = getRevisionForModel(model.id, revisionId);
  if (!revision) return { errorStatus: 404 as const, error: "Revision not found for model." };
  return { model, revision };
}

function validateUploadSize(sourceExt: string, sizeBytes: number): void {
  if (!allowedExtensions.has(sourceExt)) {
    throw new Error("Only .step, .stp, .glb, and .gltf files are accepted.");
  }
  const isStep = sourceExt === ".step" || sourceExt === ".stp";
  const isGlb = sourceExt === ".glb" || sourceExt === ".gltf";
  if (isStep && sizeBytes > 524288000) throw new Error("STEP/STP files must be under 500 MB.");
  if (isGlb && sizeBytes > 262144000) throw new Error("GLB/GLTF files must be under 250 MB.");
}

function uploadJobMessage(isGlb: boolean, isStep: boolean): string {
  return isGlb
    ? "Uploaded GLB is ready for viewing."
    : isStep
      ? "Uploaded source model is queued for conversion."
      : "Uploaded GLTF source is stored without conversion.";
}

function writeRevisionManifest(modelDir: string, input: {
  slug: string;
  revisionId: number;
  revisionLabel: string;
  name: string;
  sourceFilename: string;
  sourceExt: string;
  status: string;
  quality: ConversionQuality;
  folderId: number | null;
  fileVersionNumber?: number;
}): void {
  const manifest = {
    ...input,
    displayFile: input.status === "ready" ? "display.glb" : null,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(modelDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function parseListOptions(query: express.Request["query"]) {
  const allowedViews = new Set(["all", "unsorted", "recycling"]);
  const allowedSorts = new Set(["name", "status", "created_at", "updated_at", "glb_size_bytes", "original_size_bytes", "project"]);
  const viewValue = typeof query.view === "string" ? query.view : undefined;
  const legacyFolder = typeof query.folder === "string" ? query.folder : undefined;
  const view = viewValue ?? (legacyFolder === "unsorted" ? "unsorted" : "all");
  if (!allowedViews.has(view)) throw new Error("Invalid view.");

  const projectValue = typeof query.projectId === "string" ? query.projectId : legacyFolder !== "unsorted" ? legacyFolder : undefined;
  let projectId: number | undefined;
  if (projectValue !== undefined) {
    projectId = Number(projectValue);
    if (!Number.isInteger(projectId) || projectId < 1) throw new Error("Invalid project id.");
  }
  const sortBy = typeof query.sortBy === "string" ? query.sortBy : "created_at";
  const sortDir = typeof query.sortDir === "string" ? query.sortDir : "desc";
  if (!allowedSorts.has(sortBy)) throw new Error("Invalid sortBy.");
  if (sortDir !== "asc" && sortDir !== "desc") throw new Error("Invalid sortDir.");
  const q = typeof query.q === "string" ? query.q.trim().slice(0, 200) : undefined;
  return {
    view: view as NonNullable<ModelListOptions["view"]>,
    projectId,
    q,
    sortBy: sortBy as NonNullable<ModelListOptions["sortBy"]>,
    sortDir: sortDir as NonNullable<ModelListOptions["sortDir"]>
  };
}
