import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

test("public shares expose only the token-scoped ready GLB and revoke safely", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelbase-public-share-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_PASSWORD = "test-password";

  const [{ app }, { db }] = await Promise.all([import("./server.js"), import("./db.js")]);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const authorization = `Basic ${Buffer.from("admin:test-password").toString("base64")}`;

  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const form = new FormData();
  form.set("modelFile", new Blob([Buffer.from("test-glb")], { type: "model/gltf-binary" }), "public-test.glb");
  const upload = await fetch(`${origin}/api/models`, {
    method: "POST",
    headers: { authorization, accept: "application/json" },
    body: form
  });
  assert.equal(upload.status, 201);
  const model = await upload.json() as { id: number; slug: string };

  const legacyToken = "L".repeat(43);
  db.prepare(
    `INSERT INTO public_shares (id, model_id, token_hash, token_prefix)
     VALUES (?, ?, ?, ?)`
  ).run(crypto.randomUUID(), model.id, crypto.createHash("sha256").update(legacyToken).digest("hex"), legacyToken.slice(0, 8));
  assert.equal((await fetch(`${origin}/public/${legacyToken}`)).status, 200);

  const create = await fetch(`${origin}/api/models/${model.id}/share`, {
    method: "POST",
    headers: { authorization, accept: "application/json" }
  });
  assert.equal(create.status, 201);
  const share = await create.json() as { token: string; url: string };
  assert.match(share.url, /^https:\/\/modelbase\.parametricstandards\.com\/public\/[A-Za-z0-9_-]{43}$/);

  const stored = db.prepare(
    "SELECT token_hash, token_prefix, public_token FROM public_shares WHERE model_id = ? AND public_token IS NOT NULL"
  ).get(model.id) as {
    token_hash: string;
    token_prefix: string;
    public_token: string;
  };
  assert.equal(stored.token_hash.length, 64);
  assert.equal(stored.token_hash.includes(share.token), false);
  assert.equal(stored.token_prefix, share.token.slice(0, 8));
  assert.equal(stored.public_token, share.token);

  const repeatedCreate = await fetch(`${origin}/api/models/${model.id}/share`, {
    method: "POST",
    headers: { authorization, accept: "application/json" }
  });
  assert.equal(repeatedCreate.status, 200);
  const repeatedShare = await repeatedCreate.json() as { token: string; url: string; reused: boolean };
  assert.equal(repeatedShare.token, share.token);
  assert.equal(repeatedShare.url, share.url);
  assert.equal(repeatedShare.reused, true);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM public_shares WHERE model_id = ?").get(model.id) as { count: number }).count, 2);
  assert.equal((await fetch(`${origin}/public/${legacyToken}`)).status, 200);

  assert.equal((await fetch(`${origin}/public/not-a-token`)).status, 404);
  assert.equal((await fetch(`${origin}/public/${share.token}`)).status, 200);
  const metadata = await fetch(`${origin}/public/${share.token}/model.json`);
  assert.equal(metadata.status, 200);
  assert.deepEqual(Object.keys(await metadata.json()).sort(), ["default_view_json", "glb_url", "name", "slug"]);
  assert.equal((await fetch(`${origin}/public/${share.token}/model.glb`)).status, 200);
  assert.equal((await fetch(`${origin}/public/${share.token}/original`)).status, 404);
  assert.equal((await fetch(`${origin}/api/models`)).status, 401);
  assert.equal((await fetch(`${origin}/admin`)).status, 401);
  assert.equal((await fetch(`${origin}/3dviewer/${model.slug}`)).status, 401);
  assert.equal((await fetch(`${origin}/downloads/${model.slug}/original`)).status, 401);
  assert.equal((await fetch(`${origin}/admin/logs/${model.slug}/conversion.log`)).status, 401);

  const revoke = await fetch(`${origin}/api/models/${model.id}/share`, {
    method: "DELETE",
    headers: { authorization, accept: "application/json" }
  });
  assert.equal(revoke.status, 200);
  assert.equal((await fetch(`${origin}/public/${share.token}/model.glb`)).status, 404);
  assert.equal((await fetch(`${origin}/public/${legacyToken}`)).status, 404);

  const replacementCreate = await fetch(`${origin}/api/models/${model.id}/share`, {
    method: "POST",
    headers: { authorization, accept: "application/json" }
  });
  assert.equal(replacementCreate.status, 201);
  const replacementShare = await replacementCreate.json() as { token: string; url: string; reused: boolean };
  assert.notEqual(replacementShare.token, share.token);
  assert.equal(replacementShare.reused, false);
  assert.equal((await fetch(`${origin}/public/${replacementShare.token}`)).status, 200);
  assert.equal((await fetch(`${origin}/public/${replacementShare.token}/model.glb`)).status, 200);
});
