import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";

test("RevVault Revisions and Storage System Tests", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "revvault-revisions-test-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;

  // Dynamically import db and storage
  const { 
    db, 
    initDb,
    backfillModelRevisions, 
    createRevisionForModel,
    getCurrentRevisionForModel,
    listRevisionsForModel,
    getRevisionById,
    getNextNumericRevisionLabel,
    resolvePublicShareRevision,
    markJobReady,
    setCurrentRevision
  } = await import("./db.js");

  // Initialize DB tables
  initDb();

  const {
    getLegacyModelDir,
    getLegacyUploadDir,
    getRevisionModelDir,
    getRevisionUploadDir,
    resolveDisplayGlbPath,
    resolveSourcePath,
    getRevisionLogDir
  } = await import("./storage.js");

  t.after(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // Verify tables were created by initDb
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  const tableNames = tables.map((t) => t.name);
  assert.ok(tableNames.includes("model_revisions"));
  assert.ok(tableNames.includes("revision_file_versions"));

  // Check columns added by ensureColumn
  const publicShareCols = db.prepare("PRAGMA table_info(public_shares)").all() as Array<{ name: string }>;
  const publicShareColNames = publicShareCols.map((c) => c.name);
  assert.ok(publicShareColNames.includes("revision_id"));
  assert.ok(publicShareColNames.includes("link_mode"));

  const modelCols = db.prepare("PRAGMA table_info(models)").all() as Array<{ name: string }>;
  assert.ok(modelCols.map((c) => c.name).includes("current_revision_id"));

  const jobCols = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  assert.ok(jobCols.map((c) => c.name).includes("revision_id"));

  // 1. Idempotent backfill from legacy model to Rev 1
  // Create a legacy model manually
  const modelRes = db.prepare(`
    INSERT INTO models (slug, name, source_filename, source_ext, status, has_display_glb, glb_size_bytes, original_size_bytes)
    VALUES ('test-legacy-slug', 'Legacy Model', 'model.step', '.step', 'ready', 1, 500, 1000)
  `).run();
  const modelId = Number(modelRes.lastInsertRowid);

  // Insert a job for this model
  const jobRes = db.prepare(`
    INSERT INTO jobs (model_id, model_slug, type, status, quality)
    VALUES (?, 'test-legacy-slug', 'step-to-glb', 'ready', 'high')
  `).run(modelId);
  const jobId = Number(jobRes.lastInsertRowid);

  // Insert a public share for this model
  const shareToken = "S".repeat(43);
  const shareTokenHash = crypto.createHash("sha256").update(shareToken).digest("hex");
  db.prepare(`
    INSERT INTO public_shares (id, model_id, token_hash, token_prefix)
    VALUES (?, ?, ?, 'S')
  `).run(crypto.randomUUID(), modelId, shareTokenHash);

  // Run backfill
  backfillModelRevisions();

  // Verify a revision was created
  const revisions = listRevisionsForModel(modelId);
  assert.equal(revisions.length, 1);
  const rev1 = revisions[0];
  assert.equal(rev1.revision_label, "1");
  assert.equal(rev1.revision_sort_order, 1);
  assert.equal(rev1.is_current, 1);
  assert.equal(rev1.is_publicly_selectable, 1);
  assert.equal(rev1.quality_preset, "high");
  assert.equal(rev1.status, "ready");
  assert.equal(rev1.source_filename, "model.step");
  assert.equal(rev1.source_path, "uploads/test-legacy-slug/original.step");
  assert.equal(rev1.display_glb_path, "models/test-legacy-slug/display.glb");
  assert.equal(rev1.source_size_bytes, 1000);
  assert.equal(rev1.glb_size_bytes, 500);
  assert.equal(rev1.conversion_job_id, jobId);

  // Verify file version was created
  const fileVersions = db.prepare("SELECT * FROM revision_file_versions WHERE revision_id = ?").all(rev1.id) as any[];
  assert.equal(fileVersions.length, 1);
  assert.equal(fileVersions[0].file_version_number, 1);
  assert.equal(fileVersions[0].is_active, 1);
  assert.equal(fileVersions[0].source_path, "uploads/test-legacy-slug/original.step");

  // Verify models, jobs, public_shares are updated
  const updatedModel = db.prepare("SELECT * FROM models WHERE id = ?").get(modelId) as any;
  assert.equal(updatedModel.current_revision_id, rev1.id);

  const updatedJob = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as any;
  assert.equal(updatedJob.revision_id, rev1.id);

  const updatedShare = db.prepare("SELECT * FROM public_shares WHERE token_hash = ?").get(shareTokenHash) as any;
  assert.equal(updatedShare.revision_id, rev1.id);
  assert.equal(updatedShare.link_mode, "locked_revision");

  // 2. Idempotency: Run backfill again, confirm it does not duplicate
  backfillModelRevisions();
  const revisionsAfter = listRevisionsForModel(modelId);
  assert.equal(revisionsAfter.length, 1);

  // 3. Path Resolution Tests
  // Legacy paths
  assert.equal(getLegacyModelDir("test-slug").endsWith(path.join("models", "test-slug")), true);
  assert.equal(getLegacyUploadDir("test-slug").endsWith(path.join("uploads", "test-slug")), true);
  
  // Revision-specific paths
  assert.equal(getRevisionModelDir("test-slug", 42).endsWith(path.join("models", "test-slug", "revisions", "42")), true);
  assert.equal(getRevisionUploadDir("test-slug", 42).endsWith(path.join("uploads", "test-slug", "revisions", "42")), true);
  assert.equal(getRevisionLogDir("test-slug", 42).endsWith(path.join("logs", "test-slug", "revisions", "42")), true);

  // resolveDisplayGlbPath
  // Legacy fallback (no revision)
  const legacyGlb = resolveDisplayGlbPath({ slug: "test-legacy" });
  assert.equal(legacyGlb.endsWith(path.join("models", "test-legacy", "display.glb")), true);

  // Revision-specific paths resolve correctly
  const revisionGlb = resolveDisplayGlbPath({ slug: "test-legacy" }, { id: 10, display_glb_path: "models/test-legacy/revisions/10/display.glb" });
  assert.equal(revisionGlb.endsWith(path.join("models", "test-legacy", "revisions", "10", "display.glb")), true);

  // resolveSourcePath
  const legacySource = resolveSourcePath({ slug: "test-legacy", source_ext: ".step" });
  assert.equal(legacySource.endsWith(path.join("uploads", "test-legacy", "original.step")), true);

  const revisionSource = resolveSourcePath({ slug: "test-legacy", source_ext: ".step" }, { id: 10, source_path: "uploads/test-legacy/revisions/10/original.step" });
  assert.equal(revisionSource.endsWith(path.join("uploads", "test-legacy", "revisions", "10", "original.step")), true);

  // 4. Job / Worker integration tests
  // createRevisionForModel and auto-increment label
  const nextLabel = getNextNumericRevisionLabel(modelId);
  assert.equal(nextLabel, "2");

  const rev2 = createRevisionForModel({
    modelId,
    qualityPreset: "medium",
    status: "processing",
    sourceFilename: "rev2.step",
    sourcePath: `uploads/test-legacy-slug/revisions/2/original.step`,
    displayGlbPath: `models/test-legacy-slug/revisions/2/display.glb`,
    sourceSizeBytes: 2000,
    isCurrent: 0 // not current yet
  });
  assert.equal(rev2.revision_label, "2");
  assert.equal(rev2.is_current, 0);

  // Jobs with null revision_id and revision_id can be processed
  const jobNullRes = db.prepare(`
    INSERT INTO jobs (model_id, model_slug, type, status, quality)
    VALUES (?, 'test-legacy-slug', 'step-to-glb', 'processing', 'medium')
  `).run(modelId);
  const jobNullId = Number(jobNullRes.lastInsertRowid);
  assert.equal(markJobReady(jobNullId, "success", 123), true);

  const jobWithRevRes = db.prepare(`
    INSERT INTO jobs (model_id, model_slug, type, status, quality, revision_id)
    VALUES (?, 'test-legacy-slug', 'step-to-glb', 'processing', 'medium', ?)
  `).run(modelId, rev2.id);
  const jobWithRevId = Number(jobWithRevRes.lastInsertRowid);
  db.prepare("UPDATE model_revisions SET conversion_job_id = ? WHERE id = ?").run(jobWithRevId, rev2.id);

  assert.equal(markJobReady(jobWithRevId, "success", 456), true);

  const checkedRev2 = getRevisionById(rev2.id)!;
  assert.equal(checkedRev2.glb_size_bytes, 456);
  assert.equal(checkedRev2.status, "ready");

  setCurrentRevision(modelId, rev2.id);
  const onlyCurrent = db.prepare("SELECT id FROM model_revisions WHERE model_id = ? AND is_current = 1").all(modelId) as Array<{ id: number }>;
  assert.deepEqual(onlyCurrent.map((row) => row.id), [rev2.id]);
  assert.equal((db.prepare("SELECT current_revision_id FROM models WHERE id = ?").get(modelId) as any).current_revision_id, rev2.id);

  // 5. Public share resolution
  const resolvedRev = resolvePublicShareRevision(shareTokenHash);
  assert.ok(resolvedRev);
  assert.equal(resolvedRev!.id, rev1.id);
});
