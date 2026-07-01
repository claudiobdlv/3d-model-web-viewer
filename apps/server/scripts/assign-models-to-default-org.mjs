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
//   # Always review a dry run first — makes no writes, no matter what:
//   DATABASE_URL=postgres://... DATA_DIR=/app/data \
//     node scripts/assign-models-to-default-org.mjs --owner-email you@example.com --dry-run
//
//   # Real run requires an explicit backup acknowledgement (see below):
//   DATABASE_URL=postgres://... DATA_DIR=/app/data \
//     node scripts/assign-models-to-default-org.mjs --owner-email you@example.com \
//     --require-backup-confirmation
//
// SAFETY GUARD: a real (non---dry-run) invocation refuses to write anything
// unless --require-backup-confirmation is also passed. This is a deliberate
// speed bump, not a technical backup check — it does not itself take or verify
// a backup. Take the backups first (see docs/accounts-enable-runbook.md).
//
// ROLLBACK: restore the SQLite backup, or run:
//   UPDATE models SET organization_id = NULL, created_by_user_id = NULL
//   WHERE organization_id = '<org-id-printed-below>';

import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { getAssignmentCounts, findSuspiciousModels } from "./lib/modelAssignmentReport.mjs";

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
  const backupConfirmed = hasFlag("require-backup-confirmation");

  if (!ownerEmail) throw new Error("--owner-email is required.");
  if (!dryRun && !backupConfirmed) {
    throw new Error(
      "Refusing to write: a real run requires --require-backup-confirmation.\n" +
        "  This is a speed bump, not a backup check — confirm you have BOTH a SQLite\n" +
        "  and a PostgreSQL backup before passing it. Re-run with --dry-run first if\n" +
        "  you have not already reviewed one."
    );
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) throw new Error("DATA_DIR is required (used to locate the SQLite DB).");

  const sqlitePath = path.join(path.resolve(dataDir), "db", "app.sqlite");
  console.log(`SQLite: ${sqlitePath}`);
  console.log(`Owner:  ${ownerEmail}`);
  console.log(dryRun ? "Mode:   DRY RUN (no writes)\n" : "Mode:   APPLY (backup confirmed)\n");

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
        console.log(`Created placeholder owner user ${userId}`);
      } else {
        console.log(`Would create placeholder owner user for ${ownerEmail} (dry run)`);
      }
    }

    // 2. Resolve (or plan) the owner's default workspace.
    let orgRes = await pool.query(
      "SELECT id, name FROM organizations WHERE owner_user_id = $1 AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1",
      [userId]
    );
    let orgId = orgRes.rows[0]?.id;
    let resolvedOrgName = orgRes.rows[0]?.name;
    if (!orgId) {
      orgId = crypto.randomUUID();
      resolvedOrgName = orgName;
      const slug = `${ownerEmail.split("@")[0].replace(/[^a-z0-9]+/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
      if (!dryRun) {
        await pool.query("INSERT INTO organizations (id, name, slug, owner_user_id) VALUES ($1, $2, $3, $4)", [orgId, orgName, slug, userId]);
        await pool.query(
          "INSERT INTO organization_memberships (id, organization_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active') ON CONFLICT (organization_id, user_id) DO NOTHING",
          [crypto.randomUUID(), orgId, userId]
        );
        console.log(`Created default workspace ${orgId} ("${orgName}")`);
      } else {
        console.log(`Would create default workspace "${orgName}" (id assigned at apply time; dry run)`);
      }
    } else {
      console.log(`Using existing workspace ${orgId} ("${resolvedOrgName}")`);
    }

    // 3. Report current assignment state (before any write).
    const { totalModels, unassigned, alreadyAssigned } = getAssignmentCounts(db);
    console.log(`\nTarget workspace:            ${orgId} ("${resolvedOrgName ?? orgName}")`);
    console.log(`Total models:                ${totalModels}`);
    console.log(`Already assigned:            ${alreadyAssigned}`);
    console.log(`Would be assigned this run:  ${unassigned}`);

    const suspicious = findSuspiciousModels(db);
    if (suspicious.length) {
      console.log(`\nSuspicious models (${suspicious.length}) — review before applying:`);
      for (const line of suspicious) console.log(`  - ${line}`);
    } else {
      console.log("\nNo suspicious models found.");
    }

    // 4. Stamp unassigned models (real run only).
    if (!dryRun && unassigned > 0) {
      const result = db
        .prepare("UPDATE models SET organization_id = ?, created_by_user_id = COALESCE(created_by_user_id, ?) WHERE organization_id IS NULL")
        .run(orgId, userId);
      console.log(`\nUpdated ${result.changes} model rows.`);
    }

    // 5. Verify completeness — fail loudly if partially complete.
    if (!dryRun) {
      const remaining = db.prepare("SELECT COUNT(*) AS n FROM models WHERE organization_id IS NULL").get().n;
      if (remaining > 0) {
        throw new Error(`Migration incomplete: ${remaining} models still have no organization_id.`);
      }
      console.log("\nAll models are assigned. organization_id =", orgId);
    } else {
      console.log("\nDry run complete. No database was modified.");
      console.log("Re-run with --require-backup-confirmation (after taking backups) to apply.");
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
