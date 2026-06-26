import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dbRoot, getModelDir, getUploadDir } from "./storage.js";
import { parseConversionQuality, type ConversionQuality } from "./quality.js";

export type ModelRecord = {
  id: number;
  slug: string;
  name: string;
  source_filename: string;
  source_ext: string;
  status: string;
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
  current_revision_id?: number | null;
  current_revision_label?: string | null;
};

export type ModelRevisionRecord = {
  id: number;
  model_id: number;
  revision_label: string;
  revision_sort_order: number;
  issued_date: string;
  quality_preset: string;
  status: string;
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

export type FolderRecord = {
  id: number;
  name: string;
  slug: string;
  parent_id: number | null;
  created_at: string;
  updated_at: string;
  model_count?: number;
  total_size_bytes?: number;
};

export type ModelListOptions = {
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
  cancellation_requested_at: string | null;
  worker_claimed_at: string | null;
  progress_percent: number | null;
  progress_label: string | null;
  progress_updated_at: string | null;
  revision_id?: number | null;
};

export type PublicShareRecord = {
  id: string;
  model_id: number;
  token_hash: string;
  token_prefix: string;
  public_token: string | null;
  created_at: string;
  revoked_at: string | null;
  last_accessed_at: string | null;
  access_count: number;
  revision_id?: number | null;
  link_mode?: string | null;
  allow_revision_switching?: number;
};

export type PublicShareLinkMode = "locked_revision" | "latest_current";

export type PublicShareModelRecord = ModelRecord & {
  share_id: string;
  token_prefix: string;
  share_created_at: string;
  last_accessed_at: string | null;
  access_count: number;
};

const dbPath = path.join(dbRoot, "app.sqlite");
fs.mkdirSync(dbRoot, { recursive: true });
export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

export function initDb(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      source_filename TEXT NOT NULL,
      source_ext TEXT NOT NULL,
      status TEXT NOT NULL,
      has_display_glb INTEGER NOT NULL DEFAULT 0,
      glb_size_bytes INTEGER,
      folder_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (folder_id) REFERENCES folders(id)
    );

    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      parent_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_id) REFERENCES folders(id)
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id INTEGER NOT NULL,
      model_slug TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      quality TEXT NOT NULL DEFAULT 'medium' CHECK (quality IN ('low', 'medium', 'high')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT,
      failed_at TEXT,
      FOREIGN KEY (model_id) REFERENCES models(id)
    );

    CREATE TABLE IF NOT EXISTS public_shares (
      id TEXT PRIMARY KEY,
      model_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT,
      last_accessed_at TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS model_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id INTEGER NOT NULL,
      revision_label TEXT NOT NULL,
      revision_sort_order INTEGER NOT NULL,
      issued_date TEXT NOT NULL,
      quality_preset TEXT NOT NULL,
      status TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 0,
      is_publicly_selectable INTEGER NOT NULL DEFAULT 1,
      source_filename TEXT NOT NULL,
      source_path TEXT NOT NULL,
      display_glb_path TEXT NOT NULL,
      source_size_bytes INTEGER NOT NULL,
      glb_size_bytes INTEGER,
      conversion_job_id INTEGER,
      uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT,
      FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE,
      FOREIGN KEY (conversion_job_id) REFERENCES jobs(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS revision_file_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      revision_id INTEGER NOT NULL,
      file_version_number INTEGER NOT NULL,
      source_filename TEXT NOT NULL,
      source_path TEXT NOT NULL,
      display_glb_path TEXT NOT NULL,
      quality_preset TEXT NOT NULL,
      replacement_reason TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      uploaded_by TEXT,
      FOREIGN KEY (revision_id) REFERENCES model_revisions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS public_shares_model_active_idx
      ON public_shares (model_id, revoked_at);
  `);

  ensureColumn("jobs", "started_at", "TEXT");
  ensureColumn("jobs", "completed_at", "TEXT");
  ensureColumn("jobs", "failed_at", "TEXT");
  ensureColumn("jobs", "quality", "TEXT NOT NULL DEFAULT 'medium'");
  ensureColumn("jobs", "cancellation_requested_at", "TEXT");
  ensureColumn("jobs", "worker_claimed_at", "TEXT");
  ensureColumn("jobs", "progress_percent", "INTEGER");
  ensureColumn("jobs", "progress_label", "TEXT");
  ensureColumn("jobs", "progress_updated_at", "TEXT");
  ensureColumn("models", "folder_id", "INTEGER REFERENCES folders(id)");
  ensureColumn("models", "glb_size_bytes", "INTEGER");
  ensureColumn("models", "original_size_bytes", "INTEGER");
  ensureColumn("models", "deleted_at", "TEXT");
  ensureColumn("models", "pending_delete_at", "TEXT");
  ensureColumn("models", "default_view_json", "TEXT");
  ensureColumn("public_shares", "public_token", "TEXT");
  ensureColumn("jobs", "revision_id", "INTEGER REFERENCES model_revisions(id) ON DELETE SET NULL");
  ensureColumn("public_shares", "revision_id", "INTEGER REFERENCES model_revisions(id) ON DELETE SET NULL");
  ensureColumn("public_shares", "link_mode", "TEXT DEFAULT 'locked_revision'");
  ensureColumn("public_shares", "allow_revision_switching", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("models", "current_revision_id", "INTEGER REFERENCES model_revisions(id) ON DELETE SET NULL");

  db.exec(`
    CREATE INDEX IF NOT EXISTS models_deleted_at_idx
      ON models (deleted_at);
    CREATE INDEX IF NOT EXISTS models_folder_deleted_idx
      ON models (folder_id, deleted_at);
    CREATE UNIQUE INDEX IF NOT EXISTS public_shares_public_token_idx
      ON public_shares (public_token)
      WHERE public_token IS NOT NULL;

    CREATE INDEX IF NOT EXISTS model_revisions_model_idx ON model_revisions (model_id);
    CREATE UNIQUE INDEX IF NOT EXISTS model_revisions_model_label_idx ON model_revisions (model_id, revision_label);
    CREATE INDEX IF NOT EXISTS model_revisions_model_current_idx ON model_revisions (model_id, is_current);
    CREATE INDEX IF NOT EXISTS revision_file_versions_revision_idx ON revision_file_versions (revision_id);
    CREATE INDEX IF NOT EXISTS jobs_revision_idx ON jobs (revision_id);
    CREATE INDEX IF NOT EXISTS public_shares_revision_idx ON public_shares (revision_id);
    CREATE INDEX IF NOT EXISTS public_shares_model_link_mode_idx ON public_shares (model_id, link_mode);
  `);
  backfillGlbSizes();
  backfillOriginalSizes();
  backfillModelRevisions();
}

function backfillGlbSizes(): void {
  const models = db
    .prepare("SELECT id, slug FROM models WHERE has_display_glb = 1 AND glb_size_bytes IS NULL")
    .all() as Array<{ id: number; slug: string }>;
  const update = db.prepare("UPDATE models SET glb_size_bytes = ? WHERE id = ?");

  for (const model of models) {
    try {
      update.run(fs.statSync(path.join(getModelDir(model.slug), "display.glb")).size, model.id);
    } catch {
      // Keep unavailable artifact sizes nullable; list requests remain filesystem-free.
    }
  }
}

function backfillOriginalSizes(): void {
  const models = db
    .prepare("SELECT id, slug, source_ext FROM models WHERE original_size_bytes IS NULL")
    .all() as Array<{ id: number; slug: string; source_ext: string }>;
  const update = db.prepare("UPDATE models SET original_size_bytes = ? WHERE id = ?");

  for (const model of models) {
    try {
      update.run(fs.statSync(path.join(getUploadDir(model.slug), `original${model.source_ext}`)).size, model.id);
    } catch {
      // Missing legacy source files stay nullable and contribute zero to quota.
    }
  }
}

export function backfillModelRevisions(): void {
  const models = db.prepare("SELECT * FROM models").all() as ModelRecord[];

  for (const model of models) {
    const existing = db.prepare("SELECT COUNT(*) AS count FROM model_revisions WHERE model_id = ?").get(model.id) as { count: number };
    if (existing.count > 0) {
      continue;
    }

    db.exec("BEGIN TRANSACTION");
    try {
      const lastJob = db.prepare("SELECT id, quality FROM jobs WHERE model_id = ? ORDER BY id DESC LIMIT 1").get(model.id) as { id: number; quality: string } | undefined;
      const qualityPreset = lastJob?.quality || "medium";

      let issuedDate = new Date().toISOString().slice(0, 10);
      if (model.created_at) {
        const parsed = model.created_at.slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(parsed)) {
          issuedDate = parsed;
        }
      }

      // Store relative paths from storageRoot
      const sourcePath = `uploads/${model.slug}/original${model.source_ext}`;
      const displayGlbPath = `models/${model.slug}/display.glb`;

      const revisionRes = db.prepare(`
        INSERT INTO model_revisions (
          model_id, revision_label, revision_sort_order, issued_date, quality_preset,
          status, is_current, is_publicly_selectable, source_filename, source_path,
          display_glb_path, source_size_bytes, glb_size_bytes, conversion_job_id,
          uploaded_at, updated_at
        ) VALUES (?, '1', 1, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        model.id,
        issuedDate,
        qualityPreset,
        model.status,
        model.source_filename,
        sourcePath,
        displayGlbPath,
        model.original_size_bytes || 0,
        model.glb_size_bytes || null,
        lastJob ? lastJob.id : null,
        model.created_at,
        model.updated_at
      );

      const revisionId = Number(revisionRes.lastInsertRowid);

      db.prepare(`
        INSERT INTO revision_file_versions (
          revision_id, file_version_number, source_filename, source_path,
          display_glb_path, quality_preset, is_active, uploaded_at
        ) VALUES (?, 1, ?, ?, ?, ?, 1, ?)
      `).run(
        revisionId,
        model.source_filename,
        sourcePath,
        displayGlbPath,
        qualityPreset,
        model.created_at
      );

      db.prepare("UPDATE models SET current_revision_id = ? WHERE id = ?").run(revisionId, model.id);
      db.prepare("UPDATE jobs SET revision_id = ? WHERE model_id = ?").run(revisionId, model.id);
      db.prepare("UPDATE public_shares SET revision_id = ?, link_mode = 'locked_revision' WHERE model_id = ?").run(revisionId, model.id);

      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      console.error(`Failed to backfill model ${model.slug}:`, err);
      throw err;
    }
  }
}

function ensureColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((existing) => existing.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function listModels(options: ModelListOptions = {}): ModelRecord[] {
  const sortColumns: Record<NonNullable<ModelListOptions["sortBy"]>, string> = {
    name: "lower(models.name)",
    status: "lower(models.status)",
    created_at: "models.created_at",
    updated_at: "models.updated_at",
    glb_size_bytes: "models.glb_size_bytes",
    original_size_bytes: "models.original_size_bytes",
    project: "lower(folders.name)"
  };
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (options.view === "recycling") where.push("models.deleted_at IS NOT NULL");
  else where.push("models.deleted_at IS NULL");
  if (options.view === "unsorted") where.push("models.folder_id IS NULL");
  if (typeof options.projectId === "number") {
    where.push("models.folder_id = ?");
    params.push(options.projectId);
  }
  if (options.q) {
    where.push("(models.name LIKE ? ESCAPE '\\' OR models.source_filename LIKE ? ESCAPE '\\' OR folders.name LIKE ? ESCAPE '\\')");
    const query = `%${escapeLike(options.q)}%`;
    params.push(query, query, query);
  }

  const sortBy = options.sortBy ?? "created_at";
  const sortDir = options.sortDir === "asc" ? "ASC" : "DESC";
  const records = db.prepare(
    `SELECT models.*, models.folder_id AS project_id, folders.name AS project_name,
            (SELECT model_revisions.revision_label
             FROM model_revisions
             WHERE model_revisions.id = models.current_revision_id) AS current_revision_label,
            (SELECT jobs.quality FROM jobs WHERE jobs.model_id = models.id ORDER BY jobs.id DESC LIMIT 1) AS quality,
            (SELECT jobs.progress_percent FROM jobs WHERE jobs.model_id = models.id ORDER BY jobs.id DESC LIMIT 1) AS progress_percent,
            (SELECT jobs.progress_label FROM jobs WHERE jobs.model_id = models.id ORDER BY jobs.id DESC LIMIT 1) AS progress_label,
            (SELECT jobs.progress_updated_at FROM jobs WHERE jobs.model_id = models.id ORDER BY jobs.id DESC LIMIT 1) AS progress_updated_at,
            (SELECT jobs.started_at FROM jobs WHERE jobs.model_id = models.id ORDER BY jobs.id DESC LIMIT 1) AS job_started_at
     FROM models
     LEFT JOIN folders ON folders.id = models.folder_id
     WHERE ${where.join(" AND ")}
     ORDER BY ${sortColumns[sortBy]} ${sortDir}, models.id ${sortDir}`
  ).all(...params) as ModelRecord[];
  return records.map((model) => model.progress_percent == null || !["processing", "cancelling"].includes(model.status)
    ? model
    : { ...model, status: `progress|${model.status}|${model.progress_percent}|${model.progress_label || "Converting"}|${model.job_started_at || ""}` });
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function getModelBySlug(slug: string, includeDeleted = false): ModelRecord | undefined {
  return db.prepare(
    `SELECT models.*, models.folder_id AS project_id, folders.name AS project_name
     FROM models LEFT JOIN folders ON folders.id = models.folder_id
     WHERE models.slug = ? ${includeDeleted ? "" : "AND models.deleted_at IS NULL"}`
  ).get(slug) as ModelRecord | undefined;
}

export function getModelById(id: number, includeDeleted = false): ModelRecord | undefined {
  return db.prepare(
    `SELECT models.*, models.folder_id AS project_id, folders.name AS project_name
     FROM models LEFT JOIN folders ON folders.id = models.folder_id
     WHERE models.id = ? ${includeDeleted ? "" : "AND models.deleted_at IS NULL"}`
  ).get(id) as ModelRecord | undefined;
}

export function createPublicShare(input: {
  id: string;
  modelId: number;
  tokenHash: string;
  tokenPrefix: string;
  publicToken: string;
  revisionId?: number | null;
  linkMode?: PublicShareLinkMode;
  allowRevisionSwitching?: boolean;
}): PublicShareRecord {
  const currentRevision = getCurrentRevisionForModel(input.modelId);
  const linkMode = input.linkMode ?? "locked_revision";
  const revisionId = linkMode === "locked_revision"
    ? input.revisionId ?? currentRevision?.id ?? null
    : null;
  db.prepare(
    `INSERT INTO public_shares (
       id, model_id, token_hash, token_prefix, public_token, revision_id, link_mode,
       allow_revision_switching
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.modelId,
    input.tokenHash,
    input.tokenPrefix,
    input.publicToken,
    revisionId,
    linkMode,
    input.allowRevisionSwitching ? 1 : 0
  );
  return db.prepare("SELECT * FROM public_shares WHERE id = ?").get(input.id) as PublicShareRecord;
}

export function getActivePublicShareForModel(modelId: number): PublicShareRecord | undefined {
  return db.prepare(
    `SELECT * FROM public_shares
     WHERE model_id = ? AND revoked_at IS NULL AND public_token IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`
  ).get(modelId) as PublicShareRecord | undefined;
}

export function revokePublicSharesForModel(modelId: number): number {
  const result = db.prepare(
    `UPDATE public_shares
     SET revoked_at = CURRENT_TIMESTAMP
     WHERE model_id = ? AND revoked_at IS NULL`
  ).run(modelId);
  return Number(result.changes || 0);
}

export function updatePublicShareSettings(
  shareId: string,
  input: {
    linkMode: PublicShareLinkMode;
    revisionId: number | null;
    allowRevisionSwitching: boolean;
  }
): PublicShareRecord | undefined {
  db.prepare(
    `UPDATE public_shares
     SET link_mode = ?,
         revision_id = ?,
         allow_revision_switching = ?
     WHERE id = ? AND revoked_at IS NULL`
  ).run(input.linkMode, input.revisionId, input.allowRevisionSwitching ? 1 : 0, shareId);
  return db.prepare("SELECT * FROM public_shares WHERE id = ? AND revoked_at IS NULL").get(shareId) as PublicShareRecord | undefined;
}

export function getPublicShareModelByHash(tokenHash: string): PublicShareModelRecord | undefined {
  return db.prepare(
    `SELECT models.*,
            public_shares.id AS share_id,
            public_shares.token_prefix,
            public_shares.created_at AS share_created_at,
            public_shares.last_accessed_at,
            public_shares.access_count
     FROM public_shares
     JOIN models ON models.id = public_shares.model_id
     WHERE public_shares.token_hash = ? AND public_shares.revoked_at IS NULL
       AND models.deleted_at IS NULL`
  ).get(tokenHash) as PublicShareModelRecord | undefined;
}

export function recordPublicShareAccess(shareId: string): void {
  db.prepare(
    `UPDATE public_shares
     SET last_accessed_at = CURRENT_TIMESTAMP,
         access_count = access_count + 1
     WHERE id = ? AND revoked_at IS NULL`
  ).run(shareId);
}

export function deleteModelBySlug(slug: string): { deletedJobs: number; deletedModels: number } {
  const deleteJobsResult = db.prepare("DELETE FROM jobs WHERE model_slug = ?").run(slug);
  const deleteModelResult = db.prepare("DELETE FROM models WHERE slug = ?").run(slug);

  return {
    deletedJobs: Number(deleteJobsResult.changes || 0),
    deletedModels: Number(deleteModelResult.changes || 0)
  };
}

export function createModel(input: {
  slug: string;
  name: string;
  sourceFilename: string;
  sourceExt: string;
  status: string;
  hasDisplayGlb: boolean;
  glbSizeBytes?: number | null;
  originalSizeBytes?: number | null;
  folderId?: number | null;
}): ModelRecord {
  const result = db
    .prepare(
      `INSERT INTO models (slug, name, source_filename, source_ext, status, has_display_glb, glb_size_bytes, original_size_bytes, folder_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.slug,
      input.name,
      input.sourceFilename,
      input.sourceExt,
      input.status,
      input.hasDisplayGlb ? 1 : 0,
      input.glbSizeBytes ?? null,
      input.originalSizeBytes ?? null,
      input.folderId ?? null
    );

  return getModelById(Number(result.lastInsertRowid))!;
}

export function createJob(input: {
  modelId: number;
  modelSlug: string;
  type: string;
  status: string;
  message?: string;
  quality?: ConversionQuality;
  revisionId?: number | null;
}): JobRecord {
  const quality = parseConversionQuality(input.quality);
  const result = db
    .prepare(
      `INSERT INTO jobs (model_id, model_slug, type, status, message, quality, revision_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(input.modelId, input.modelSlug, input.type, input.status, input.message ?? null, quality, input.revisionId ?? null);

  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(result.lastInsertRowid) as JobRecord;
}

export function listJobs(): JobRecord[] {
  return db.prepare("SELECT * FROM jobs ORDER BY created_at DESC, id DESC").all() as JobRecord[];
}

export function listFolders(): FolderRecord[] {
  return db
    .prepare(
      `SELECT folders.*,
              COUNT(models.id) AS model_count,
              COALESCE(SUM(COALESCE(models.original_size_bytes, 0) + COALESCE(models.glb_size_bytes, 0)), 0) AS total_size_bytes
       FROM folders
       LEFT JOIN models ON models.folder_id = folders.id AND models.deleted_at IS NULL
       GROUP BY folders.id
       ORDER BY lower(folders.name) ASC, folders.id ASC`
    )
    .all() as FolderRecord[];
}

export function getFolderById(folderId: number): FolderRecord | undefined {
  return db.prepare("SELECT * FROM folders WHERE id = ?").get(folderId) as FolderRecord | undefined;
}

export function createFolder(input: { name: string; parentId?: number | null }): FolderRecord {
  const name = normalizeFolderName(input.name);
  const slug = nextFolderSlug(name);
  const parentId = input.parentId ?? null;

  const result = db
    .prepare("INSERT INTO folders (name, slug, parent_id) VALUES (?, ?, ?)")
    .run(name, slug, parentId);

  return db.prepare("SELECT * FROM folders WHERE id = ?").get(result.lastInsertRowid) as FolderRecord;
}

export function renameFolder(folderId: number, nameInput: string): FolderRecord | undefined {
  const existing = getFolderById(folderId);
  if (!existing) return undefined;

  const name = normalizeFolderName(nameInput);
  db.prepare(
    `UPDATE folders
     SET name = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(name, folderId);

  return getFolderById(folderId);
}

export function deleteFolderIfEmpty(folderId: number): { deleted: boolean; modelCount: number; childCount: number } {
  const modelCount = (db.prepare("SELECT COUNT(*) AS count FROM models WHERE folder_id = ?").get(folderId) as { count: number }).count;
  const childCount = (db.prepare("SELECT COUNT(*) AS count FROM folders WHERE parent_id = ?").get(folderId) as { count: number }).count;
  if (modelCount > 0 || childCount > 0) {
    return { deleted: false, modelCount, childCount };
  }

  const result = db.prepare("DELETE FROM folders WHERE id = ?").run(folderId);
  return { deleted: Number(result.changes || 0) > 0, modelCount, childCount };
}

export function moveModelToFolder(slug: string, folderId: number | null): ModelRecord | undefined {
  db.prepare(
    `UPDATE models
     SET folder_id = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE slug = ? AND deleted_at IS NULL`
  ).run(folderId, slug);

  return getModelBySlug(slug);
}

export function trashModel(slug: string): ModelRecord | undefined {
  db.prepare(
    `UPDATE models SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE slug = ? AND deleted_at IS NULL`
  ).run(slug);
  return getModelBySlug(slug, true);
}

export function requestModelCancellation(slug: string, pendingDelete = false): { queued: number; active: number } {
  const queued = db.prepare(
    `UPDATE jobs SET status = 'cancelled', message = 'Cancelled because the model was deleted.',
       cancellation_requested_at = COALESCE(cancellation_requested_at, CURRENT_TIMESTAMP),
       progress_label = 'Cancelled', progress_updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP WHERE model_slug = ? AND status IN ('uploaded', 'queued')`
  ).run(slug);
  const active = db.prepare(
    `UPDATE jobs SET status = 'cancelling', message = 'Cancellation requested because the model was deleted.',
       cancellation_requested_at = COALESCE(cancellation_requested_at, CURRENT_TIMESTAMP),
       progress_label = 'Cancelling conversion', progress_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE model_slug = ? AND status IN ('processing', 'cancelling')`
  ).run(slug);
  db.prepare(
    `UPDATE models SET status = CASE WHEN ? > 0 THEN 'cancelling' WHEN ? > 0 THEN 'cancelled' ELSE status END,
       pending_delete_at = CASE WHEN ? THEN COALESCE(pending_delete_at, CURRENT_TIMESTAMP) ELSE pending_delete_at END,
       updated_at = CURRENT_TIMESTAMP WHERE slug = ?`
  ).run(Number(active.changes || 0), Number(queued.changes || 0), pendingDelete ? 1 : 0, slug);
  return { queued: Number(queued.changes || 0), active: Number(active.changes || 0) };
}

export function updateJobProgress(jobId: number, percent: number, label: string): boolean {
  const result = db.prepare(
    `UPDATE jobs SET progress_percent = ?, progress_label = ?, progress_updated_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'processing' AND cancellation_requested_at IS NULL`
  ).run(Math.max(0, Math.min(99, Math.round(percent))), label.slice(0, 160), jobId);
  return result.changes === 1;
}

export function markJobCancelled(jobId: number, message = "Worker acknowledged cancellation."): ModelRecord | undefined {
  const job = getJobForWorker(jobId);
  if (!job) return undefined;
  db.prepare(
    `UPDATE jobs SET status = 'cancelled', message = ?, progress_label = 'Cancelled',
       progress_updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status IN ('processing', 'cancelling')`
  ).run(message, jobId);

  if ((job as any).revision_id) {
    const currentRevision = getRevisionById((job as any).revision_id);
    if (!currentRevision || currentRevision.conversion_job_id !== job.id) {
      return getModelById(job.model_id, true);
    }
    db.prepare(
      `UPDATE model_revisions
       SET status = 'cancelled',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run((job as any).revision_id);

    const rev = getRevisionById((job as any).revision_id);
    if (rev && rev.is_current === 1) {
      db.prepare(
        `UPDATE models SET status = 'cancelled', has_display_glb = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(job.model_id);
    }
  } else {
    db.prepare(
      `UPDATE models SET status = 'cancelled', has_display_glb = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(job.model_id);
  }
  return getModelById(job.model_id, true);
}

export function restoreModel(slug: string): ModelRecord | undefined {
  db.prepare(
    `UPDATE models SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE slug = ? AND deleted_at IS NOT NULL`
  ).run(slug);
  return getModelBySlug(slug);
}

export function getStorageQuota(): StorageQuota {
  const totals = db.prepare(
    `SELECT
       COALESCE(SUM(original_size_bytes), 0) AS originalBytes,
       COALESCE(SUM(glb_size_bytes), 0) AS displayGlbBytes,
       COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN COALESCE(original_size_bytes, 0) + COALESCE(glb_size_bytes, 0) ELSE 0 END), 0) AS deletedBytes
     FROM models`
  ).get() as { originalBytes: number; displayGlbBytes: number; deletedBytes: number };
  const quotaBytes = 5 * 1024 * 1024 * 1024;
  const usedBytes = totals.originalBytes + totals.displayGlbBytes;
  return {
    quotaBytes,
    usedBytes,
    availableBytes: Math.max(0, quotaBytes - usedBytes),
    percentUsed: quotaBytes === 0 ? 0 : Number(((usedBytes / quotaBytes) * 100).toFixed(4)),
    breakdown: { ...totals, logsBytes: 0 }
  };
}

export function renameModel(slug: string, nameInput: string): ModelRecord | undefined {
  const existing = getModelBySlug(slug);
  if (!existing) return undefined;

  const name = normalizeModelName(nameInput);
  db.prepare(
    `UPDATE models
     SET name = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE slug = ?`
  ).run(name, slug);

  return getModelBySlug(slug);
}

function normalizeModelName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!name) {
    throw new Error("Model name is required.");
  }

  return name;
}

function normalizeFolderName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!name) {
    throw new Error("Folder name is required.");
  }

  return name;
}

function nextFolderSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "folder";

  let slug = base;
  let suffix = 2;
  while (db.prepare("SELECT id FROM folders WHERE slug = ?").get(slug)) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }

  return slug;
}

export type WorkerJobRecord = JobRecord & {
  source_filename: string;
  source_ext: string;
};

export function claimNextWorkerJob(): WorkerJobRecord | undefined {
  db.exec("BEGIN IMMEDIATE");
  try {
    const job = db
      .prepare(
      `SELECT jobs.*,
              COALESCE(model_revisions.source_filename, models.source_filename) AS source_filename,
              CASE
                WHEN lower(model_revisions.source_filename) LIKE '%.step' THEN '.step'
                WHEN lower(model_revisions.source_filename) LIKE '%.stp' THEN '.stp'
                WHEN lower(model_revisions.source_filename) LIKE '%.glb' THEN '.glb'
                WHEN lower(model_revisions.source_filename) LIKE '%.gltf' THEN '.gltf'
                ELSE models.source_ext
              END AS source_ext
       FROM jobs
       JOIN models ON models.id = jobs.model_id
       LEFT JOIN model_revisions ON model_revisions.id = jobs.revision_id
       WHERE jobs.type = 'step-to-glb'
         AND jobs.status IN ('uploaded', 'queued')
         AND jobs.cancellation_requested_at IS NULL
         AND CASE
               WHEN lower(model_revisions.source_filename) LIKE '%.step' THEN '.step'
               WHEN lower(model_revisions.source_filename) LIKE '%.stp' THEN '.stp'
               ELSE models.source_ext
             END IN ('.step', '.stp')
         AND models.deleted_at IS NULL
       ORDER BY jobs.created_at ASC, jobs.id ASC
       LIMIT 1`
      )
      .get() as WorkerJobRecord | undefined;

    if (!job) {
      db.exec("COMMIT");
      return undefined;
    }

    const result = db.prepare(
      `UPDATE jobs
       SET status = 'processing',
           message = 'Worker claimed job for processing.',
           updated_at = CURRENT_TIMESTAMP,
           started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
           worker_claimed_at = CURRENT_TIMESTAMP,
           progress_percent = 5,
           progress_label = 'Converting - starting',
           progress_updated_at = CURRENT_TIMESTAMP,
           completed_at = NULL,
           failed_at = NULL
       WHERE id = ? AND status IN ('uploaded', 'queued') AND cancellation_requested_at IS NULL`
    ).run(job.id);

    if (result.changes !== 1) {
      db.exec("ROLLBACK");
      return undefined;
    }

    if (job.revision_id) {
      db.prepare("UPDATE model_revisions SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(job.revision_id);
      db.prepare(
        `UPDATE models SET status = 'processing', updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND current_revision_id = ?`
      ).run(job.model_id, job.revision_id);
    } else {
      db.prepare("UPDATE models SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(job.model_id);
    }

    db.exec("COMMIT");
    return { ...job, status: "processing" };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function getJobForWorker(jobId: number): WorkerJobRecord | undefined {
  return db
    .prepare(
      `SELECT jobs.*,
              COALESCE(model_revisions.source_filename, models.source_filename) AS source_filename,
              CASE
                WHEN lower(model_revisions.source_filename) LIKE '%.step' THEN '.step'
                WHEN lower(model_revisions.source_filename) LIKE '%.stp' THEN '.stp'
                WHEN lower(model_revisions.source_filename) LIKE '%.glb' THEN '.glb'
                WHEN lower(model_revisions.source_filename) LIKE '%.gltf' THEN '.gltf'
                ELSE models.source_ext
              END AS source_ext
       FROM jobs
       JOIN models ON models.id = jobs.model_id
       LEFT JOIN model_revisions ON model_revisions.id = jobs.revision_id
       WHERE jobs.id = ?`
    )
    .get(jobId) as WorkerJobRecord | undefined;
}

export function markJobProcessing(jobId: number): void {
  const job = getJobForWorker(jobId);
  if (!job) return;
  db.prepare(
    `UPDATE jobs
     SET status = 'processing',
         message = 'Worker started processing.',
         updated_at = CURRENT_TIMESTAMP,
         started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
         completed_at = NULL,
         failed_at = NULL
     WHERE id = ?`
  ).run(jobId);

  if (job.revision_id) {
    db.prepare("UPDATE model_revisions SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(job.revision_id);
    db.prepare(
      `UPDATE models SET status = 'processing', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND current_revision_id = ?`
    ).run(job.model_id, job.revision_id);
  } else {
    db.prepare("UPDATE models SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(job.model_id);
  }
}

export function markJobReady(jobId: number, message = "Worker completed fake processing.", glbSizeBytes?: number): boolean {
  const job = getJobForWorker(jobId);
  if (!job) return false;
  if (job.revision_id) {
    const revision = getRevisionById(job.revision_id);
    if (!revision || revision.conversion_job_id !== job.id) return false;
  }

  const result = db.prepare(
    `UPDATE jobs
     SET status = 'ready',
         message = ?,
         updated_at = CURRENT_TIMESTAMP,
         completed_at = CURRENT_TIMESTAMP,
         failed_at = NULL, progress_percent = 100, progress_label = 'Ready', progress_updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'processing' AND cancellation_requested_at IS NULL`
  ).run(message, jobId);

  if (result.changes !== 1) return false;

  if ((job as any).revision_id) {
    db.prepare(
      `UPDATE model_revisions
       SET status = 'ready',
           glb_size_bytes = COALESCE(?, glb_size_bytes),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(glbSizeBytes ?? null, (job as any).revision_id);

    const rev = getRevisionById((job as any).revision_id);
    if (rev && rev.is_current === 1) {
      db.prepare(
        `UPDATE models
         SET status = 'ready',
             has_display_glb = 1,
             glb_size_bytes = COALESCE(?, glb_size_bytes),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND deleted_at IS NULL`
      ).run(glbSizeBytes ?? null, job.model_id);
    }
  } else {
    db.prepare(
      `UPDATE models
       SET status = 'ready',
       has_display_glb = 1,
       glb_size_bytes = COALESCE(?, glb_size_bytes),
       updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND deleted_at IS NULL`
    ).run(glbSizeBytes ?? null, job.model_id);
  }
  return true;
}

export function markJobFailed(jobId: number, message: string): void {
  const job = getJobForWorker(jobId);
  if (!job) return;

  db.prepare(
    `UPDATE jobs
     SET status = 'failed',
         message = ?,
         updated_at = CURRENT_TIMESTAMP,
         failed_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(message, jobId);

  if ((job as any).revision_id) {
    const currentRevision = getRevisionById((job as any).revision_id);
    if (!currentRevision || currentRevision.conversion_job_id !== job.id) return;
    db.prepare(
      `UPDATE model_revisions
       SET status = 'failed',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run((job as any).revision_id);

    const rev = getRevisionById((job as any).revision_id);
    if (rev && rev.is_current === 1) {
      db.prepare(
        `UPDATE models
         SET status = 'failed',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).run(job.model_id);
    }
  } else {
    db.prepare(
      `UPDATE models
       SET status = 'failed',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(job.model_id);
  }
}

export function saveModelDefaultView(slug: string, defaultViewJson: string | null): ModelRecord | undefined {
  db.prepare(
    `UPDATE models
     SET default_view_json = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE slug = ?`
  ).run(defaultViewJson, slug);

  return getModelBySlug(slug);
}

export function getRevisionById(revisionId: number): ModelRevisionRecord | undefined {
  return db.prepare("SELECT * FROM model_revisions WHERE id = ?").get(revisionId) as ModelRevisionRecord | undefined;
}

export function getRevisionForModel(modelId: number, revisionId: number): ModelRevisionRecord | undefined {
  return db.prepare("SELECT * FROM model_revisions WHERE id = ? AND model_id = ?").get(revisionId, modelId) as ModelRevisionRecord | undefined;
}

export function getRevisionByLabel(modelId: number, revisionLabel: string): ModelRevisionRecord | undefined {
  return db.prepare(
    "SELECT * FROM model_revisions WHERE model_id = ? AND revision_label = ? COLLATE NOCASE"
  ).get(modelId, revisionLabel.trim().replace(/\s+/g, " ")) as ModelRevisionRecord | undefined;
}

export function listRevisionFileVersions(revisionId: number): RevisionFileVersionRecord[] {
  return db.prepare(
    "SELECT * FROM revision_file_versions WHERE revision_id = ? ORDER BY file_version_number ASC"
  ).all(revisionId) as RevisionFileVersionRecord[];
}

export function getActiveRevisionFileVersion(revisionId: number): RevisionFileVersionRecord | undefined {
  return db.prepare(
    "SELECT * FROM revision_file_versions WHERE revision_id = ? AND is_active = 1 ORDER BY file_version_number DESC LIMIT 1"
  ).get(revisionId) as RevisionFileVersionRecord | undefined;
}

export function getNextRevisionFileVersionNumber(revisionId: number): number {
  const row = db.prepare(
    "SELECT COALESCE(MAX(file_version_number), 0) + 1 AS next_version FROM revision_file_versions WHERE revision_id = ?"
  ).get(revisionId) as { next_version: number };
  return row.next_version;
}

export function getCurrentRevisionForModel(modelId: number): ModelRevisionRecord | undefined {
  return db.prepare(
    "SELECT * FROM model_revisions WHERE model_id = ? AND is_current = 1 AND deleted_at IS NULL LIMIT 1"
  ).get(modelId) as ModelRevisionRecord | undefined;
}

export function listRevisionsForModel(modelId: number): ModelRevisionRecord[] {
  return db.prepare(
    "SELECT * FROM model_revisions WHERE model_id = ? AND deleted_at IS NULL ORDER BY revision_sort_order ASC"
  ).all(modelId) as ModelRevisionRecord[];
}

export function getNextNumericRevisionLabel(modelId: number): string {
  const rows = db.prepare("SELECT revision_label FROM model_revisions WHERE model_id = ?").all(modelId) as Array<{ revision_label: string }>;
  const numbers = rows
    .map((r) => Number(r.revision_label))
    .filter((num) => Number.isInteger(num) && num > 0);
  if (numbers.length === 0) {
    return "1";
  }
  return String(Math.max(...numbers) + 1);
}

export function createRevisionForModel(input: {
  modelId: number;
  revisionLabel?: string;
  issuedDate?: string;
  qualityPreset: string;
  status: string;
  sourceFilename: string;
  sourcePath: string | ((revisionId: number) => string);
  displayGlbPath: string | ((revisionId: number) => string);
  sourceSizeBytes: number;
  glbSizeBytes?: number | null;
  conversionJobId?: number | null;
  isCurrent?: number;
  isPubliclySelectable?: number;
}): ModelRevisionRecord {
  const modelId = input.modelId;
  const label = input.revisionLabel?.trim().replace(/\s+/g, " ") || getNextNumericRevisionLabel(modelId);

  let issuedDate = input.issuedDate;
  if (!issuedDate) {
    issuedDate = new Date().toISOString().slice(0, 10);
  }

  const maxSortRow = db.prepare("SELECT COALESCE(MAX(revision_sort_order), 0) AS max_sort FROM model_revisions WHERE model_id = ?").get(modelId) as { max_sort: number };
  const sortOrder = maxSortRow.max_sort + 1;
  const isCurrent = input.isCurrent ?? 0;
  const isPubliclySelectable = input.isPubliclySelectable ?? 1;

  db.exec("BEGIN TRANSACTION");
  try {
    if (isCurrent === 1) {
      db.prepare("UPDATE model_revisions SET is_current = 0 WHERE model_id = ?").run(modelId);
    }

    const res = db.prepare(`
      INSERT INTO model_revisions (
        model_id, revision_label, revision_sort_order, issued_date, quality_preset,
        status, is_current, is_publicly_selectable, source_filename, source_path,
        display_glb_path, source_size_bytes, glb_size_bytes, conversion_job_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      modelId,
      label,
      sortOrder,
      issuedDate,
      input.qualityPreset,
      input.status,
      isCurrent,
      isPubliclySelectable,
      input.sourceFilename,
      typeof input.sourcePath === "function" ? "" : input.sourcePath,
      typeof input.displayGlbPath === "function" ? "" : input.displayGlbPath,
      input.sourceSizeBytes,
      input.glbSizeBytes ?? null,
      input.conversionJobId ?? null
    );

    const revisionId = Number(res.lastInsertRowid);
    const sourcePath = typeof input.sourcePath === "function" ? input.sourcePath(revisionId) : input.sourcePath;
    const displayGlbPath = typeof input.displayGlbPath === "function" ? input.displayGlbPath(revisionId) : input.displayGlbPath;

    db.prepare(
      `UPDATE model_revisions
       SET source_path = ?, display_glb_path = ?
       WHERE id = ?`
    ).run(sourcePath, displayGlbPath, revisionId);

    db.prepare(`
      INSERT INTO revision_file_versions (
        revision_id, file_version_number, source_filename, source_path,
        display_glb_path, quality_preset, is_active
      ) VALUES (?, 1, ?, ?, ?, ?, 1)
    `).run(
      revisionId,
      input.sourceFilename,
      sourcePath,
      displayGlbPath,
      input.qualityPreset
    );

    if (isCurrent === 1) {
      db.prepare("UPDATE models SET current_revision_id = ? WHERE id = ?").run(revisionId, modelId);
      db.prepare("UPDATE models SET status = ?, glb_size_bytes = ?, original_size_bytes = ?, has_display_glb = ? WHERE id = ?").run(
        input.status,
        input.glbSizeBytes ?? null,
        input.sourceSizeBytes,
        input.status === "ready" ? 1 : 0,
        modelId
      );
    }

    db.exec("COMMIT");
    return getRevisionById(revisionId)!;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function setRevisionConversionJob(revisionId: number, jobId: number): void {
  db.prepare(
    `UPDATE model_revisions
     SET conversion_job_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(jobId, revisionId);
}

export function markRevisionViewerReady(revisionId: number, modelId: number, glbSizeBytes: number): void {
  const revision = getRevisionForModel(modelId, revisionId);
  if (!revision) throw new Error("Revision does not belong to model.");
  db.prepare(
    `UPDATE model_revisions
     SET status = 'ready', glb_size_bytes = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(glbSizeBytes, revisionId);
  if (revision.is_current === 1) {
    db.prepare(
      `UPDATE models
       SET status = 'ready', has_display_glb = 1, glb_size_bytes = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(glbSizeBytes, modelId);
  }
}

export function deleteRevisionById(revisionId: number): void {
  db.prepare("DELETE FROM model_revisions WHERE id = ?").run(revisionId);
}

export function setCurrentRevision(modelId: number, revisionId: number): ModelRevisionRecord {
  db.exec("BEGIN TRANSACTION");
  try {
    const revision = getRevisionForModel(modelId, revisionId);
    if (!revision) {
      throw new Error("Revision does not belong to model.");
    }
    db.prepare("UPDATE model_revisions SET is_current = 0, updated_at = CURRENT_TIMESTAMP WHERE model_id = ?").run(modelId);
    db.prepare("UPDATE model_revisions SET is_current = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(revisionId);
    db.prepare(
      `UPDATE models
       SET current_revision_id = ?,
           status = ?,
           has_display_glb = ?,
           glb_size_bytes = ?,
           original_size_bytes = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(
      revisionId,
      revision.status,
      revision.status === "ready" ? 1 : 0,
      revision.glb_size_bytes,
      revision.source_size_bytes,
      modelId
    );
    db.exec("COMMIT");
    return getRevisionById(revisionId)!;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function updateRevisionPublicSelectable(
  modelId: number,
  revisionId: number,
  isPubliclySelectable: boolean
): ModelRevisionRecord {
  const revision = getRevisionForModel(modelId, revisionId);
  if (!revision) {
    throw new Error("Revision does not belong to model.");
  }
  db.prepare(
    `UPDATE model_revisions
     SET is_publicly_selectable = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(isPubliclySelectable ? 1 : 0, revisionId);
  return getRevisionById(revisionId)!;
}

export function replaceRevisionFileVersion(input: {
  modelId: number;
  revisionId: number;
  sourceFilename: string;
  sourcePath: (fileVersionNumber: number) => string;
  displayGlbPath: (fileVersionNumber: number) => string;
  qualityPreset: string;
  replacementReason?: string | null;
  sourceSizeBytes: number;
  fileVersionNumber?: number;
}): { revision: ModelRevisionRecord; fileVersion: RevisionFileVersionRecord } {
  db.exec("BEGIN TRANSACTION");
  try {
    const revision = getRevisionForModel(input.modelId, input.revisionId);
    if (!revision) {
      throw new Error("Revision does not belong to model.");
    }
    const fileVersionNumber = getNextRevisionFileVersionNumber(input.revisionId);
    if (input.fileVersionNumber !== undefined && input.fileVersionNumber !== fileVersionNumber) {
      throw new Error("Revision file version changed during replacement upload.");
    }
    const sourcePath = input.sourcePath(fileVersionNumber);
    const displayGlbPath = input.displayGlbPath(fileVersionNumber);

    db.prepare(
      `UPDATE jobs
       SET status = 'cancelled',
           cancellation_requested_at = COALESCE(cancellation_requested_at, CURRENT_TIMESTAMP),
           completed_at = CURRENT_TIMESTAMP,
           message = 'Superseded by a replacement file upload.',
           updated_at = CURRENT_TIMESTAMP
       WHERE revision_id = ? AND status IN ('uploaded', 'queued', 'processing', 'cancelling')`
    ).run(input.revisionId);
    db.prepare("UPDATE revision_file_versions SET is_active = 0 WHERE revision_id = ? AND is_active = 1").run(input.revisionId);
    const inserted = db.prepare(
      `INSERT INTO revision_file_versions (
         revision_id, file_version_number, source_filename, source_path,
         display_glb_path, quality_preset, replacement_reason, is_active
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(
      input.revisionId,
      fileVersionNumber,
      input.sourceFilename,
      sourcePath,
      displayGlbPath,
      input.qualityPreset,
      input.replacementReason || null
    );
    db.prepare(
      `UPDATE model_revisions
       SET source_filename = ?, source_path = ?, display_glb_path = ?,
           quality_preset = ?, source_size_bytes = ?, glb_size_bytes = NULL,
           status = 'uploaded', conversion_job_id = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(
      input.sourceFilename,
      sourcePath,
      displayGlbPath,
      input.qualityPreset,
      input.sourceSizeBytes,
      input.revisionId
    );
    if (revision.is_current === 1) {
      db.prepare(
        `UPDATE models
         SET status = 'uploaded', has_display_glb = 0, glb_size_bytes = NULL,
             original_size_bytes = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).run(input.sourceSizeBytes, input.modelId);
    }
    db.exec("COMMIT");
    return {
      revision: getRevisionById(input.revisionId)!,
      fileVersion: db.prepare("SELECT * FROM revision_file_versions WHERE id = ?").get(inserted.lastInsertRowid) as RevisionFileVersionRecord
    };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function resolvePublicShareRevision(tokenHash: string): ModelRevisionRecord | undefined {
  const share = db.prepare("SELECT * FROM public_shares WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1").get(tokenHash) as PublicShareRecord & { link_mode?: string; revision_id?: number | null } | undefined;
  if (!share) return undefined;

  const linkMode = share.link_mode || "locked_revision";
  if (linkMode === "locked_revision") {
    if (share.revision_id) {
      const revision = getRevisionById(share.revision_id);
      return revision && revision.model_id === share.model_id && !revision.deleted_at ? revision : undefined;
    }
    return getCurrentRevisionForModel(share.model_id);
  } else if (linkMode === "latest_current") {
    return getCurrentRevisionForModel(share.model_id);
  }
  return undefined;
}
