export type ModelRecord = {
  id: number;
  slug: string;
  name: string;
  source_filename: string;
  source_ext: string;
  status: "uploaded" | "queued" | "processing" | "ready" | "failed" | string;
  has_display_glb: number;
  folder_id: number | null;
  created_at: string;
  updated_at: string;
};

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
