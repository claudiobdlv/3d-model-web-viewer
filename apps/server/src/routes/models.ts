import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";
import {
  createJob,
  createModel,
  getModelBySlug,
  listModels
} from "../db.js";
import {
  createSlug,
  getModelDir,
  getUploadDir,
  isSafeSlug
} from "../storage.js";

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

modelsRouter.get("/", (_req, res) => {
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
  const slug = createSlug(sourceFilename);
  const uploadDir = getUploadDir(slug);
  const modelDir = getModelDir(slug);

  fs.mkdirSync(uploadDir, { recursive: true });
  fs.mkdirSync(modelDir, { recursive: true });

  const sourcePath = path.join(uploadDir, `original${sourceExt}`);
  fs.writeFileSync(sourcePath, req.file.buffer);

  const isGlb = sourceExt === ".glb";
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
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(modelDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const model = createModel({
    slug,
    name: manifest.name,
    sourceFilename,
    sourceExt,
    status,
    hasDisplayGlb: isGlb
  });

  createJob({
    modelId: model.id,
    modelSlug: model.slug,
    type: sourceExt === ".glb" ? "viewer-ready" : "step-to-glb",
    status,
    message: isGlb
      ? "Uploaded GLB is ready for viewing."
      : "Uploaded source model is queued for conversion."
  });

  res.redirect(303, "/");
});
