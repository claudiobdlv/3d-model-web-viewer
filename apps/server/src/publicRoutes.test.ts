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
  const model = await upload.json() as { id: number; slug: string; current_revision_id: number };

  const legacyToken = "L".repeat(43);
  db.prepare(
    `INSERT INTO public_shares (id, model_id, token_hash, token_prefix)
     VALUES (?, ?, ?, ?)`
  ).run(crypto.randomUUID(), model.id, crypto.createHash("sha256").update(legacyToken).digest("hex"), legacyToken.slice(0, 8));
  assert.equal((await fetch(`${origin}/public/${legacyToken}`)).status, 200);
  const legacyMetadata = await fetch(`${origin}/public/${legacyToken}/model.json`);
  assert.equal(legacyMetadata.status, 200);
  assert.equal((await legacyMetadata.json() as any).activeRevision.id, model.current_revision_id);

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

  const initialSettings = await fetch(`${origin}/api/models/${model.id}/share`, { headers: { authorization } });
  assert.equal(initialSettings.status, 200);
  assert.deepEqual(
    ((await initialSettings.json()) as any),
    {
      active: true,
      token: share.token,
      url: share.url,
      linkMode: "locked_revision",
      revisionId: model.current_revision_id,
      allowRevisionSwitching: false
    }
  );

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
  const lockedMetadata = await metadata.json() as any;
  assert.equal(lockedMetadata.activeRevision.id, model.current_revision_id);
  assert.equal(lockedMetadata.allowRevisionSwitching, false);
  assert.deepEqual(lockedMetadata.revisions, []);
  assert.equal((await fetch(`${origin}/public/${share.token}/model.glb`)).status, 200);
  assert.equal((await fetch(`${origin}/public/${share.token}/original`)).status, 404);
  assert.equal((await fetch(`${origin}/api/models`)).status, 401);
  assert.equal((await fetch(`${origin}/admin`)).status, 401);
  assert.equal((await fetch(`${origin}/3dviewer/${model.slug}`)).status, 401);
  assert.equal((await fetch(`${origin}/downloads/${model.slug}/original`)).status, 401);
  assert.equal((await fetch(`${origin}/admin/logs/${model.slug}/conversion.log`)).status, 401);

  async function uploadRevision(filename: string, contents: string, allowPublicSelectable: boolean) {
    const revisionForm = new FormData();
    revisionForm.set("modelFile", new Blob([contents]), filename);
    revisionForm.set("allowPublicSelectable", String(allowPublicSelectable));
    revisionForm.set("makeCurrent", "false");
    const response = await fetch(`${origin}/api/models/${model.slug}/revisions`, {
      method: "POST",
      headers: { authorization, accept: "application/json" },
      body: revisionForm
    });
    assert.equal(response.status, 201);
    return response.json() as Promise<{ revision: { id: number } }>;
  }

  const selectable = await uploadRevision("public-revision.glb", "public-revision", true);
  const hidden = await uploadRevision("hidden-revision.glb", "hidden-revision", false);

  const otherForm = new FormData();
  otherForm.set("modelFile", new Blob(["other-glb"]), "other-public.glb");
  const otherUpload = await fetch(`${origin}/api/models`, {
    method: "POST",
    headers: { authorization, accept: "application/json" },
    body: otherForm
  });
  const otherModel = await otherUpload.json() as { current_revision_id: number };

  const invalidForeignSettings = await fetch(`${origin}/api/models/${model.id}/share`, {
    method: "PATCH",
    headers: { authorization, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ linkMode: "locked_revision", revisionId: otherModel.current_revision_id })
  });
  assert.equal(invalidForeignSettings.status, 400);

  const latestSettings = await fetch(`${origin}/api/models/${model.id}/share`, {
    method: "PATCH",
    headers: { authorization, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ linkMode: "latest_current", allowRevisionSwitching: false })
  });
  assert.equal(latestSettings.status, 200);
  assert.equal((await latestSettings.json() as any).revisionId, null);
  assert.equal((await fetch(`${origin}/public/${share.token}/model.glb`).then((response) => response.text())), "test-glb");

  const makeSelectableCurrent = await fetch(`${origin}/api/models/${model.slug}/revisions/${selectable.revision.id}/current`, {
    method: "PATCH",
    headers: { authorization, accept: "application/json" }
  });
  assert.equal(makeSelectableCurrent.status, 200);
  assert.equal((await fetch(`${origin}/public/${share.token}/model.glb`).then((response) => response.text())), "public-revision");

  const restoreLockedSettings = await fetch(`${origin}/api/models/${model.id}/share`, {
    method: "PATCH",
    headers: { authorization, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      linkMode: "locked_revision",
      revisionId: model.current_revision_id,
      allowRevisionSwitching: false
    })
  });
  assert.equal(restoreLockedSettings.status, 200);
  assert.equal((await restoreLockedSettings.json() as any).revisionId, model.current_revision_id);

  const lockedGuess = await fetch(`${origin}/public/${share.token}/model.glb?revisionId=${selectable.revision.id}`);
  assert.equal(await lockedGuess.text(), "test-glb");

  const enableSwitching = await fetch(`${origin}/api/models/${model.id}/share`, {
    method: "PATCH",
    headers: { authorization, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ allowRevisionSwitching: true })
  });
  assert.equal(enableSwitching.status, 200);
  assert.equal((await enableSwitching.json() as any).allowRevisionSwitching, true);

  const switchableMetadata = await fetch(`${origin}/public/${share.token}/model.json`);
  const switchableBody = await switchableMetadata.json() as any;
  assert.equal(switchableBody.activeRevision.id, model.current_revision_id);
  assert.equal(switchableBody.allowRevisionSwitching, true);
  assert.deepEqual(switchableBody.revisions.map((revision: any) => revision.id), [model.current_revision_id, selectable.revision.id]);

  const selectedPublic = await fetch(`${origin}/public/${share.token}/model.glb?revisionId=${selectable.revision.id}`);
  assert.equal(await selectedPublic.text(), "public-revision");
  const selectedMetadata = await fetch(`${origin}/public/${share.token}/model.json?revisionId=${selectable.revision.id}`);
  assert.equal((await selectedMetadata.json() as any).activeRevision.id, selectable.revision.id);

  const hiddenGuess = await fetch(`${origin}/public/${share.token}/model.glb?revisionId=${hidden.revision.id}`);
  assert.equal(await hiddenGuess.text(), "test-glb");
  const hiddenMetadata = await fetch(`${origin}/public/${share.token}/model.json?revisionId=${hidden.revision.id}`);
  const hiddenBody = await hiddenMetadata.json() as any;
  assert.equal(hiddenBody.activeRevision.id, model.current_revision_id);
  assert.equal(hiddenBody.invalidRevisionRequested, true);

  const foreignGuess = await fetch(`${origin}/public/${share.token}/model.glb?revisionId=${otherModel.current_revision_id}`);
  assert.equal(await foreignGuess.text(), "test-glb");
  const malformedGuess = await fetch(`${origin}/public/${share.token}/model.json?revisionId=not-a-number`);
  assert.equal((await malformedGuess.json() as any).invalidRevisionRequested, true);

  db.prepare(
    "UPDATE model_revisions SET status = 'processing', is_publicly_selectable = 1 WHERE id = ?"
  ).run(hidden.revision.id);
  const processingFiltered = await fetch(`${origin}/public/${share.token}/model.json`);
  assert.equal(
    (await processingFiltered.json() as any).revisions.some((revision: any) => revision.id === hidden.revision.id),
    false
  );

  const lockDeleted = await fetch(`${origin}/api/models/${model.id}/share`, {
    method: "PATCH",
    headers: { authorization, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      linkMode: "locked_revision",
      revisionId: selectable.revision.id,
      allowRevisionSwitching: false
    })
  });
  assert.equal(lockDeleted.status, 200);
  db.prepare("UPDATE model_revisions SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?").run(selectable.revision.id);
  assert.equal((await fetch(`${origin}/public/${share.token}/model.glb`)).status, 404);
  db.prepare("UPDATE model_revisions SET deleted_at = NULL WHERE id = ?").run(selectable.revision.id);

  db.prepare("UPDATE model_revisions SET is_current = 0 WHERE model_id = ?").run(model.id);
  db.prepare("UPDATE models SET current_revision_id = NULL WHERE id = ?").run(model.id);
  const latestWithoutCurrent = await fetch(`${origin}/api/models/${model.id}/share`, {
    method: "PATCH",
    headers: { authorization, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ linkMode: "latest_current" })
  });
  assert.equal(latestWithoutCurrent.status, 409);
  db.prepare("UPDATE model_revisions SET is_current = 1 WHERE id = ?").run(selectable.revision.id);
  db.prepare("UPDATE models SET current_revision_id = ? WHERE id = ?").run(selectable.revision.id, model.id);

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

  assert.equal((await fetch(`${origin}/api/models/${model.slug}/trash`, {
    method: "POST",
    headers: { authorization, accept: "application/json" }
  })).status, 200);
  assert.equal((await fetch(`${origin}/public/${replacementShare.token}`)).status, 404);
  assert.equal((await fetch(`${origin}/api/models/${model.slug}/restore`, {
    method: "POST",
    headers: { authorization, accept: "application/json" }
  })).status, 200);
  assert.equal((await fetch(`${origin}/public/${replacementShare.token}`)).status, 200);
});
