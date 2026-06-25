export type ModelRecord = {
  id: number;
  slug: string;
  name: string;
  source_filename: string;
  source_ext: string;
  status: "uploaded" | "queued" | "processing" | "ready" | "failed" | string;
  has_display_glb: number;
  glb_size_bytes: number | null;
  original_size_bytes: number | null;
  folder_id: number | null;
  project_id: number | null;
  project_name?: string | null;
  quality?: ConversionQuality | null;
  deleted_at: string | null;
  pending_delete_at?: string | null;
  progress_percent?: number | null;
  progress_label?: string | null;
  progress_updated_at?: string | null;
  job_started_at?: string | null;
  created_at: string;
  updated_at: string;
  default_view_json?: string | null;
  largeStepChunkingSummary?: LargeStepChunkingSummary;
  current_revision_id?: number | null;
  current_revision_label?: string | null;
  currentRevision?: ModelRevisionRecord | null;
  activeRevision?: ModelRevisionRecord | null;
  revisions?: ModelRevisionRecord[];
  glb_url?: string;
  original_download_url?: string;
  glb_download_url?: string;
  invalidRevisionRequested?: boolean;
};

export type ModelRevisionRecord = {
  id: number;
  model_id: number;
  revision_label: string;
  revision_sort_order: number;
  issued_date: string;
  quality_preset: string;
  status: "uploaded" | "queued" | "processing" | "ready" | "failed" | string;
  is_current: number;
  is_publicly_selectable: number;
  source_filename: string;
  source_path: string;
  display_glb_path: string;
  source_size_bytes: number;
  glb_size_bytes: number | null;
  conversion_job_id: number | null;
  uploaded_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type RevisionFileVersionRecord = {
  id: number;
  revision_id: number;
  file_version_number: number;
  source_filename: string;
  source_path: string;
  display_glb_path: string;
  quality_preset: string;
  replacement_reason: string | null;
  is_active: number;
  uploaded_at: string;
  uploaded_by: string | null;
};

export type ProjectRecord = {
  id: number;
  name: string;
  slug: string;
  created_at: string;
  updated_at: string;
  model_count: number;
  total_size_bytes: number;
};

export type ModelListParams = {
  view?: "all" | "unsorted" | "recycling";
  projectId?: number;
  q?: string;
  sortBy?: "name" | "status" | "created_at" | "updated_at" | "glb_size_bytes" | "original_size_bytes" | "project";
  sortDir?: "asc" | "desc";
};

export type StorageQuota = {
  quotaBytes: number;
  usedBytes: number;
  availableBytes: number;
  percentUsed: number;
  breakdown: {
    originalBytes: number;
    displayGlbBytes: number;
    logsBytes: number;
    deletedBytes: number;
  };
};

export type BatchAction = "trash" | "restore" | "deleteForever" | "moveToProject";
export type BatchResult = { updated: string[]; failed: Array<{ slug: string; reason: string }> };

export type FolderRecord = {
  id: number;
  name: string;
  slug: string;
  parent_id: number | null;
  created_at: string;
  updated_at: string;
  model_count?: number;
};

export type JobRecord = {
  id: number;
  model_id: number;
  model_slug: string;
  type: string;
  status: string;
  message: string | null;
  quality: ConversionQuality;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  revision_id?: number | null;
};

export type ConversionQuality = "low" | "medium" | "high";

export type RevisionMetadata = {
  revisionLabel?: string;
  issuedDate?: string;
  makeCurrent?: boolean;
  allowPublicSelectable?: boolean;
};

export type UploadTask = {
  clientUploadId: string;
  uploadId: string | null;
  filename: string;
  sizeBytes: number;
  uploadedBytes: number;
  percent: number;
  currentChunk: number;
  totalChunks: number;
  stage: "initializing" | "uploading" | "finalizing" | "queued" | "failed" | "cancelled";
  error?: string;
  projectId: number | null;
  projectName: string | null;
  quality: ConversionQuality;
  modelSlug?: string;
};

export type FolderSelection = "all" | "unsorted" | number;

export type PublicShareResponse = {
  token: string;
  url: string;
  model: Pick<ModelRecord, "id" | "slug" | "name">;
  reused: boolean;
};

export type PublicModel = {
  name: string;
  slug: string;
  glb_url: string;
  default_view_json?: string | null;
  activeRevision: PublicRevisionSummary | null;
  revisions: PublicRevisionSummary[];
  allowRevisionSwitching: boolean;
  invalidRevisionRequested?: boolean;
};

export type PublicRevisionSummary = Pick<
  ModelRevisionRecord,
  "id" | "revision_label" | "issued_date" | "status" | "is_current" | "is_publicly_selectable"
>;

export type LargeStepChunkingSummary = {
  mode?: string;
  status?: string;
  label?: string;
  detailLabel?: string;
  skipReason?: string;
  targetChunks?: number;
  actualChunks?: number;
  maxActiveChunks?: number;
  plannerDurationSeconds?: number;
  totalWallClockSeconds?: number;
  rawGlbBytes?: number;
  finalGlbBytes?: number;
  meshoptReductionPercent?: number;
  peakMemoryFraction?: number;
  swapGrowthBytes?: number;
  decisionReasons?: string[];
  chunks?: Array<{
    index?: number;
    durationSeconds?: number;
    triangles?: number;
    glbBytes?: number;
  }>;
};
