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
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  default_view_json?: string | null;
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
