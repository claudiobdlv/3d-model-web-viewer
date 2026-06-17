import type { FolderRecord, FolderSelection, ModelRecord } from "./types";

export const activeStatuses = new Set(["uploaded", "queued", "processing"]);

export function selectedFolderId(selection: FolderSelection): number | null {
  return typeof selection === "number" ? selection : null;
}

export function folderName(selection: FolderSelection, folders: FolderRecord[]): string {
  if (selection === "all") return "All models";
  if (selection === "unsorted") return "Unsorted";
  return folders.find((folder) => folder.id === selection)?.name ?? "Folder";
}

export function folderNameForModel(model: ModelRecord, folders: FolderRecord[]): string {
  if (!model.folder_id) return "Unsorted";
  return folders.find((folder) => folder.id === model.folder_id)?.name ?? "Missing folder";
}

export function hasActiveModels(models: ModelRecord[]): boolean {
  return models.some((model) => activeStatuses.has(model.status));
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function statusLabel(status: string): string {
  if (status === "uploaded") return "Uploaded";
  if (status === "queued") return "Queued";
  if (status === "processing") return "Converting";
  if (status === "ready") return "Ready";
  if (status === "failed") return "Failed";
  return status || "Waiting";
}

export function statusKind(status: string): "ready" | "failed" | "processing" | "queued" {
  if (status === "ready") return "ready";
  if (status === "failed") return "failed";
  if (status === "processing") return "processing";
  return "queued";
}

export function fileKind(sourceExt: string): string {
  return sourceExt.replace(".", "").toUpperCase() || "MODEL";
}
