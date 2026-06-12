import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { storageRoot } from "./storage.js";

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
};

const dbPath = path.join(storageRoot, "viewer.sqlite");
fs.mkdirSync(storageRoot, { recursive: true });
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
      FOREIGN KEY (model_id) REFERENCES models(id)
    );
  `);
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
