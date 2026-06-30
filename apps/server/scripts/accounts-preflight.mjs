#!/usr/bin/env node
// Accounts enablement preflight — READ-ONLY readiness check.
//
// Reports whether the environment is ready to enable Google sign-in WITHOUT
// changing anything: it does not enable auth, does not run migrations, does not
// write to any database, and never prints secret VALUES (only whether a
// variable is set). Safe to run against production.
//
// USAGE (run from apps/server so optional `pg` resolves):
//   cd apps/server
//   node scripts/accounts-preflight.mjs            # env + SQLite readiness
//   node scripts/accounts-preflight.mjs --check-db # also test Postgres connectivity (read-only)
//   node scripts/accounts-preflight.mjs --json     # machine-readable output
//
// SQLite location is derived from DATA_DIR (as the server does):
//   ${DATA_DIR}/db/app.sqlite
//
// Exit code is 0 for a completed check (including "NOT READY" findings); it is
// non-zero only when an explicitly requested step fails (e.g. --check-db cannot
// connect) or on an unexpected error.

import path from "node:path";
import fs from "node:fs";

const hasFlag = (name) => process.argv.includes(`--${name}`);
const wantJson = hasFlag("json");
const wantDb = hasFlag("check-db");
const wantHelp = hasFlag("help") || hasFlag("h");

if (wantHelp) {
  console.log("Usage: node scripts/accounts-preflight.mjs [--check-db] [--json]");
  process.exit(0);
}

const env = process.env;
const isSet = (name) => typeof env[name] === "string" && env[name].trim() !== "";
const bool = (value, fallback = false) =>
  value === undefined ? fallback : /^(1|true|yes|on)$/i.test(String(value).trim());

const report = {
  ready: false,
  auth: {},
  env: {},
  sqlite: {},
  postgres: { checked: false },
  blockers: [],
  notes: []
};

// --- Auth flag + provider config (non-secret values shown) ---------------
const authEnabled = bool(env.AUTH_ENABLED, false);
report.auth.AUTH_ENABLED = env.AUTH_ENABLED ?? "(unset → false)";
report.auth.AUTH_PROVIDERS = env.AUTH_PROVIDERS ?? "(unset → google)";
report.auth.SESSION_COOKIE_SECURE = env.SESSION_COOKIE_SECURE ?? "(unset)";
report.auth.NODE_ENV = env.NODE_ENV ?? "(unset)";

const allowedEmails = (env.AUTH_ALLOWED_EMAILS || "")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);
// Count only — never echo the allow-list emails (PII).
report.auth.AUTH_ALLOWED_EMAILS = isSet("AUTH_ALLOWED_EMAILS")
  ? `present (${allowedEmails.length} ${allowedEmails.length === 1 ? "entry" : "entries"})`
  : "MISSING";

// --- Required env presence (secret values never printed) -----------------
// Each entry: name -> whether merely-present is enough to be "ready".
const requiredEnv = [
  "APP_BASE_URL",
  "SESSION_SECRET",
  "DATABASE_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET"
];
for (const name of requiredEnv) {
  report.env[name] = isSet(name) ? "present" : "MISSING";
}

// --- Readiness rules (do NOT mutate anything) ----------------------------
if (!isSet("AUTH_ALLOWED_EMAILS")) {
  report.blockers.push("AUTH_ALLOWED_EMAILS is not set (required: fail-closed admin allow-list).");
}
for (const name of requiredEnv) {
  if (!isSet(name)) report.blockers.push(`${name} is not set.`);
}
const secureCookies = bool(env.SESSION_COOKIE_SECURE, env.NODE_ENV === "production");
if (env.NODE_ENV === "production" && !secureCookies && !bool(env.ALLOW_INSECURE_SESSION)) {
  report.blockers.push(
    "SESSION_COOKIE_SECURE must be true in production (or ALLOW_INSECURE_SESSION=true for a deliberate non-HTTPS override)."
  );
}
if (authEnabled) {
  report.notes.push("AUTH_ENABLED is already true in this environment.");
}

// --- SQLite read-only inspection -----------------------------------------
const dataDir = env.DATA_DIR;
if (!dataDir) {
  report.sqlite.status = "skipped (DATA_DIR not set)";
} else {
  const sqlitePath = path.join(path.resolve(dataDir), "db", "app.sqlite");
  report.sqlite.path = sqlitePath;
  if (!fs.existsSync(sqlitePath)) {
    report.sqlite.status = "skipped (SQLite file not found)";
  } else {
    try {
      const { DatabaseSync } = await import("node:sqlite");
      // Open read-only: this never creates or migrates the database.
      const db = new DatabaseSync(sqlitePath, { readOnly: true });
      try {
        const totalModels = db.prepare("SELECT COUNT(*) AS n FROM models WHERE deleted_at IS NULL").get().n;
        const unassigned = db
          .prepare("SELECT COUNT(*) AS n FROM models WHERE organization_id IS NULL AND deleted_at IS NULL")
          .get().n;
        const activeShares = db
          .prepare("SELECT COUNT(*) AS n FROM public_shares WHERE revoked_at IS NULL AND public_token IS NOT NULL")
          .get().n;
        report.sqlite.status = "ok";
        report.sqlite.totalModels = totalModels;
        report.sqlite.modelsMissingOrganizationId = unassigned;
        report.sqlite.activePublicShares = activeShares;
        // Dry-run model-assignment status (no writes performed here).
        report.sqlite.assignmentDryRun =
          unassigned === 0
            ? "all models already have organization_id (assignment would be a no-op)"
            : `${unassigned} model(s) would be stamped by assign-models-to-default-org.mjs`;
        if (authEnabled && unassigned > 0) {
          report.notes.push(
            `${unassigned} model(s) lack organization_id while AUTH_ENABLED=true — run the assignment script before relying on workspace scoping.`
          );
        }
      } finally {
        db.close();
      }
    } catch (error) {
      report.sqlite.status = `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

// --- Optional Postgres connectivity (only with --check-db) ---------------
let dbCheckFailed = false;
if (wantDb) {
  report.postgres.checked = true;
  if (!isSet("DATABASE_URL")) {
    report.postgres.status = "skipped (DATABASE_URL not set)";
  } else {
    let pool;
    try {
      const { Pool } = await import("pg");
      pool = new Pool({ connectionString: env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
      await pool.query("SELECT 1");
      // Read-only: report whether auth migrations have run, never apply them.
      const migra = await pool.query(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations') AS present"
      );
      const migrationsTable = Boolean(migra.rows[0]?.present);
      let appliedCount = 0;
      if (migrationsTable) {
        const applied = await pool.query("SELECT COUNT(*)::int AS n FROM schema_migrations");
        appliedCount = applied.rows[0]?.n ?? 0;
      }
      report.postgres.status = "connected";
      report.postgres.schemaMigrationsTable = migrationsTable ? "present" : "absent (migrations not yet run)";
      report.postgres.appliedMigrations = appliedCount;
    } catch (error) {
      dbCheckFailed = true;
      report.postgres.status = `error: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (pool) await pool.end().catch(() => undefined);
    }
  }
}

report.ready = report.blockers.length === 0;

// --- Output --------------------------------------------------------------
if (wantJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const line = (k, v) => console.log(`  ${k.padEnd(28)} ${v}`);
  console.log("\nAccounts enablement preflight (read-only)\n");
  console.log("Auth configuration:");
  for (const [k, v] of Object.entries(report.auth)) line(k, v);
  console.log("\nRequired env (presence only, values never shown):");
  for (const [k, v] of Object.entries(report.env)) line(k, v);
  console.log("\nSQLite (read-only):");
  for (const [k, v] of Object.entries(report.sqlite)) line(k, v);
  if (report.postgres.checked) {
    console.log("\nPostgres (--check-db, read-only):");
    for (const [k, v] of Object.entries(report.postgres)) if (k !== "checked") line(k, v);
  } else {
    console.log("\nPostgres: not checked (pass --check-db to test connectivity).");
  }
  if (report.notes.length) {
    console.log("\nNotes:");
    for (const note of report.notes) console.log(`  - ${note}`);
  }
  console.log(`\nReadiness: ${report.ready ? "READY (env complete)" : "NOT READY"}`);
  if (!report.ready) {
    console.log("Blockers:");
    for (const b of report.blockers) console.log(`  - ${b}`);
  }
  console.log("\nThis check made no changes. It did not enable auth or run migrations.\n");
}

// Non-zero only when an explicitly requested step failed.
process.exit(dbCheckFailed ? 2 : 0);
