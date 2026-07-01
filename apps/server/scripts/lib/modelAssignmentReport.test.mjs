import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAssignmentCounts, findSuspiciousModels } from "./modelAssignmentReport.mjs";

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-assignment-report-"));
  const dbPath = path.join(dir, "app.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE models (
      id TEXT PRIMARY KEY,
      slug TEXT,
      name TEXT,
      organization_id TEXT,
      created_by_user_id TEXT,
      deleted_at TEXT
    );
  `);
  return { db, dir };
}

test("getAssignmentCounts reports totals without writing", () => {
  const { db, dir } = makeTempDb();
  try {
    db.prepare("INSERT INTO models (id, slug, name, organization_id) VALUES ('1','a','A','org-1')").run();
    db.prepare("INSERT INTO models (id, slug, name, organization_id) VALUES ('2','b','B',NULL)").run();
    db.prepare("INSERT INTO models (id, slug, name, organization_id) VALUES ('3','c','C',NULL)").run();

    const before = db.prepare("SELECT organization_id FROM models ORDER BY id").all();
    const counts = getAssignmentCounts(db);
    const after = db.prepare("SELECT organization_id FROM models ORDER BY id").all();

    assert.deepEqual(counts, { totalModels: 3, unassigned: 2, alreadyAssigned: 1 });
    // A read-only report must never change row state.
    assert.deepEqual(before, after);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("findSuspiciousModels flags soft-deleted-unassigned and missing identity, without writing", () => {
  const { db, dir } = makeTempDb();
  try {
    db.prepare(
      "INSERT INTO models (id, slug, name, organization_id, deleted_at) VALUES ('1','ok','OK',NULL,NULL)"
    ).run();
    db.prepare(
      "INSERT INTO models (id, slug, name, organization_id, deleted_at) VALUES ('2','trashed','Trashed',NULL,'2026-01-01')"
    ).run();
    db.prepare("INSERT INTO models (id, slug, name, organization_id) VALUES ('3',NULL,NULL,NULL)").run();
    // Already assigned + soft-deleted should NOT be flagged (nothing left to stamp).
    db.prepare(
      "INSERT INTO models (id, slug, name, organization_id, deleted_at) VALUES ('4','done','Done','org-1','2026-01-01')"
    ).run();

    const before = db.prepare("SELECT * FROM models ORDER BY id").all();
    const suspicious = findSuspiciousModels(db);
    const after = db.prepare("SELECT * FROM models ORDER BY id").all();

    assert.equal(suspicious.length, 2);
    assert.ok(suspicious.some((s) => s.includes("model 2") && s.includes("soft-deleted")));
    assert.ok(suspicious.some((s) => s.includes("model 3") && s.includes("missing a slug or name")));
    assert.deepEqual(before, after);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("findSuspiciousModels returns empty array when nothing is suspicious", () => {
  const { db, dir } = makeTempDb();
  try {
    db.prepare("INSERT INTO models (id, slug, name, organization_id) VALUES ('1','ok','OK',NULL)").run();
    assert.deepEqual(findSuspiciousModels(db), []);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
