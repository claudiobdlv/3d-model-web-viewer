import type {
  BatchAction,
  BatchResult,
  ConversionQuality,
  FolderRecord,
  FolderSelection,
  JobRecord,
  ModelListParams,
  ModelRecord,
  ProjectRecord,
  PublicModel,
  PublicShareResponse,
  StorageQuota
} from "./types";

async function handleErrorResponse(response: Response): Promise<never> {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  let errorMessage = "";

  if (contentType.includes("application/json") || text.trim().startsWith("{")) {
    try {
      const json = JSON.parse(text);
      errorMessage = json.error || json.message || text;
    } catch {
      errorMessage = text;
    }
  } else if (contentType.includes("text/html") || text.trim().startsWith("<")) {
    if (response.status === 413 || text.includes("413 Payload Too Large") || text.includes("Too Large")) {
      errorMessage = "Upload too large for a single request. Large files are uploaded in chunks automatically. Please retry.";
    } else {
      errorMessage = `Server error (${response.status}). Please try again.`;
    }
  } else {
    errorMessage = text || `Request failed: ${response.status}`;
  }

  throw new Error(errorMessage);
}

async function request<T>(url: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  const controller = timeoutMs ? new AbortController() : null;
  const timeout = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : undefined;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: controller?.signal ?? init?.signal,
      headers: {
        ...(init?.body instanceof FormData ? {} : { "content-type": "application/json" }),
        accept: "application/json",
        ...init?.headers
      }
    });
  } catch (error) {
    if (controller?.signal.aborted) throw new Error("The server did not respond in time. Please retry.");
    throw error;
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }

  if (!response.ok) {
    await handleErrorResponse(response);
  }

  return response.json() as Promise<T>;
}

function xhrErrorMessage(xhr: XMLHttpRequest, fallback: string): string {
  const contentType = xhr.getResponseHeader("content-type") || "";
  const text = xhr.responseText || "";
  if (contentType.includes("application/json") || text.trim().startsWith("{")) {
    try {
      const body = JSON.parse(text) as { error?: string; message?: string };
      return body.error || body.message || fallback;
    } catch {
      return text || fallback;
    }
  }
  if (xhr.status === 413 || text.includes("413 Payload Too Large") || text.includes("Too Large")) {
    return "A chunk was rejected as too large. Please retry or contact the administrator.";
  }
  return text.trim().startsWith("<") ? `Server error (${xhr.status}). Please try again.` : text || fallback;
}

export function listFolders(): Promise<FolderRecord[]> {
  return request<FolderRecord[]>("/api/folders");
}

export function listModels(selection: FolderSelection): Promise<ModelRecord[]> {
  const query =
    selection === "unsorted" ? "?folder=unsorted" : typeof selection === "number" ? `?folder=${selection}` : "";
  return request<ModelRecord[]>(`/api/models${query}`);
}

export function listLibraryModels(params: ModelListParams = {}): Promise<ModelRecord[]> {
  const query = new URLSearchParams();
  if (params.view) query.set("view", params.view);
  if (params.projectId) query.set("projectId", String(params.projectId));
  if (params.q) query.set("q", params.q);
  if (params.sortBy) query.set("sortBy", params.sortBy);
  if (params.sortDir) query.set("sortDir", params.sortDir);
  const suffix = query.size ? `?${query}` : "";
  return request<ModelRecord[]>(`/api/models${suffix}`);
}

export function listProjects(): Promise<ProjectRecord[]> {
  return request<ProjectRecord[]>("/api/projects");
}

export function createProject(name: string): Promise<ProjectRecord> {
  return request<ProjectRecord>("/api/projects", { method: "POST", body: JSON.stringify({ name }) });
}

export function renameProject(projectId: number, name: string): Promise<ProjectRecord> {
  return request<ProjectRecord>(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ name }) });
}

export async function deleteProject(projectId: number): Promise<void> {
  await request<{ ok: true }>(`/api/projects/${projectId}`, { method: "DELETE" });
}

export function getStorageQuota(): Promise<StorageQuota> {
  return request<StorageQuota>("/api/storage/quota", { cache: "no-store" });
}

export function batchModels(action: BatchAction, slugs: string[], projectId?: number | null): Promise<BatchResult> {
  return request<BatchResult>("/api/models/batch", {
    method: "POST",
    body: JSON.stringify({ action, slugs, ...(action === "moveToProject" ? { projectId: projectId ?? null } : {}) })
  });
}

export function getModel(slug: string): Promise<ModelRecord> {
  return request<ModelRecord>(`/api/models/${encodeURIComponent(slug)}`);
}

export function getPublicModel(token: string): Promise<PublicModel> {
  return request<PublicModel>(`/public/${encodeURIComponent(token)}/model.json`);
}

export function createPublicShare(modelId: number): Promise<PublicShareResponse> {
  return request<PublicShareResponse>(`/api/models/${modelId}/share`, { method: "POST" });
}

export async function revokePublicShare(modelId: number): Promise<number> {
  const result = await request<{ ok: true; revoked: number }>(`/api/models/${modelId}/share`, { method: "DELETE" });
  return result.revoked;
}

export function createFolder(name: string): Promise<FolderRecord> {
  return request<FolderRecord>("/api/folders", {
    method: "POST",
    body: JSON.stringify({ name })
  });
}

export function renameFolder(folderId: number, name: string): Promise<FolderRecord> {
  return request<FolderRecord>(`/api/folders/${folderId}`, {
    method: "PATCH",
    body: JSON.stringify({ name })
  });
}

export async function deleteFolder(folderId: number): Promise<void> {
  await request<{ ok: true }>(`/api/folders/${folderId}`, { method: "DELETE" });
}

export function moveModel(slug: string, folderId: number | null): Promise<ModelRecord> {
  return request<ModelRecord>(`/api/models/${encodeURIComponent(slug)}/folder`, {
    method: "PATCH",
    body: JSON.stringify({ folderId })
  });
}

export function renameModel(slug: string, name: string): Promise<ModelRecord> {
  return request<ModelRecord>(`/api/models/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    body: JSON.stringify({ name })
  });
}

export async function deleteModel(slug: string): Promise<void> {
  await request<{ ok: true }>(`/api/models/${encodeURIComponent(slug)}`, { method: "DELETE" });
}

export async function uploadModel(
  file: File,
  folderId: number | null,
  quality: ConversionQuality = "medium",
  signal?: AbortSignal
): Promise<ModelRecord> {
  const form = new FormData();
  form.set("modelFile", file);
  if (folderId) form.set("folderId", String(folderId));
  if (/\.(step|stp)$/i.test(file.name)) form.set("quality", quality);

  const response = await fetch("/api/models", {
    method: "POST",
    body: form,
    signal,
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    await handleErrorResponse(response);
  }

  return response.json() as Promise<ModelRecord>;
}

export function initChunkedUpload(
  filename: string,
  sizeBytes: number,
  projectId: number | null,
  quality: ConversionQuality = "medium"
): Promise<{ uploadId: string; chunkSizeBytes: number; maxUploadBytes: number }> {
  return request<{ uploadId: string; chunkSizeBytes: number; maxUploadBytes: number }>(
    "/api/uploads/chunked/init",
    {
      method: "POST",
      body: JSON.stringify({ filename, sizeBytes, projectId, quality })
    },
    30_000
  );
}

export async function uploadChunk(
  uploadId: string,
  chunkIndex: number,
  totalChunks: number,
  chunk: Blob,
  signal?: AbortSignal,
  onProgress?: (uploadedBytes: number, totalBytes: number) => void
): Promise<void> {
  const form = new FormData();
  form.set("chunk", chunk, "chunk.bin");

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.open("POST", `/api/uploads/chunked/${encodeURIComponent(uploadId)}/chunk?chunkIndex=${chunkIndex}&totalChunks=${totalChunks}`);
    xhr.setRequestHeader("accept", "application/json");
    xhr.timeout = 120_000;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.min(event.loaded, chunk.size), chunk.size);
    };
    xhr.onload = () => {
      signal?.removeEventListener("abort", abort);
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(xhrErrorMessage(xhr, `Chunk ${chunkIndex + 1} upload failed.`)));
    };
    xhr.onerror = () => {
      signal?.removeEventListener("abort", abort);
      reject(new Error(`Network error while uploading chunk ${chunkIndex + 1}.`));
    };
    xhr.ontimeout = () => {
      signal?.removeEventListener("abort", abort);
      reject(new Error(`Chunk ${chunkIndex + 1} stalled for 2 minutes and was stopped. Please retry.`));
    };
    xhr.onabort = () => {
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("Upload cancelled.", "AbortError"));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    xhr.send(form);
  });
}

export function completeChunkedUpload(uploadId: string): Promise<ModelRecord> {
  return request<ModelRecord>(`/api/uploads/chunked/${encodeURIComponent(uploadId)}/complete`, {
    method: "POST"
  }, 120_000);
}

export function deleteChunkedUpload(uploadId: string): Promise<void> {
  return request<void>(`/api/uploads/chunked/${encodeURIComponent(uploadId)}`, {
    method: "DELETE"
  });
}

export function listJobs(): Promise<JobRecord[]> {
  return request<JobRecord[]>("/api/jobs");
}

export function saveModelDefaultView(slug: string, defaultView: any | null): Promise<ModelRecord> {
  return request<ModelRecord>(`/api/models/${encodeURIComponent(slug)}/default-view`, {
    method: "POST",
    body: JSON.stringify({ defaultView })
  });
}
