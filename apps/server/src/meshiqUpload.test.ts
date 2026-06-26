import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

test("admin upload stores per-upload MeshIQ adaptive smoothing options", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelbase-meshiq-upload-"));
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

  const defaultModel = await uploadStep(origin, headers, "default-off.step");
  assertStoredOption(db, defaultModel.slug, "off");

  const standardModel = await uploadStep(origin, headers, "standard.step", "standard");
  assertStoredOption(db, standardModel.slug, "standard");

  const strongModel = await uploadStep(origin, headers, "strong.step", "strong");
  assertStoredOption(db, strongModel.slug, "strong");

  const invalid = await uploadStepRaw(origin, headers, "invalid.step", "maybe");
  assert.equal(invalid.response.status, 400);
  assert.match(invalid.text, /Invalid MeshIQ adaptive smoothing/);
});

async function uploadStep(
  origin: string,
  headers: Record<string, string>,
  filename: string,
  meshiqAdaptiveSmoothing?: "off" | "standard" | "strong"
) {
  const result = await uploadStepRaw(origin, headers, filename, meshiqAdaptiveSmoothing);
  assert.equal(result.response.status, 201);
  return result.body as { id: number; slug: string };
}

async function uploadStepRaw(
  origin: string,
  headers: Record<string, string>,
  filename: string,
  meshiqAdaptiveSmoothing?: string
) {
  const form = new FormData();
  form.set("modelFile", new Blob([Buffer.from("ISO-10303-21;ENDSEC;END-ISO-10303-21;")]), filename);
  form.set("quality", "medium");
  if (meshiqAdaptiveSmoothing !== undefined) {
    form.set("meshiqAdaptiveSmoothing", meshiqAdaptiveSmoothing);
  }
  const response = await fetch(`${origin}/api/models`, { method: "POST", headers, body: form });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { response, body, text };
}

function assertStoredOption(db: any, slug: string, expected: string): void {
  const job = db.prepare("SELECT * FROM jobs WHERE model_slug = ?").get(slug) as { revision_id: number; meshiq_adaptive_smoothing: string };
  assert.equal(job.meshiq_adaptive_smoothing, expected);

  const revision = db.prepare("SELECT * FROM model_revisions WHERE id = ?").get(job.revision_id) as { meshiq_adaptive_smoothing: string };
  assert.equal(revision.meshiq_adaptive_smoothing, expected);

  const fileVersion = db.prepare("SELECT * FROM revision_file_versions WHERE revision_id = ?").get(job.revision_id) as { meshiq_adaptive_smoothing: string };
  assert.equal(fileVersion.meshiq_adaptive_smoothing, expected);
}
