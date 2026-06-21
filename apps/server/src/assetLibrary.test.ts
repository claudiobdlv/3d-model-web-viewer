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
});

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
