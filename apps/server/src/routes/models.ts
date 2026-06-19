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
  saveModelDefaultView
} from "../db.js";
import {
  createSlug,
  getLogDir,
  getModelDir,
  getUploadDir,
  getWorkerOutputDir,
  isSafeSlug
} from "../storage.js";
import { parseConversionQuality } from "../quality.js";

const allowedExtensions = new Set([".step", ".stp", ".glb", ".gltf"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 250 * 1024 * 1024
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
  const folder = typeof req.query.folder === "string" ? req.query.folder : undefined;
  if (folder === "unsorted") {
    res.json(listModels({ unsortedOnly: true }));
    return;
  }

  if (folder) {
    const folderId = Number(folder);
    if (!Number.isInteger(folderId) || folderId < 1) {
      res.status(400).json({ error: "Invalid folder id." });
      return;
    }
    res.json(listModels({ folderId }));
    return;
  }

  res.json(listModels());
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

  res.json(model);
});

modelsRouter.post("/", upload.single("modelFile"), (req, res) => {
  if (!req.file) {
    res.status(400).send("No model file was uploaded.");
    return;
  }

  const sourceFilename = path.basename(req.file.originalname);
  const sourceExt = path.extname(sourceFilename).toLowerCase();
  const quality = parseConversionQuality(req.body?.quality);
  const folderId = parseOptionalFolderId(req.body?.folderId);
  if (folderId !== null && !getFolderById(folderId)) {
    res.status(400).send("Selected folder was not found.");
    return;
  }
  const slug = createSlug(sourceFilename);
  const uploadDir = getUploadDir(slug);
  const modelDir = getModelDir(slug);

  fs.mkdirSync(uploadDir, { recursive: true });
  fs.mkdirSync(modelDir, { recursive: true });

  const sourcePath = path.join(uploadDir, `original${sourceExt}`);
  fs.writeFileSync(sourcePath, req.file.buffer);

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
    glbSizeBytes: isGlb ? req.file.size : null,
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

  if (req.accepts(["json", "html"]) === "json") {
    res.status(201).json(model);
    return;
  }

  res.redirect(303, "/admin");
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

    const deletion = deleteModelBySlug(slug);
    const removedPaths = await removeModelFiles(slug);

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
