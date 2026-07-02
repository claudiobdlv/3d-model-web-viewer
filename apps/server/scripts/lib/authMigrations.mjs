// Auth-layer Postgres migration helpers shared by
// accounts-migrate-auth-db.mjs and its tests.
//
// This intentionally MIRRORS runMigrations() in src/auth/pgStore.ts so the
// explicit rehearsal script can apply the exact same migrations WITHOUT
// importing the auth subsystem (and therefore without any risk of pulling in
// AUTH_ENABLED / server bootstrap side effects). The SQL files are the single
// source of truth; both paths read the same files from src/auth/migrations.
//
// None of these helpers enable auth, start the web app, or touch SQLite.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// scripts/lib -> apps/server/src/auth/migrations
export const defaultMigrationsDir = path.resolve(__dirname, "..", "..", "src", "auth", "migrations");

// Read the ordered list of migration files (name + SQL). Sorted lexically so
// the numeric filename prefixes (0001_, 0002_, ...) define apply order.
export function readMigrationFiles(dir = defaultMigrationsDir) {
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), "utf8") }));
}

// Apply every not-yet-applied migration once, each inside its own transaction,
// recording it in schema_migrations. Idempotent: re-running applies nothing.
// `pool` must expose `query(text, params)` and `connect()` (a pg Pool, or a
// compatible fake in tests). Returns the names of migrations applied this run.
export async function applyMigrations(pool, dir = defaultMigrationsDir) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const files = readMigrationFiles(dir);
  const applied = [];
  for (const { name, sql } of files) {
    const { rows } = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
    if (rows.length > 0) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      applied.push(name);
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      client.release();
    }
  }
  return applied;
}
