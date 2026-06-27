#!/usr/bin/env node
// Phase 1 data migration: assign existing SQLite models to a default workspace.
//
// PostgreSQL holds the canonical users/organizations; SQLite models gain
// organization_id + created_by_user_id ownership columns. This script stamps all
// not-yet-assigned models with the chosen owner's "Personal Workspace".
//
// SAFE + REPEATABLE: only rows with organization_id IS NULL are updated, so it
// can be re-run. It FAILS LOUDLY if any model remains unassigned afterward.
//
// PREREQUISITES:
//   1. PostgreSQL is up and auth migrations have been applied
//      (start the server once with AUTH_ENABLED=true, or run the migrations).
//   2. The owner has signed in at least once so their user + Personal Workspace
//      exist (or pass --create-owner to provision a placeholder owner).
//   3. A confirmed backup of BOTH the SQLite DB and Postgres exists.
//
// USAGE (run from apps/server so `pg` resolves):
//   cd apps/server
//   DATABASE_URL=postgres://... DATA_DIR=/app/data \
//     node scripts/assign-models-to-default-org.mjs --owner-email you@example.com [--dry-run]
//
// ROLLBACK: restore the SQLite backup, or run:
//   UPDATE models SET organization_id = NULL, created_by_user_id = NULL
//   WHERE organization_id = '<org-id-printed-below>';

import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.split("=").slice(1).join("=");
  return fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

async function main() {
  const ownerEmail = (arg("owner-email") || "").trim().toLowerCase();
  const dryRun = hasFlag("dry-run");
  const createOwner = hasFlag("create-owner");
  const orgName = arg("org-name", "Personal Workspace");

  if (!ownerEmail) throw new Error("--owner-email is required.");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) throw new Error("DATA_DIR is required (used to locate the SQLite DB).");

  const sqlitePath = path.join(path.resolve(dataDir), "db", "app.sqlite");
  console.log(`SQLite: ${sqlitePath}`);
  console.log(`Owner:  ${ownerEmail}`);
  console.log(dryRun ? "Mode:   DRY RUN (no writes)\n" : "Mode:   APPLY\n");

  const pool = new Pool({ connectionString: databaseUrl });
  const db = new DatabaseSync(sqlitePath);

  try {
    // 1. Resolve owner user.
    let { rows } = await pool.query("SELECT id FROM users WHERE lower(primary_email) = $1", [ownerEmail]);
    let userId = rows[0]?.id;
    if (!userId) {
      if (!createOwner) {
        throw new Error(
          `No user found for ${ownerEmail}. Have them sign in first, or pass --create-owner to provision a placeholder.`
        );
      }
      userId = crypto.randomUUID();
      if (!dryRun) {
        await pool.query("INSERT INTO users (id, primary_email, status) VALUES ($1, $2, 'active')", [userId, ownerEmail]);
      }
      console.log(`Created placeholder owner user ${userId}`);
    }

    // 2. Resolve (or create) the owner's default workspace.
    let orgRes = await pool.query(
      "SELECT id FROM organizations WHERE owner_user_id = $1 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1",
      [userId]
    );
    let orgId = orgRes.rows[0]?.id;
    if (!orgId) {
      orgId = crypto.randomUUID();
      const slug = `${ownerEmail.split("@")[0].replace(/[^a-z0-9]+/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
      if (!dryRun) {
        await pool.query("INSERT INTO organizations (id, name, slug, owner_user_id) VALUES ($1, $2, $3, $4)", [orgId, orgName, slug, userId]);
        await pool.query(
          "INSERT INTO organization_memberships (id, organization_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active') ON CONFLICT (organization_id, user_id) DO NOTHING",
          [crypto.randomUUID(), orgId, userId]
        );
      }
      console.log(`Created default workspace ${orgId} ("${orgName}")`);
    } else {
      console.log(`Using existing workspace ${orgId}`);
    }

    // 3. Stamp unassigned models.
    const before = db.prepare("SELECT COUNT(*) AS n FROM models WHERE organization_id IS NULL").get().n;
    console.log(`\nModels without a workspace: ${before}`);
    if (!dryRun && before > 0) {
      const result = db
        .prepare("UPDATE models SET organization_id = ?, created_by_user_id = COALESCE(created_by_user_id, ?) WHERE organization_id IS NULL")
        .run(orgId, userId);
      console.log(`Updated ${result.changes} model rows.`);
    }

    // 4. Verify completeness — fail loudly if partially complete.
    if (!dryRun) {
      const remaining = db.prepare("SELECT COUNT(*) AS n FROM models WHERE organization_id IS NULL").get().n;
      if (remaining > 0) {
        throw new Error(`Migration incomplete: ${remaining} models still have no organization_id.`);
      }
      console.log("\nAll models are assigned. organization_id =", orgId);
    } else {
      console.log("\nDry run complete. Re-run without --dry-run to apply.");
    }
  } finally {
    db.close();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("\nFAILED:", error.message);
  process.exit(1);
});
