import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

test("revision upload and replacement controllers preserve revision history", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "revvault-controller-test-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_PASSWORD = "test-password";

  const [{ app }, dbModule] = await Promise.all([import("./server.js"), import("./db.js")]);
  const { db } = dbModule;
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = {
    authorization: `Basic ${Buffer.from("admin:test-password").toString("base64")}`,
    accept: "application/json"
  };

  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function upload(url: string, filename: string, bytes: Buffer, fields: Record<string, string> = {}) {
    const form = new FormData();
    form.set("modelFile", new Blob([Uint8Array.from(bytes)]), filename);
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    const response = await fetch(`${origin}${url}`, { method: "POST", headers, body: form });
    const text = await response.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* plain validation response */ }
    return { response, body };
  }

  const firstUpload = await upload("/api/models", "assembly.glb", Buffer.from("first-glb"), {
    revisionLabel: "  ",
    issuedDate: ""
  });
  assert.equal(firstUpload.response.status, 201);
  const model = firstUpload.body as { id: number; slug: string; current_revision_id: number };
  const firstRevision = db.prepare("SELECT * FROM model_revisions WHERE model_id = ?").get(model.id) as any;
  assert.equal(firstRevision.revision_label, "1");
  assert.equal(firstRevision.issued_date, new Date().toISOString().slice(0, 10));
  assert.equal(firstRevision.is_current, 1);
  assert.equal(firstRevision.is_publicly_selectable, 1);
  assert.match(firstRevision.source_path, new RegExp(`^uploads/${model.slug}/revisions/${firstRevision.id}/original\\.glb$`));
  assert.equal(fs.existsSync(path.join(dataDir, ...firstRevision.source_path.split("/"))), true);
  const firstJob = db.prepare("SELECT * FROM jobs WHERE model_id = ? ORDER BY id DESC LIMIT 1").get(model.id) as any;
  assert.equal(firstJob.revision_id, firstRevision.id);
  const shareResponse = await fetch(`${origin}/api/models/${model.id}/share`, { method: "POST", headers });
  assert.equal(shareResponse.status, 201);
  const share = await shareResponse.json() as { token: string };

  const explicit = await upload(`/api/models/${model.slug}/revisions`, "issued-a.step", Buffer.from("step-a"), {
    revisionLabel: "A",
    issuedDate: "2026-06-24",
    quality: "high",
    makeCurrent: "false",
    allowPublicSelectable: "false"
  });
  assert.equal(explicit.response.status, 201);
  assert.equal(explicit.body.revision.revision_label, "A");
  assert.equal(explicit.body.revision.is_current, 0);
  assert.equal(explicit.body.revision.is_publicly_selectable, 0);
  assert.equal(explicit.body.job.revision_id, explicit.body.revision.id);
  assert.equal((db.prepare("SELECT current_revision_id FROM models WHERE id = ?").get(model.id) as any).current_revision_id, firstRevision.id);

  const duplicate = await upload(`/api/models/${model.slug}/revisions`, "duplicate.step", Buffer.from("duplicate"), {
    revisionLabel: " A "
  });
  assert.equal(duplicate.response.status, 409);

  const automatic = await upload(`/api/models/${model.slug}/revisions`, "automatic.step", Buffer.from("automatic"), {
    revisionLabel: " ",
    makeCurrent: "true"
  });
  assert.equal(automatic.response.status, 201);
  assert.equal(automatic.body.revision.revision_label, "2");
  const currentRows = db.prepare("SELECT id FROM model_revisions WHERE model_id = ? AND is_current = 1").all(model.id) as any[];
  assert.deepEqual(currentRows.map((row) => row.id), [automatic.body.revision.id]);
  assert.equal((db.prepare("SELECT current_revision_id FROM models WHERE id = ?").get(model.id) as any).current_revision_id, automatic.body.revision.id);

  const makeCurrentResponse = await fetch(`${origin}/api/models/${model.slug}/revisions/${explicit.body.revision.id}/current`, {
    method: "PATCH",
    headers
  });
  assert.equal(makeCurrentResponse.status, 200);
  assert.equal((await makeCurrentResponse.json() as any).is_current, 1);
  const currentAfterPatch = db.prepare("SELECT id FROM model_revisions WHERE model_id = ? AND is_current = 1").all(model.id) as any[];
  assert.deepEqual(currentAfterPatch.map((row) => row.id), [explicit.body.revision.id]);
  assert.equal((db.prepare("SELECT current_revision_id FROM models WHERE id = ?").get(model.id) as any).current_revision_id, explicit.body.revision.id);

  const publicSelectableResponse = await fetch(`${origin}/api/models/${model.slug}/revisions/${explicit.body.revision.id}`, {
    method: "PATCH",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ isPubliclySelectable: true })
  });
  assert.equal(publicSelectableResponse.status, 200);
  assert.equal((await publicSelectableResponse.json() as any).is_publicly_selectable, 1);

  const unsafeRevisionUpdate = await fetch(`${origin}/api/models/${model.slug}/revisions/${explicit.body.revision.id}`, {
    method: "PATCH",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ revision_label: "unsafe" })
  });
  assert.equal(unsafeRevisionUpdate.status, 400);

  const modelDetailsResponse = await fetch(`${origin}/api/models/${model.slug}`, { headers });
  assert.equal(modelDetailsResponse.status, 200);
  const modelDetails = await modelDetailsResponse.json() as any;
  assert.equal(modelDetails.currentRevision.id, explicit.body.revision.id);
  assert.equal(modelDetails.activeRevision.id, explicit.body.revision.id);
  assert.equal(modelDetails.revisions.length, 3);
  const selectedModelDetailsResponse = await fetch(
    `${origin}/api/models/${model.slug}?revisionId=${firstRevision.id}`,
    { headers }
  );
  assert.equal(selectedModelDetailsResponse.status, 200);
  const selectedModelDetails = await selectedModelDetailsResponse.json() as any;
  assert.equal(selectedModelDetails.activeRevision.id, firstRevision.id);
  assert.match(selectedModelDetails.glb_url, new RegExp(`revisionId=${firstRevision.id}$`));
  assert.equal(selectedModelDetails.invalidRevisionRequested, false);
  const selectedGlb = await fetch(`${origin}${selectedModelDetails.glb_url}`, { headers });
  assert.equal(await selectedGlb.text(), "first-glb");
  const selectedDownload = await fetch(`${origin}${selectedModelDetails.glb_download_url}`, { headers });
  assert.equal(await selectedDownload.text(), "first-glb");

  const invalidModelDetailsResponse = await fetch(
    `${origin}/api/models/${model.slug}?revisionId=999999`,
    { headers }
  );
  assert.equal(invalidModelDetailsResponse.status, 200);
  const invalidModelDetails = await invalidModelDetailsResponse.json() as any;
  assert.equal(invalidModelDetails.activeRevision.id, explicit.body.revision.id);
  assert.equal(invalidModelDetails.invalidRevisionRequested, true);
  assert.equal(
    (await fetch(`${origin}/model-files/${model.slug}/display.glb?revisionId=999999`, { headers })).status,
    404
  );
  const modelListResponse = await fetch(`${origin}/api/models`, { headers });
  const modelList = await modelListResponse.json() as any[];
  assert.equal(modelList.find((item) => item.id === model.id).current_revision_label, "A");

  const lockedBeforeReplacement = await fetch(`${origin}/public/${share.token}/model.glb`);
  assert.equal(await lockedBeforeReplacement.text(), "first-glb");

  const oldSourcePath = path.join(dataDir, ...firstRevision.source_path.split("/"));
  const replacement = await upload(`/api/models/${model.slug}/revisions/${firstRevision.id}/replace`, "corrected.glb", Buffer.from("replacement-glb"), {
    replacementReason: "Corrected source geometry",
    quality: "low"
  });
  assert.equal(replacement.response.status, 201);
  assert.equal(replacement.body.revision.revision_label, "1");
  assert.equal(replacement.body.job.revision_id, firstRevision.id);
  const versions = db.prepare(
    "SELECT * FROM revision_file_versions WHERE revision_id = ? ORDER BY file_version_number"
  ).all(firstRevision.id) as any[];
  assert.equal(versions.length, 2);
  assert.equal(versions[0].is_active, 0);
  assert.equal(versions[1].is_active, 1);
  assert.equal(versions[1].replacement_reason, "Corrected source geometry");
  assert.match(versions[1].source_path, /\/versions\/2\/original\.glb$/);
  assert.equal(fs.existsSync(oldSourcePath), true);
  assert.equal(fs.existsSync(path.join(dataDir, ...versions[1].source_path.split("/"))), true);
  const lockedAfterReplacement = await fetch(`${origin}/public/${share.token}/model.glb`);
  assert.equal(await lockedAfterReplacement.text(), "replacement-glb");

  const stepReplacement = await upload(`/api/models/${model.slug}/revisions/${firstRevision.id}/replace`, "corrected-again.step", Buffer.from("replacement-step"), {
    replacementReason: "Second correction"
  });
  assert.equal(stepReplacement.response.status, 201);
  const workerHeaders = { authorization: "Bearer dev-worker-token" };
  const sourceResponse = await fetch(`${origin}/api/worker/jobs/${stepReplacement.body.job.id}/source`, { headers: workerHeaders });
  assert.equal(sourceResponse.status, 200);
  assert.equal(await sourceResponse.text(), "replacement-step");
  const startResponse = await fetch(`${origin}/api/worker/jobs/${stepReplacement.body.job.id}/start`, {
    method: "POST",
    headers: workerHeaders
  });
  assert.equal(startResponse.status, 200);
  const completeForm = new FormData();
  completeForm.set("display.glb", new Blob(["converted-version-3"]), "display.glb");
  const completeResponse = await fetch(`${origin}/api/worker/jobs/${stepReplacement.body.job.id}/complete`, {
    method: "POST",
    headers: workerHeaders,
    body: completeForm
  });
  assert.equal(completeResponse.status, 200);
  const activeVersion = db.prepare(
    "SELECT * FROM revision_file_versions WHERE revision_id = ? AND is_active = 1"
  ).get(firstRevision.id) as any;
  assert.equal(activeVersion.file_version_number, 3);
  assert.equal(
    fs.readFileSync(path.join(dataDir, ...activeVersion.display_glb_path.split("/")), "utf8"),
    "converted-version-3"
  );
  assert.equal(fs.existsSync(path.join(dataDir, ...versions[1].display_glb_path.split("/"))), true);
  const lockedAfterConversion = await fetch(`${origin}/public/${share.token}/model.glb`);
  assert.equal(await lockedAfterConversion.text(), "converted-version-3");

  const staleCandidate = await upload(`/api/models/${model.slug}/revisions/${firstRevision.id}/replace`, "stale.step", Buffer.from("stale-step"));
  assert.equal(staleCandidate.response.status, 201);
  const supersedingReplacement = await upload(`/api/models/${model.slug}/revisions/${firstRevision.id}/replace`, "newest.glb", Buffer.from("newest-glb"));
  assert.equal(supersedingReplacement.response.status, 201);
  const staleSource = await fetch(`${origin}/api/worker/jobs/${staleCandidate.body.job.id}/source`, { headers: workerHeaders });
  assert.ok([404, 409].includes(staleSource.status));
  assert.equal((db.prepare("SELECT status FROM jobs WHERE id = ?").get(staleCandidate.body.job.id) as any).status, "cancelled");
  const lockedAfterSupersedingReplacement = await fetch(`${origin}/public/${share.token}/model.glb`);
  assert.equal(await lockedAfterSupersedingReplacement.text(), "newest-glb");

  const otherUpload = await upload("/api/models", "other.glb", Buffer.from("other"));
  assert.equal(otherUpload.response.status, 201);
  const mismatch = await upload(`/api/models/${otherUpload.body.slug}/revisions/${firstRevision.id}/replace`, "wrong.step", Buffer.from("wrong"));
  assert.equal(mismatch.response.status, 404);

  const invalidDate = await upload(`/api/models/${model.slug}/revisions`, "bad-date.step", Buffer.from("bad"), {
    issuedDate: "2026-02-30"
  });
  assert.equal(invalidDate.response.status, 400);
});
