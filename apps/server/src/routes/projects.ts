import express from "express";
import {
  createFolder,
  deleteFolderIfEmpty,
  getFolderById,
  listFolders,
  renameFolder
} from "../db.js";

export const projectsRouter = express.Router();

projectsRouter.get("/", (_req, res) => {
  res.json(listFolders().map(toProject));
});

projectsRouter.post("/", (req, res, next) => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name : "";
    res.status(201).json(toProject(createFolder({ name })));
  } catch (error) {
    next(error);
  }
});

projectsRouter.patch("/:projectId", (req, res, next) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const name = typeof req.body?.name === "string" ? req.body.name : "";
    const project = renameFolder(projectId, name);
    if (!project) return void res.status(404).json({ error: "Project not found." });
    res.json(toProject(project));
  } catch (error) {
    next(error);
  }
});

projectsRouter.delete("/:projectId", (req, res, next) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    if (!getFolderById(projectId)) return void res.status(404).json({ error: "Project not found." });
    const result = deleteFolderIfEmpty(projectId);
    if (!result.deleted) {
      return void res.status(409).json({
        error: "Project is not empty.",
        modelCount: result.modelCount,
        childCount: result.childCount
      });
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

function parseProjectId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new Error("Invalid project id.");
  return id;
}

function toProject(folder: ReturnType<typeof createFolder>) {
  return {
    id: folder.id,
    name: folder.name,
    slug: folder.slug,
    created_at: folder.created_at,
    updated_at: folder.updated_at,
    model_count: folder.model_count ?? 0,
    total_size_bytes: folder.total_size_bytes ?? 0
  };
}
