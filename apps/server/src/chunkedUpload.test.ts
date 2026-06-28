import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

test("chunked uploads flow (init, upload chunk, complete, cancel, and validation)", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelbase-chunked-test-"));
  const previousDxfFlag = process.env.FORMATIQ_DXF_UPLOAD_ENABLED;
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_PASSWORD = "test-password";
  delete process.env.FORMATIQ_DXF_UPLOAD_ENABLED;

  const [{ app }, { db }] = await Promise.all([
    import("./server.js"),
    import("./db.js")
  ]);

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
    if (previousDxfFlag === undefined) delete process.env.FORMATIQ_DXF_UPLOAD_ENABLED;
    else process.env.FORMATIQ_DXF_UPLOAD_ENABLED = previousDxfFlag;
  });

  // Helper fetch function
  async function jsonRequest(url: string, init?: RequestInit) {
    const response = await fetch(url, init);
    const body = await response.json().catch(() => null);
    return { response, body };
  }

  // Create project first
  const projectRes = await jsonRequest(`${origin}/api/projects`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "Test Project" })
  });
  const project = projectRes.body as { id: number };

  const configOff = await jsonRequest(`${origin}/api/config`, { headers });
  assert.equal(configOff.body.features.dxfUploadEnabled, false);

  const blockedDxf = new FormData();
  blockedDxf.set("modelFile", new Blob(["synthetic-dxf"]), "blocked.dxf");
  const blockedDxfResponse = await fetch(`${origin}/api/models`, { method: "POST", headers, body: blockedDxf });
  assert.equal(blockedDxfResponse.status, 400);
  assert.match(await blockedDxfResponse.text(), /DXF upload is disabled/);

  process.env.FORMATIQ_DXF_UPLOAD_ENABLED = "true";
  const configOn = await jsonRequest(`${origin}/api/config`, { headers });
  assert.equal(configOn.body.features.dxfUploadEnabled, true);
  const enabledDxf = new FormData();
  enabledDxf.set("modelFile", new Blob(["synthetic-dxf"]), "enabled.dxf");
  const enabledDxfResponse = await jsonRequest(`${origin}/api/models`, { method: "POST", headers, body: enabledDxf });
  assert.equal(enabledDxfResponse.response.status, 201);
  const dxfJob = db.prepare("SELECT type, status FROM jobs WHERE model_id = ?").get(enabledDxfResponse.body.id) as { type: string; status: string };
  assert.equal(dxfJob.type, "dxf-to-glb");
  assert.equal(dxfJob.status, "uploaded");
  process.env.FORMATIQ_DXF_UPLOAD_ENABLED = "false";
  const workerHeaders = { authorization: "Bearer dev-worker-token", accept: "application/json" };
  const disabledClaim = await jsonRequest(`${origin}/api/worker/jobs/next`, { headers: workerHeaders });
  assert.equal(disabledClaim.body.job, null);
  process.env.FORMATIQ_DXF_UPLOAD_ENABLED = "true";
  const enabledClaim = await jsonRequest(`${origin}/api/worker/jobs/next`, { headers: workerHeaders });
  assert.equal(enabledClaim.body.job.sourceExtension, ".dxf");
  const dxfArtifacts = new FormData();
  dxfArtifacts.set("display.glb", new Blob(["valid-enough-for-route-test"]), "display.glb");
  dxfArtifacts.set("manifest.json", new Blob(["{}"]), "manifest.json");
  dxfArtifacts.set("stats.json", new Blob(["{}"]), "stats.json");
  dxfArtifacts.set("material-debug.json", new Blob(["{}"]), "material-debug.json");
  dxfArtifacts.set("format-report.json", new Blob(["{}"]), "format-report.json");
  dxfArtifacts.set("dxf-optimization-report.json", new Blob(["{}"]), "dxf-optimization-report.json");
  dxfArtifacts.set("conversion.log", new Blob(["Converter backend: dxf-js"]), "conversion.log");
  const completedDxf = await jsonRequest(`${origin}/api/worker/jobs/${enabledClaim.body.job.id}/complete`, {
    method: "POST", headers: workerHeaders, body: dxfArtifacts
  });
  assert.equal(completedDxf.response.status, 200);
  const dxfRevision = db.prepare("SELECT display_glb_path FROM model_revisions WHERE model_id = ?").get(enabledDxfResponse.body.id) as { display_glb_path: string };
  const dxfArtifactDir = path.dirname(path.join(dataDir, dxfRevision.display_glb_path));
  assert.equal(fs.existsSync(path.join(dxfArtifactDir, "format-report.json")), true);
  assert.equal(fs.existsSync(path.join(dxfArtifactDir, "dxf-optimization-report.json")), true);
  process.env.FORMATIQ_DXF_UPLOAD_ENABLED = "false";

  // 1. Test init validation - invalid extension
  const initFailExt = await jsonRequest(`${origin}/api/uploads/chunked/init`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      filename: "test.png",
      sizeBytes: 1000,
      projectId: null,
      quality: "medium"
    })
  });
  assert.equal(initFailExt.response.status, 400);
  assert.match(initFailExt.body.error, /Only \.step, \.stp, \.glb, and \.gltf/);

  // 2. Test init validation - size limit exceeded (STEP > 500 MB)
  const initFailStepSize = await jsonRequest(`${origin}/api/uploads/chunked/init`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      filename: "test.step",
      sizeBytes: 524288000 + 1,
      projectId: null,
      quality: "medium"
    })
  });
  assert.equal(initFailStepSize.response.status, 400);
  assert.match(initFailStepSize.body.error, /STEP\/STP files must be under 500 MB/);

  // 3. Test init validation - size limit exceeded (GLB > 250 MB)
  const initFailGlbSize = await jsonRequest(`${origin}/api/uploads/chunked/init`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      filename: "test.glb",
      sizeBytes: 262144000 + 1,
      projectId: null,
      quality: "medium"
    })
  });
  assert.equal(initFailGlbSize.response.status, 400);
  assert.match(initFailGlbSize.body.error, /GLB\/GLTF files must be under 250 MB/);

  // 4. Test init validation - non-existent project
  const initFailProject = await jsonRequest(`${origin}/api/uploads/chunked/init`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      filename: "test.step",
      sizeBytes: 1000,
      projectId: 99999,
      quality: "medium"
    })
  });
  assert.equal(initFailProject.response.status, 400);
  assert.match(initFailProject.body.error, /Selected project was not found/);

  // 5. Test successful init
  const initSuccess = await jsonRequest(`${origin}/api/uploads/chunked/init`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      filename: "box.step",
      sizeBytes: 300, // 300 bytes
      projectId: project.id,
      quality: "high",
      meshiqAdaptiveSmoothing: "strong"
    })
  });
  assert.equal(initSuccess.response.status, 201);
  const uploadInfo = initSuccess.body as { uploadId: string; chunkSizeBytes: number };
  assert.ok(uploadInfo.uploadId);
  assert.equal(uploadInfo.chunkSizeBytes, 52428800);

  // 6. Upload chunk - missing file
  const chunkResFail = await jsonRequest(`${origin}/api/uploads/chunked/${uploadInfo.uploadId}/chunk?chunkIndex=0&totalChunks=1`, {
    method: "POST",
    headers
  });
  assert.equal(chunkResFail.response.status, 400);

  // 7. Upload chunk - success
  const formData = new FormData();
  formData.set("chunk", new Blob([Buffer.alloc(300)], { type: "application/octet-stream" }), "chunk.bin");
  const chunkResSuccess = await jsonRequest(`${origin}/api/uploads/chunked/${uploadInfo.uploadId}/chunk?chunkIndex=0&totalChunks=1`, {
    method: "POST",
    headers,
    body: formData
  });
  assert.equal(chunkResSuccess.response.status, 200);

  // 8. Complete upload - success
  const completeRes = await jsonRequest(`${origin}/api/uploads/chunked/${uploadInfo.uploadId}/complete`, {
    method: "POST",
    headers
  });
  assert.equal(completeRes.response.status, 201);
  const model = completeRes.body as { id: number; slug: string; original_size_bytes: number; folder_id: number };
  assert.equal(model.original_size_bytes, 300);
  assert.equal(model.folder_id, project.id);

  // Verify DB entries exist
  const dbModel = db.prepare("SELECT * FROM models WHERE id = ?").get(model.id) as { slug: string };
  assert.equal(dbModel.slug, model.slug);
  const dbJob = db.prepare("SELECT * FROM jobs WHERE model_id = ?").get(model.id) as { meshiq_adaptive_smoothing: string };
  assert.equal(dbJob.meshiq_adaptive_smoothing, "strong");

  // 9. Chunked upload can add a revision to an existing model.
  const initRevision = await jsonRequest(`${origin}/api/uploads/chunked/init`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      filename: "box-rev-b.step",
      sizeBytes: 120,
      modelSlug: model.slug,
      revisionLabel: "B",
      issuedDate: "2026-06-25",
      quality: "low",
      meshiqAdaptiveSmoothing: "standard",
      makeCurrent: false,
      allowPublicSelectable: false
    })
  });
  assert.equal(initRevision.response.status, 201);
  const revisionUpload = initRevision.body as { uploadId: string };
  const revisionChunk = new FormData();
  revisionChunk.set("chunk", new Blob([Buffer.alloc(120)]), "chunk.bin");
  const revisionChunkResponse = await jsonRequest(
    `${origin}/api/uploads/chunked/${revisionUpload.uploadId}/chunk?chunkIndex=0&totalChunks=1`,
    { method: "POST", headers, body: revisionChunk }
  );
  assert.equal(revisionChunkResponse.response.status, 200);
  const revisionComplete = await jsonRequest(`${origin}/api/uploads/chunked/${revisionUpload.uploadId}/complete`, {
    method: "POST",
    headers
  });
  assert.equal(revisionComplete.response.status, 201);
  assert.equal(revisionComplete.body.revision.revision_label, "B");
  assert.equal(revisionComplete.body.revision.is_current, 0);
  assert.equal(revisionComplete.body.revision.is_publicly_selectable, 0);
  assert.equal(revisionComplete.body.job.revision_id, revisionComplete.body.revision.id);
  assert.equal(revisionComplete.body.job.meshiq_adaptive_smoothing, "standard");

  // 10. Test cancellation
  const initCancel = await jsonRequest(`${origin}/api/uploads/chunked/init`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      filename: "cancel.step",
      sizeBytes: 1000,
      projectId: null,
      quality: "medium"
    })
  });
  assert.equal(initCancel.response.status, 201);
  const cancelInfo = initCancel.body as { uploadId: string };

  const cancelRes = await jsonRequest(`${origin}/api/uploads/chunked/${cancelInfo.uploadId}`, {
    method: "DELETE",
    headers
  });
  assert.equal(cancelRes.response.status, 200);

  // Complete on cancelled/deleted uploadId should fail 404
  const completeCancel = await jsonRequest(`${origin}/api/uploads/chunked/${cancelInfo.uploadId}/complete`, {
    method: "POST",
    headers
  });
  assert.equal(completeCancel.response.status, 404);
});
