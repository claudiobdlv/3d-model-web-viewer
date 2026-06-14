import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dbRoot } from "./storage.js";

export type ModelRecord = {
  id: number;
  slug: string;
  name: string;
  source_filename: string;
  source_ext: string;
  status: string;
  has_display_glb: number;
  created_at: string;
  updated_at: string;
};

export type JobRecord = {
  id: number;
  model_id: number;
  model_slug: string;
  type: string;
  status: string;
  message: string | null;
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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id INTEGER NOT NULL,
      model_slug TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
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
}

function ensureColumn(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((existing) => existing.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function listModels(): ModelRecord[] {
  return db.prepare("SELECT * FROM models ORDER BY created_at DESC, id DESC").all() as ModelRecord[];
}

export function getModelBySlug(slug: string): ModelRecord | undefined {
  return db.prepare("SELECT * FROM models WHERE slug = ?").get(slug) as ModelRecord | undefined;
}

export function createModel(input: {
  slug: string;
  name: string;
  sourceFilename: string;
  sourceExt: string;
  status: string;
  hasDisplayGlb: boolean;
}): ModelRecord {
  const result = db
    .prepare(
      `INSERT INTO models (slug, name, source_filename, source_ext, status, has_display_glb)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.slug,
      input.name,
      input.sourceFilename,
      input.sourceExt,
      input.status,
      input.hasDisplayGlb ? 1 : 0
    );

  return db.prepare("SELECT * FROM models WHERE id = ?").get(result.lastInsertRowid) as ModelRecord;
}

export function createJob(input: {
  modelId: number;
  modelSlug: string;
  type: string;
  status: string;
  message?: string;
}): JobRecord {
  const result = db
    .prepare(
      `INSERT INTO jobs (model_id, model_slug, type, status, message)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(input.modelId, input.modelSlug, input.type, input.status, input.message ?? null);

  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(result.lastInsertRowid) as JobRecord;
}

export function listJobs(): JobRecord[] {
  return db.prepare("SELECT * FROM jobs ORDER BY created_at DESC, id DESC").all() as JobRecord[];
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

export function markJobReady(jobId: number, message = "Worker completed fake processing."): void {
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
         updated_at = CURRENT_TIMESTAMP
     WHERE id = (SELECT model_id FROM jobs WHERE id = ?)`
  ).run(jobId);
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
