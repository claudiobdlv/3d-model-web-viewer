import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dbRoot, getModelDir } from "./storage.js";
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

const dbPath = path.join(dbRoot, "app.sqlite");
fs.mkdirSync(dbRoot, { recursive: true });
export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");

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
  `);

  ensureColumn("jobs", "started_at", "TEXT");
  ensureColumn("jobs", "completed_at", "TEXT");
  ensureColumn("jobs", "failed_at", "TEXT");
  ensureColumn("jobs", "quality", "TEXT NOT NULL DEFAULT 'medium'");
  ensureColumn("models", "folder_id", "INTEGER REFERENCES folders(id)");
  ensureColumn("models", "glb_size_bytes", "INTEGER");
  backfillGlbSizes();
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

function ensureColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((existing) => existing.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function listModels(filter: { folderId?: number | null; unsortedOnly?: boolean } = {}): ModelRecord[] {
  if (filter.unsortedOnly) {
    return db
      .prepare("SELECT * FROM models WHERE folder_id IS NULL ORDER BY created_at DESC, id DESC")
      .all() as ModelRecord[];
  }

  if (typeof filter.folderId === "number") {
    return db
      .prepare("SELECT * FROM models WHERE folder_id = ? ORDER BY created_at DESC, id DESC")
      .all(filter.folderId) as ModelRecord[];
  }

  return db.prepare("SELECT * FROM models ORDER BY created_at DESC, id DESC").all() as ModelRecord[];
}

export function getModelBySlug(slug: string): ModelRecord | undefined {
  return db.prepare("SELECT * FROM models WHERE slug = ?").get(slug) as ModelRecord | undefined;
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
  folderId?: number | null;
}): ModelRecord {
  const result = db
    .prepare(
      `INSERT INTO models (slug, name, source_filename, source_ext, status, has_display_glb, glb_size_bytes, folder_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.slug,
      input.name,
      input.sourceFilename,
      input.sourceExt,
      input.status,
      input.hasDisplayGlb ? 1 : 0,
      input.glbSizeBytes ?? null,
      input.folderId ?? null
    );

  return db.prepare("SELECT * FROM models WHERE id = ?").get(result.lastInsertRowid) as ModelRecord;
}

export function createJob(input: {
  modelId: number;
  modelSlug: string;
  type: string;
  status: string;
  message?: string;
  quality?: ConversionQuality;
}): JobRecord {
  const quality = parseConversionQuality(input.quality);
  const result = db
    .prepare(
      `INSERT INTO jobs (model_id, model_slug, type, status, message, quality)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(input.modelId, input.modelSlug, input.type, input.status, input.message ?? null, quality);

  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(result.lastInsertRowid) as JobRecord;
}

export function listJobs(): JobRecord[] {
  return db.prepare("SELECT * FROM jobs ORDER BY created_at DESC, id DESC").all() as JobRecord[];
}

export function listFolders(): FolderRecord[] {
  return db
    .prepare(
      `SELECT folders.*,
              COUNT(models.id) AS model_count
       FROM folders
       LEFT JOIN models ON models.folder_id = folders.id
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
     WHERE slug = ?`
  ).run(folderId, slug);

  return getModelBySlug(slug);
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

export function getNextWorkerJob(): WorkerJobRecord | undefined {
  return db
    .prepare(
      `SELECT jobs.*, models.source_filename, models.source_ext
       FROM jobs
       JOIN models ON models.id = jobs.model_id
       WHERE jobs.type = 'step-to-glb'
         AND jobs.status IN ('uploaded', 'queued')
         AND models.source_ext IN ('.step', '.stp')
       ORDER BY jobs.created_at ASC, jobs.id ASC
       LIMIT 1`
    )
    .get() as WorkerJobRecord | undefined;
}

export function getJobForWorker(jobId: number): WorkerJobRecord | undefined {
  return db
    .prepare(
      `SELECT jobs.*, models.source_filename, models.source_ext
       FROM jobs
       JOIN models ON models.id = jobs.model_id
       WHERE jobs.id = ?`
    )
    .get(jobId) as WorkerJobRecord | undefined;
}

export function markJobProcessing(jobId: number): void {
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

  db.prepare(
    `UPDATE models
     SET status = 'processing',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = (SELECT model_id FROM jobs WHERE id = ?)`
  ).run(jobId);
}

export function markJobReady(jobId: number, message = "Worker completed fake processing.", glbSizeBytes?: number): void {
  db.prepare(
    `UPDATE jobs
     SET status = 'ready',
         message = ?,
         updated_at = CURRENT_TIMESTAMP,
         completed_at = CURRENT_TIMESTAMP,
         failed_at = NULL
     WHERE id = ?`
  ).run(message, jobId);

  db.prepare(
    `UPDATE models
     SET status = 'ready',
         has_display_glb = 1,
         glb_size_bytes = COALESCE(?, glb_size_bytes),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = (SELECT model_id FROM jobs WHERE id = ?)`
  ).run(glbSizeBytes ?? null, jobId);
}

export function markJobFailed(jobId: number, message: string): void {
  db.prepare(
    `UPDATE jobs
     SET status = 'failed',
         message = ?,
         updated_at = CURRENT_TIMESTAMP,
         failed_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(message, jobId);

  db.prepare(
    `UPDATE models
     SET status = 'failed',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = (SELECT model_id FROM jobs WHERE id = ?)`
  ).run(jobId);
}
