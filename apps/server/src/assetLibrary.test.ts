import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

test("asset library projects, recycling, quota, sorting, and batch actions", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelbase-library-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_PASSWORD = "test-password";

  const [{ app }, { db }] = await Promise.all([import("./server.js"), import("./db.js")]);
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

  const createProject = await jsonFetch(`${origin}/api/projects`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "Alpha Project" })
  });
  assert.equal(createProject.response.status, 201);
  const project = createProject.body as { id: number; name: string };

  const emptyProjectResult = await jsonFetch(`${origin}/api/projects`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "Temporary" })
  });
  const emptyProject = emptyProjectResult.body as { id: number };
  const renamed = await jsonFetch(`${origin}/api/projects/${emptyProject.id}`, {
    method: "PATCH",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "Temporary renamed" })
  });
  assert.equal((renamed.body as { name: string }).name, "Temporary renamed");
  assert.equal((await fetch(`${origin}/api/projects/${emptyProject.id}`, { method: "DELETE", headers })).status, 200);

  const assigned = await uploadGlb(origin, headers, "assigned.glb", "assigned", project.id);
  const unsorted = await uploadGlb(origin, headers, "unsorted.glb", "free");
  assert.equal(assigned.project_id, project.id);
  assert.equal(assigned.folder_id, project.id);
  assert.equal(unsorted.project_id, null);

  const projects = await jsonFetch(`${origin}/api/projects`, { headers });
  assert.equal((projects.body as Array<{ id: number; model_count: number }>).find((item) => item.id === project.id)?.model_count, 1);

  const invalidSort = await fetch(`${origin}/api/models?sortBy=DROP%20TABLE`, { headers });
  assert.equal(invalidSort.status, 400);
  assert.equal((await fetch(`${origin}/api/models?sortDir=sideways`, { headers })).status, 400);

  const sorted = await jsonFetch(`${origin}/api/models?sortBy=name&sortDir=asc&q=assigned`, { headers });
  assert.deepEqual((sorted.body as Array<{ slug: string }>).map((model) => model.slug), [assigned.slug]);
  assert.equal((sorted.body as Array<{ quality: string }>)[0]?.quality, "medium");
  const unsortedList = await jsonFetch(`${origin}/api/models?view=unsorted`, { headers });
  assert.deepEqual((unsortedList.body as Array<{ slug: string }>).map((model) => model.slug), [unsorted.slug]);

  const quotaBefore = await jsonFetch(`${origin}/api/storage/quota`, { headers });
  assert.deepEqual(quotaBefore.body, {
    quotaBytes: 5368709120,
    usedBytes: 24,
    availableBytes: 5368709096,
    percentUsed: 0,
    breakdown: { originalBytes: 12, displayGlbBytes: 12, deletedBytes: 0, logsBytes: 0 }
  });

  assert.equal((await fetch(`${origin}/api/models/${assigned.slug}/trash`, { method: "POST", headers })).status, 200);
  const active = await jsonFetch(`${origin}/api/models`, { headers });
  assert.equal((active.body as Array<{ slug: string }>).some((model) => model.slug === assigned.slug), false);
  const recycling = await jsonFetch(`${origin}/api/models?view=recycling`, { headers });
  assert.deepEqual((recycling.body as Array<{ slug: string }>).map((model) => model.slug), [assigned.slug]);

  const quotaDeleted = await jsonFetch(`${origin}/api/storage/quota`, { headers });
  assert.equal((quotaDeleted.body as { usedBytes: number }).usedBytes, 24);
  assert.equal((quotaDeleted.body as { breakdown: { deletedBytes: number } }).breakdown.deletedBytes, 16);

  const partialRestore = await jsonFetch(`${origin}/api/models/batch`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ action: "restore", slugs: [assigned.slug, "missing-model"] })
  });
  assert.deepEqual((partialRestore.body as { updated: string[] }).updated, [assigned.slug]);
  assert.deepEqual((partialRestore.body as { failed: Array<{ slug: string }> }).failed.map((item) => item.slug), ["missing-model"]);

  const move = await jsonFetch(`${origin}/api/models/batch`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ action: "moveToProject", slugs: [unsorted.slug], projectId: project.id })
  });
  assert.deepEqual((move.body as { updated: string[] }).updated, [unsorted.slug]);
  assert.equal((await fetch(`${origin}/api/projects/${project.id}`, { method: "DELETE", headers })).status, 409);

  assert.equal((await fetch(`${origin}/api/models/${unsorted.slug}/trash`, { method: "POST", headers })).status, 200);
  const uploadDir = path.join(dataDir, "uploads", unsorted.slug);
  const modelDir = path.join(dataDir, "models", unsorted.slug);
  assert.equal((await fetch(`${origin}/api/models/${unsorted.slug}/forever`, { method: "DELETE", headers })).status, 200);
  assert.equal(fs.existsSync(uploadDir), false);
  assert.equal(fs.existsSync(modelDir), false);
  assert.equal(db.prepare("SELECT id FROM models WHERE slug = ?").get(unsorted.slug), undefined);
  const quotaAfterPermanentDelete = await jsonFetch(`${origin}/api/storage/quota`, { headers });
  assert.equal(quotaAfterPermanentDelete.response.headers.get("cache-control"), "private, no-store");
  assert.equal((quotaAfterPermanentDelete.body as { usedBytes: number }).usedBytes, 16);
  assert.equal((quotaAfterPermanentDelete.body as { availableBytes: number }).availableBytes, 5368709104);
  assert.equal((quotaAfterPermanentDelete.body as { breakdown: { deletedBytes: number } }).breakdown.deletedBytes, 0);

  const queued = await uploadStep(origin, headers, "queued-cancel.step");
  assert.equal((await fetch(`${origin}/api/models/${queued.slug}/trash`, { method: "POST", headers })).status, 200);
  assert.equal((db.prepare("SELECT status FROM jobs WHERE model_slug = ?").get(queued.slug) as { status: string }).status, "cancelled");
  assert.equal(db.prepare("SELECT id FROM jobs WHERE id = (SELECT id FROM jobs WHERE model_slug = ?) AND status IN ('uploaded','queued')",).get(queued.slug), undefined);

  const activeConversion = await uploadStep(origin, headers, "active-cancel.step");
  db.prepare("UPDATE jobs SET status = 'processing' WHERE model_slug = ?").run(activeConversion.slug);
  db.prepare("UPDATE models SET status = 'processing' WHERE slug = ?").run(activeConversion.slug);
  const activeJobId = (db.prepare("SELECT id FROM jobs WHERE model_slug = ?").get(activeConversion.slug) as { id: number }).id;
  const progressResponse = await fetch(`${origin}/api/worker/jobs/${activeJobId}/progress`, { method: "POST", headers: { authorization: "Bearer dev-worker-token", "content-type": "application/json" }, body: JSON.stringify({ percent: 50, label: "Converting - meshing" }) });
  assert.equal(progressResponse.status, 200);
  const savedProgress = db.prepare("SELECT progress_percent, progress_label FROM jobs WHERE id = ?").get(activeJobId) as { progress_percent: number; progress_label: string };
  assert.equal(savedProgress.progress_percent, 50);
  assert.equal(savedProgress.progress_label, "Converting - meshing");
  assert.equal((await fetch(`${origin}/api/models/${activeConversion.slug}/trash`, { method: "POST", headers })).status, 200);
  const activeJob = db.prepare("SELECT status, cancellation_requested_at FROM jobs WHERE model_slug = ?").get(activeConversion.slug) as { status: string; cancellation_requested_at: string | null };
  assert.equal(activeJob.status, "cancelling");
  assert.ok(activeJob.cancellation_requested_at);

  const batchQueued = await uploadStep(origin, headers, "batch-cancel.step");
  const batchTrash = await jsonFetch(`${origin}/api/models/batch`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ action: "trash", slugs: [batchQueued.slug] }) });
  assert.deepEqual((batchTrash.body as { updated: string[] }).updated, [batchQueued.slug]);
  assert.equal((db.prepare("SELECT status FROM jobs WHERE model_slug = ?").get(batchQueued.slug) as { status: string }).status, "cancelled");

  const foreverQueued = await uploadStep(origin, headers, "forever-cancel.step");
  await fetch(`${origin}/api/models/${foreverQueued.slug}/trash`, { method: "POST", headers });
  assert.equal((await fetch(`${origin}/api/models/${foreverQueued.slug}/forever`, { method: "DELETE", headers })).status, 200);
  assert.equal(db.prepare("SELECT id FROM jobs WHERE model_slug = ?").get(foreverQueued.slug), undefined);
});

async function uploadStep(origin: string, headers: Record<string, string>, filename: string) {
  const form = new FormData();
  form.set("modelFile", new Blob([Buffer.from("ISO-10303-21;ENDSEC;END-ISO-10303-21;")]), filename);
  form.set("quality", "low");
  const result = await jsonFetch(`${origin}/api/models`, { method: "POST", headers, body: form });
  assert.equal(result.response.status, 201);
  return result.body as { id: number; slug: string };
}

async function uploadGlb(
  origin: string,
  headers: Record<string, string>,
  filename: string,
  contents: string,
  projectId?: number
) {
  const form = new FormData();
  form.set("modelFile", new Blob([Buffer.from(contents)], { type: "model/gltf-binary" }), filename);
  if (projectId) form.set("projectId", String(projectId));
  const result = await jsonFetch(`${origin}/api/models`, { method: "POST", headers, body: form });
  assert.equal(result.response.status, 201);
  return result.body as { id: number; slug: string; project_id: number | null; folder_id: number | null };
}

async function jsonFetch(url: string, init?: RequestInit): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(url, init);
  const body = await response.json();
  return { response, body };
}
