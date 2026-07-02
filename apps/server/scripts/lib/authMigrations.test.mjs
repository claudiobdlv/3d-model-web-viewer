import assert from "node:assert/strict";
import test from "node:test";
import { readMigrationFiles, applyMigrations, defaultMigrationsDir } from "./authMigrations.mjs";

// A minimal pg-Pool-compatible fake so migration logic can be exercised without
// a real PostgreSQL server. It records every statement and tracks which
// migrations have been "applied" via the schema_migrations INSERTs.
function makeFakePool({ alreadyApplied = [] } = {}) {
  const applied = new Set(alreadyApplied);
  const poolLog = [];
  const clientLog = [];

  const client = {
    query: async (text, params) => {
      clientLog.push(text.trim());
      if (/INSERT INTO schema_migrations/.test(text)) applied.add(params[0]);
      return { rows: [] };
    },
    release: () => {
      clientLog.push("RELEASE");
    }
  };

  const pool = {
    query: async (text, params) => {
      poolLog.push(text.trim());
      if (/SELECT 1 FROM schema_migrations WHERE name/.test(text)) {
        return { rows: applied.has(params[0]) ? [{ ok: 1 }] : [] };
      }
      return { rows: [] };
    },
    connect: async () => client
  };

  return { pool, poolLog, clientLog, applied };
}

test("readMigrationFiles returns the on-disk migrations in sorted order", () => {
  const files = readMigrationFiles(defaultMigrationsDir);
  assert.ok(files.length >= 2, "expected at least the two known auth migrations");
  const names = files.map((f) => f.name);
  assert.deepEqual([...names].sort(), names, "files must be sorted by name");
  assert.ok(names.includes("0001_auth_init.sql"));
  for (const f of files) assert.ok(typeof f.sql === "string" && f.sql.length > 0);
});

test("applyMigrations applies every migration once on a fresh database", async () => {
  const { pool, clientLog, applied } = makeFakePool();
  const result = await applyMigrations(pool);

  const names = readMigrationFiles(defaultMigrationsDir).map((f) => f.name);
  assert.deepEqual(result, names, "all discovered migrations should be applied");
  // Each migration ran inside its own BEGIN/COMMIT (never a bare ROLLBACK).
  assert.equal(clientLog.filter((q) => q === "BEGIN").length, names.length);
  assert.equal(clientLog.filter((q) => q === "COMMIT").length, names.length);
  assert.ok(!clientLog.includes("ROLLBACK"));
  for (const name of names) assert.ok(applied.has(name));
});

test("applyMigrations is idempotent: nothing to apply when all already recorded", async () => {
  const names = readMigrationFiles(defaultMigrationsDir).map((f) => f.name);
  const { pool, clientLog } = makeFakePool({ alreadyApplied: names });
  const result = await applyMigrations(pool);
  assert.deepEqual(result, [], "no migrations should be applied a second time");
  assert.ok(!clientLog.includes("BEGIN"), "no transaction should be opened when up to date");
});

test("applyMigrations rolls back and rethrows if a migration statement fails", async () => {
  const { pool } = makeFakePool();
  const failingClient = {
    calls: [],
    query: async function (text) {
      this.calls.push(text.trim());
      if (text.includes("CREATE TABLE") || /INSERT INTO schema_migrations/.test(text)) {
        throw new Error("boom");
      }
      return { rows: [] };
    },
    release: () => {}
  };
  // Force the migration body to fail by swapping connect() to hand back a client
  // whose SQL execution throws.
  pool.connect = async () => failingClient;
  await assert.rejects(() => applyMigrations(pool), /Migration .* failed: boom/);
  assert.ok(failingClient.calls.includes("ROLLBACK"), "a failed migration must ROLLBACK");
});
