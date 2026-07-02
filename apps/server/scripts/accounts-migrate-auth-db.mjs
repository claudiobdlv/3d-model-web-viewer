#!/usr/bin/env node
// Accounts auth DB migration — explicit, safe rehearsal runner.
//
// Applies the PostgreSQL auth-layer migrations (src/auth/migrations/*.sql)
// against DATABASE_URL WITHOUT enabling accounts and WITHOUT starting the web
// app. This exists so the migration step can be rehearsed independently of the
// server bootstrap, which only runs migrations when AUTH_ENABLED=true.
//
// It deliberately does NOT:
//   * read or require AUTH_ENABLED (migrations are independent of the flag,
//     and this script never sets it)
//   * start the HTTP server or mount the accounts router
//   * touch the SQLite models database (models/jobs/shares are untouched)
//   * print secret values — it only prints migration file names and counts
//
// USAGE (run from apps/server so the optional `pg` dependency resolves):
//   cd apps/server
//   DATABASE_URL=postgres://... node scripts/accounts-migrate-auth-db.mjs
//   DATABASE_URL=postgres://... node scripts/accounts-migrate-auth-db.mjs --dry-run
//   node scripts/accounts-migrate-auth-db.mjs --help
//
// Idempotent: each migration is applied at most once (tracked in
// schema_migrations); re-running is a no-op. Exit code is 0 on success and
// non-zero on a connection or migration failure.

import { readMigrationFiles, applyMigrations, defaultMigrationsDir } from "./lib/authMigrations.mjs";

const hasFlag = (name) => process.argv.includes(`--${name}`);

if (hasFlag("help") || hasFlag("h")) {
  console.log("Usage: DATABASE_URL=postgres://... node scripts/accounts-migrate-auth-db.mjs [--dry-run]");
  console.log("Applies auth-layer Postgres migrations. Does not enable auth, start the app, or touch SQLite.");
  process.exit(0);
}

const dryRun = hasFlag("dry-run");

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  const files = readMigrationFiles(defaultMigrationsDir);
  console.log(`Auth migrations directory: ${defaultMigrationsDir}`);
  console.log(`Discovered ${files.length} migration file(s):`);
  for (const { name } of files) console.log(`  - ${name}`);

  if (dryRun) {
    console.log("\nDRY RUN: no database connection opened, no migrations applied.");
    console.log("Re-run without --dry-run (with Postgres reachable) to apply.");
    return;
  }

  // Import pg lazily so --help / --dry-run / missing-DATABASE_URL paths never
  // require the driver to be installed or a connection to be attempted.
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 10000 });
  try {
    const applied = await applyMigrations(pool);
    if (applied.length) {
      console.log(`\nApplied ${applied.length} migration(s): ${applied.join(", ")}`);
    } else {
      console.log("\nNo migrations to apply — the auth database is already up to date.");
    }
    console.log("Auth DB migrations complete. Auth remains disabled; the web app was not started.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("\nFAILED:", error.message);
  process.exit(1);
});
