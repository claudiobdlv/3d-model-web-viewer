import express from "express";
import {
  createFolder,
  deleteFolderIfEmpty,
  getFolderById,
  listFolders,
  renameFolder
} from "../db.js";

export const foldersRouter = express.Router();

foldersRouter.get("/", (_req, res) => {
  res.json(listFolders());
});

foldersRouter.post("/", (req, res, next) => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name : "";
    const parentId = parseOptionalFolderId(req.body?.parentId ?? req.body?.parent_id);

    if (parentId !== null && !getFolderById(parentId)) {
      res.status(400).json({ error: "Parent folder not found." });
      return;
    }

    res.status(201).json(createFolder({ name, parentId }));
  } catch (error) {
    next(error);
  }
});

foldersRouter.patch("/:folderId", (req, res, next) => {
  try {
    const folderId = Number(req.params.folderId);
    if (!Number.isInteger(folderId) || folderId < 1) {
      res.status(400).json({ error: "Invalid folder id." });
      return;
    }

    const name = typeof req.body?.name === "string" ? req.body.name : "";
    const folder = renameFolder(folderId, name);
    if (!folder) {
      res.status(404).json({ error: "Folder not found." });
      return;
    }

    res.json(folder);
  } catch (error) {
    next(error);
  }
});

foldersRouter.delete("/:folderId", (req, res) => {
  const folderId = Number(req.params.folderId);
  if (!Number.isInteger(folderId) || folderId < 1) {
    res.status(400).json({ error: "Invalid folder id." });
    return;
  }

  if (!getFolderById(folderId)) {
    res.status(404).json({ error: "Folder not found." });
    return;
  }

  const result = deleteFolderIfEmpty(folderId);
  if (!result.deleted) {
    res.status(409).json({
      error: "Folder is not empty.",
      modelCount: result.modelCount,
      childCount: result.childCount
    });
    return;
  }

  res.json({ ok: true });
});

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
