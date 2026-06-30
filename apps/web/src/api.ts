import type {
  BatchAction,
  AppConfig,
  BatchResult,
  ConversionQuality,
  MeshiqAdaptiveSmoothing,
  FolderRecord,
  FolderSelection,
  JobRecord,
  ModelListParams,
  ModelRecord,
  ModelRevisionRecord,
  ProjectRecord,
  PublicModel,
  PublicShareLinkMode,
  PublicShareResponse,
  PublicShareSettings,
  RevisionFileVersionRecord,
  RevisionMetadata,
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

export function getAppConfig(): Promise<AppConfig> {
  return request<AppConfig>("/api/config", { cache: "no-store" });
}

export function batchModels(action: BatchAction, slugs: string[], projectId?: number | null): Promise<BatchResult> {
  return request<BatchResult>("/api/models/batch", {
    method: "POST",
    body: JSON.stringify({ action, slugs, ...(action === "moveToProject" ? { projectId: projectId ?? null } : {}) })
  });
}

export function getModel(slug: string, revisionId?: number): Promise<ModelRecord> {
  const query = revisionId ? `?revisionId=${revisionId}` : "";
  return request<ModelRecord>(`/api/models/${encodeURIComponent(slug)}${query}`);
}

export function getPublicModel(token: string, revisionId?: number): Promise<PublicModel> {
  const query = revisionId ? `?revisionId=${revisionId}` : "";
  return request<PublicModel>(`/public/${encodeURIComponent(token)}/model.json${query}`);
}

export function getPublicShareSettings(modelId: number): Promise<PublicShareSettings> {
  return request<PublicShareSettings>(`/api/models/${modelId}/share`, { cache: "no-store" });
}

export function createPublicShare(
  modelId: number,
  settings?: {
    linkMode: PublicShareLinkMode;
    revisionId: number | null;
    allowRevisionSwitching: boolean;
  }
): Promise<PublicShareResponse> {
  return request<PublicShareResponse>(`/api/models/${modelId}/share`, {
    method: "POST",
    body: settings ? JSON.stringify(settings) : undefined
  });
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
  signal?: AbortSignal,
  revision: RevisionMetadata = {},
  meshiqAdaptiveSmoothing: MeshiqAdaptiveSmoothing = "off"
): Promise<ModelRecord> {
  const form = new FormData();
  form.set("modelFile", file);
  if (folderId) form.set("folderId", String(folderId));
  form.set("quality", quality);
  form.set("meshiqAdaptiveSmoothing", meshiqAdaptiveSmoothing);
  appendRevisionMetadata(form, revision);

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
  quality: ConversionQuality = "medium",
  revision: RevisionMetadata & { modelSlug?: string } = {},
  meshiqAdaptiveSmoothing: MeshiqAdaptiveSmoothing = "off"
): Promise<{ uploadId: string; chunkSizeBytes: number; maxUploadBytes: number }> {
  return request<{ uploadId: string; chunkSizeBytes: number; maxUploadBytes: number }>(
    "/api/uploads/chunked/init",
    {
      method: "POST",
      body: JSON.stringify({ filename, sizeBytes, projectId, quality, ...revision, meshiqAdaptiveSmoothing })
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

export function completeChunkedUpload<T = ModelRecord>(uploadId: string): Promise<T> {
  return request<T>(`/api/uploads/chunked/${encodeURIComponent(uploadId)}/complete`, {
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

export async function uploadNewRevision(
  slug: string,
  file: File,
  quality: ConversionQuality,
  revision: RevisionMetadata,
  onProgress?: (percent: number) => void
): Promise<{ revision: ModelRevisionRecord; job: JobRecord }> {
  const meshiqAdaptiveSmoothing = revision.meshiqAdaptiveSmoothing ?? "off";
  if (file.size > 83886080) {
    const { uploadId, chunkSizeBytes } = await initChunkedUpload(
      file.name,
      file.size,
      null,
      quality,
      { ...revision, modelSlug: slug },
      meshiqAdaptiveSmoothing
    );
    try {
      const totalChunks = Math.ceil(file.size / chunkSizeBytes);
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const start = chunkIndex * chunkSizeBytes;
        const end = Math.min(start + chunkSizeBytes, file.size);
        await uploadChunk(uploadId, chunkIndex, totalChunks, file.slice(start, end), undefined, (chunkBytes) => {
          onProgress?.(Math.round(((start + chunkBytes) / file.size) * 100));
        });
      }
      return await completeChunkedUpload<{ revision: ModelRevisionRecord; job: JobRecord }>(uploadId);
    } catch (error) {
      await deleteChunkedUpload(uploadId).catch(() => undefined);
      throw error;
    }
  }
  const form = new FormData();
  form.set("modelFile", file);
  form.set("quality", quality);
  form.set("meshiqAdaptiveSmoothing", meshiqAdaptiveSmoothing);
  appendRevisionMetadata(form, revision);
  return uploadMultipart(`/api/models/${encodeURIComponent(slug)}/revisions`, form, onProgress);
}

export function replaceRevision(
  slug: string,
  revisionId: number,
  file: File,
  quality: ConversionQuality,
  replacementReason: string,
  onProgress?: (percent: number) => void,
  meshiqAdaptiveSmoothing: MeshiqAdaptiveSmoothing = "off"
): Promise<{ revision: ModelRevisionRecord; fileVersion: RevisionFileVersionRecord; job: JobRecord }> {
  const form = new FormData();
  form.set("modelFile", file);
  form.set("quality", quality);
  form.set("meshiqAdaptiveSmoothing", meshiqAdaptiveSmoothing);
  if (replacementReason.trim()) form.set("replacementReason", replacementReason.trim());
  return uploadMultipart(`/api/models/${encodeURIComponent(slug)}/revisions/${revisionId}/replace`, form, onProgress);
}

export function makeRevisionCurrent(slug: string, revisionId: number): Promise<ModelRevisionRecord> {
  return request<ModelRevisionRecord>(
    `/api/models/${encodeURIComponent(slug)}/revisions/${revisionId}/current`,
    { method: "PATCH", body: JSON.stringify({}) }
  );
}

export function updateRevisionPublicSelectable(
  slug: string,
  revisionId: number,
  isPubliclySelectable: boolean
): Promise<ModelRevisionRecord> {
  return request<ModelRevisionRecord>(
    `/api/models/${encodeURIComponent(slug)}/revisions/${revisionId}`,
    { method: "PATCH", body: JSON.stringify({ isPubliclySelectable }) }
  );
}

export async function fetchModelRevisions(slug: string): Promise<ModelRevisionRecord[]> {
  return (await getModel(slug)).revisions ?? [];
}

function appendRevisionMetadata(form: FormData, revision: RevisionMetadata): void {
  if (revision.revisionLabel !== undefined) form.set("revisionLabel", revision.revisionLabel);
  if (revision.issuedDate) form.set("issuedDate", revision.issuedDate);
  if (revision.makeCurrent !== undefined) form.set("makeCurrent", String(revision.makeCurrent));
  if (revision.allowPublicSelectable !== undefined) {
    form.set("allowPublicSelectable", String(revision.allowPublicSelectable));
  }
}

function uploadMultipart<T>(url: string, form: FormData, onProgress?: (percent: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("accept", "application/json");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as T);
        } catch {
          reject(new Error("The server returned an invalid response."));
        }
      } else {
        reject(new Error(xhrErrorMessage(xhr, `Upload failed (${xhr.status}).`)));
      }
    };
    xhr.onerror = () => reject(new Error("Network error while uploading the file."));
    xhr.send(form);
  });
}

export type MeResponse =
  | { authenticated: false }
  | {
      authenticated: true;
      user: { id: string; email: string; displayName: string | null; avatarUrl: string | null };
      organization: { id: string; name: string; slug: string } | null;
      role: string | null;
    };

export async function getMe(): Promise<MeResponse> {
  try {
    const res = await fetch("/api/me", { headers: { accept: "application/json" }, cache: "no-store" });
    // 401 (no session) and 404 (accounts disabled, route absent) both mean
    // "not authenticated". Await the body parse inside the try so a non-JSON /
    // truncated response is treated as unauthenticated rather than throwing.
    if (!res.ok) return { authenticated: false };
    return (await res.json()) as MeResponse;
  } catch {
    // Network failure or invalid JSON: fail closed to unauthenticated.
    return { authenticated: false };
  }
}

export async function postLogout(): Promise<void> {
  await fetch("/auth/logout", { method: "POST", redirect: "manual" });
  window.location.href = "/login";
}
