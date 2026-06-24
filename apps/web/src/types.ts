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
};

export type ModelRevisionRecord = {
  id: number;
  model_id: number;
  revision_label: string;
  date_issued: string;
  status: "uploaded" | "queued" | "processing" | "ready" | "failed" | string;
  has_display_glb: number;
  glb_size_bytes: number | null;
  original_size_bytes: number | null;
  quality: ConversionQuality;
  source_filename: string;
  source_ext: string;
  is_active: number;
  replaced_by_id: number | null;
  replacement_reason: string | null;
  allowed_in_public_viewer: number;
  is_current: number;
  created_at: string;
  updated_at: string;
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
};

export type ConversionQuality = "low" | "medium" | "high";

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
};

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
