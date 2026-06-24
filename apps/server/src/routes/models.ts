import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";
import {
  createJob,
  createModel,
  deleteModelBySlug,
  getFolderById,
  getModelBySlug,
  listModels,
  moveModelToFolder,
  renameModel,
  requestModelCancellation,
  restoreModel,
  saveModelDefaultView,
  trashModel,
  type ModelListOptions,
  getCurrentRevisionForModel,
  listRevisionsForModel
} from "../db.js";
import {
  createSlug,
  getLogDir,
  getModelDir,
  getUploadDir,
  getWorkerOutputDir,
  isSafeSlug
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
}: {
  sourceFilename: string;
  sourceExt: string;
  quality: ConversionQuality;
  folderId: number | null;
  originalSizeBytes: number;
  saveOriginalFile: (targetPath: string) => void | Promise<void>;
}) {
  const slug = createSlug(sourceFilename);
  const uploadDir = getUploadDir(slug);
  const modelDir = getModelDir(slug);

  fs.mkdirSync(uploadDir, { recursive: true });
  fs.mkdirSync(modelDir, { recursive: true });

  const sourcePath = path.join(uploadDir, `original${sourceExt}`);
  await saveOriginalFile(sourcePath);

  const isGlb = sourceExt === ".glb";
  const isStep = sourceExt === ".step" || sourceExt === ".stp";
  if (isGlb) {
    fs.copyFileSync(sourcePath, path.join(modelDir, "display.glb"));
  }

  const status = isGlb ? "ready" : "uploaded";
  const manifest = {
    slug,
    name: path.parse(sourceFilename).name,
    sourceFilename,
    sourceExt,
    status,
    displayFile: isGlb ? "display.glb" : null,
    quality: isStep ? quality : undefined,
    folderId,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(modelDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const model = createModel({
    slug,
    name: manifest.name,
    sourceFilename,
    sourceExt,
    status,
    hasDisplayGlb: isGlb,
    glbSizeBytes: isGlb ? originalSizeBytes : null,
    originalSizeBytes,
    folderId
  });

  createJob({
    modelId: model.id,
    modelSlug: model.slug,
    type: isStep ? "step-to-glb" : "viewer-ready",
    status,
    quality,
    message: isGlb
      ? "Uploaded GLB is ready for viewing."
      : isStep
        ? "Uploaded source model is queued for conversion."
        : "Uploaded GLTF source is stored without conversion."
  });

  return model;
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
