import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

test("chunked uploads flow (init, upload chunk, complete, cancel, and validation)", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelbase-chunked-test-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_PASSWORD = "test-password";

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
      quality: "high"
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
