import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { ProviderProfile } from "./types.js";

// End-to-end tenant-safety regression test for the security review findings.
// Runs accounts-enabled (AUTH_ENABLED=true) against the in-memory store, minting
// real sessions through the auth service (the exact cookie+middleware path a
// real OAuth login uses). Proves cross-organization isolation, role enforcement,
// artifact isolation, and chunked-upload ownership.

const profile = (subject: string, email: string): ProviderProfile => ({
  provider: "google",
  issuer: "https://accounts.google.com",
  subject,
  email,
  emailVerified: true,
  displayName: "Tester",
  avatarUrl: null
});

test("AUTH_ENABLED=true is tenant-safe across orgs, roles, artifacts, uploads", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelbase-tenant-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.AUTH_ENABLED = "true";
  process.env.AUTH_STORE = "memory";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.APP_BASE_URL = "http://127.0.0.1";

  const { app, authSubsystem } = await import("./../server.js");
  const { db } = await import("./../db.js");
  const service = authSubsystem.service!;
  const store = authSubsystem.store!;
  const cookieName = authSubsystem.config.cookieName;

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.AUTH_ENABLED;
    delete process.env.AUTH_STORE;
    delete process.env.SESSION_SECRET;
  });

  // --- Mint sessions: owner A, owner B, and a viewer inside org A ---
  const loginA = await service.loginWithProvider(profile("sub-a", "a@example.com"));
  const loginB = await service.loginWithProvider(profile("sub-b", "b@example.com"));
  const loginV = await service.loginWithProvider(profile("sub-v", "v@example.com"));
  assert.ok(loginA.ok && loginB.ok && loginV.ok);
  if (!loginA.ok || !loginB.ok || !loginV.ok) return;

  // The viewer user gets a viewer membership in org A (in addition to their own).
  await store.createMembership({
    organizationId: loginA.organization.id,
    userId: loginV.user.id,
    role: "viewer",
    status: "active"
  });

  const mintCookie = async (userId: string, orgId: string): Promise<string> => {
    const { token } = await service.createSession(userId, {
      activeOrganizationId: orgId,
      ipAddress: null,
      userAgent: null
    });
    return `${cookieName}=${token}`;
  };
  const cookieA = await mintCookie(loginA.user.id, loginA.organization.id);
  const cookieB = await mintCookie(loginB.user.id, loginB.organization.id);
  const cookieViewer = await mintCookie(loginV.user.id, loginA.organization.id);

  const glbForm = (name: string) => {
    const form = new FormData();
    form.set("modelFile", new Blob([Buffer.from("glb-bytes")], { type: "model/gltf-binary" }), name);
    return form;
  };

  // --- Org A uploads a private model ---
  const uploadA = await fetch(`${origin}/api/models`, {
    method: "POST",
    headers: { cookie: cookieA, accept: "application/json" },
    body: glbForm("tenant-model-a.glb")
  });
  assert.equal(uploadA.status, 201);
  const modelA = (await uploadA.json()) as { id: number; slug: string; name: string };
  const detailA = await (await fetch(`${origin}/api/models/${modelA.slug}`, { headers: { cookie: cookieA } })).json();
  const revisionAId = (detailA as { currentRevision: { id: number } }).currentRevision.id;

  // ============================================================
  // Finding 1: cross-organization public-share takeover is blocked
  // ============================================================
  await t.test("org B cannot read or create a share for org A's model", async () => {
    const bGet = await fetch(`${origin}/api/models/${modelA.id}/share`, { headers: { cookie: cookieB } });
    assert.equal(bGet.status, 404);
    const bCreate = await fetch(`${origin}/api/models/${modelA.id}/share`, {
      method: "POST",
      headers: { cookie: cookieB, "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(bCreate.status, 404);
    // No share should have been created for org A's model.
    const shareCount = db.prepare("SELECT COUNT(*) AS n FROM public_shares WHERE model_id = ?").get(modelA.id) as { n: number };
    assert.equal(shareCount.n, 0);
  });

  // Owner A legitimately creates a share → finding 12 (anon view works).
  let publicToken = "";
  await t.test("owner A creates a share and the public token serves it without login", async () => {
    const create = await fetch(`${origin}/api/models/${modelA.id}/share`, {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(create.status, 201);
    publicToken = ((await create.json()) as { token: string }).token;
    assert.ok(publicToken);
    // Anonymous (no cookie) access to the share is allowed for view + glb.
    assert.equal((await fetch(`${origin}/public/${publicToken}`)).status, 200);
    assert.equal((await fetch(`${origin}/public/${publicToken}/model.json`)).status, 200);
    assert.equal((await fetch(`${origin}/public/${publicToken}/model.glb`)).status, 200);
  });

  // ============================================================
  // Finding 2: cross-organization mutations are blocked
  // ============================================================
  await t.test("org B cannot mutate org A's model through any route", async () => {
    const req = (method: string, p: string, body?: unknown) =>
      fetch(`${origin}${p}`, {
        method,
        headers: { cookie: cookieB, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });

    assert.equal((await req("PATCH", `/api/models/${modelA.slug}`, { name: "hijacked" })).status, 404);
    assert.equal((await req("POST", `/api/models/${modelA.slug}/trash`)).status, 404);
    assert.equal((await req("POST", `/api/models/${modelA.slug}/restore`)).status, 404);
    assert.equal((await req("DELETE", `/api/models/${modelA.slug}/forever`)).status, 404);
    assert.equal((await req("DELETE", `/api/models/${modelA.slug}`)).status, 404);
    assert.equal((await req("PATCH", `/api/models/${modelA.slug}/folder`, { folderId: null })).status, 404);
    assert.equal((await req("PATCH", `/api/models/${modelA.slug}/project`, { projectId: null })).status, 404);
    assert.equal((await req("POST", `/api/models/${modelA.slug}/default-view`, { defaultView: null })).status, 404);
    assert.equal((await req("PATCH", `/api/models/${modelA.slug}/revisions/${revisionAId}/current`)).status, 404);
    assert.equal((await req("PATCH", `/api/models/${modelA.slug}/revisions/${revisionAId}`, { isPubliclySelectable: false })).status, 404);

    // Revision upload (multipart) targeting org A's model.
    const revUpload = await fetch(`${origin}/api/models/${modelA.slug}/revisions`, {
      method: "POST",
      headers: { cookie: cookieB },
      body: glbForm("evil-rev.glb")
    });
    assert.equal(revUpload.status, 404);

    // Batch action against org A's slug: reported as failed, nothing updated.
    const batch = await req("POST", `/api/models/batch`, { action: "trash", slugs: [modelA.slug] });
    assert.equal(batch.status, 200);
    const batchBody = (await batch.json()) as { updated: string[]; failed: unknown[] };
    assert.deepEqual(batchBody.updated, []);
    assert.equal(batchBody.failed.length, 1);

    // Org A's model is untouched.
    const row = db.prepare("SELECT name, deleted_at FROM models WHERE id = ?").get(modelA.id) as { name: string; deleted_at: string | null };
    assert.equal(row.name, modelA.name);
    assert.equal(row.deleted_at, null);
  });

  // ============================================================
  // Finding 3: viewer role is read-only
  // ============================================================
  await t.test("viewer in org A can read but cannot upload/mutate/share/download-source", async () => {
    // Reads are allowed.
    assert.equal((await fetch(`${origin}/api/models/${modelA.slug}`, { headers: { cookie: cookieViewer } })).status, 200);
    assert.equal((await fetch(`${origin}/downloads/${modelA.slug}/display.glb`, { headers: { cookie: cookieViewer } })).status, 200);

    // Mutations / uploads / share / source download are denied (403).
    const upload = await fetch(`${origin}/api/models`, { method: "POST", headers: { cookie: cookieViewer, accept: "application/json" }, body: glbForm("viewer.glb") });
    assert.equal(upload.status, 403);
    assert.equal((await fetch(`${origin}/api/models/${modelA.slug}`, { method: "PATCH", headers: { cookie: cookieViewer, "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) })).status, 403);
    assert.equal((await fetch(`${origin}/api/models/${modelA.slug}/trash`, { method: "POST", headers: { cookie: cookieViewer } })).status, 403);
    assert.equal((await fetch(`${origin}/api/models/${modelA.id}/share`, { method: "POST", headers: { cookie: cookieViewer, "content-type": "application/json" }, body: JSON.stringify({}) })).status, 403);
    assert.equal((await fetch(`${origin}/api/models/${modelA.id}/share`, { method: "DELETE", headers: { cookie: cookieViewer } })).status, 403);
    assert.equal((await fetch(`${origin}/downloads/${modelA.slug}/original`, { headers: { cookie: cookieViewer } })).status, 403);
  });

  // ============================================================
  // Finding 4: deleted/orphan slugs serve no artifacts (no fs fallback)
  // ============================================================
  await t.test("deleted and never-existing model slugs serve no artifacts", async () => {
    const delUpload = await fetch(`${origin}/api/models`, { method: "POST", headers: { cookie: cookieA, accept: "application/json" }, body: glbForm("to-delete.glb") });
    const delModel = (await delUpload.json()) as { slug: string };
    assert.equal((await fetch(`${origin}/api/models/${delModel.slug}`, { method: "DELETE", headers: { cookie: cookieA } })).status, 200);

    for (const slug of [delModel.slug, "ghost-model-slug"]) {
      assert.equal((await fetch(`${origin}/model-files/${slug}/display.glb`, { headers: { cookie: cookieA } })).status, 404);
      assert.equal((await fetch(`${origin}/downloads/${slug}/original`, { headers: { cookie: cookieA } })).status, 404);
      assert.equal((await fetch(`${origin}/downloads/${slug}/display.glb`, { headers: { cookie: cookieA } })).status, 404);
      assert.equal((await fetch(`${origin}/admin/logs/${slug}/conversion.log`, { headers: { cookie: cookieA } })).status, 404);
      assert.equal((await fetch(`${origin}/admin/models/${slug}/xcaf-report.json`, { headers: { cookie: cookieA } })).status, 404);
      assert.equal((await fetch(`${origin}/admin/models/${slug}/mesh-report.json`, { headers: { cookie: cookieA } })).status, 404);
    }
  });

  // ============================================================
  // Finding 5/7: folders, projects, jobs, quota denied in workspace mode
  // ============================================================
  await t.test("global folder/project/job/quota routes are denied when auth is enabled", async () => {
    for (const p of ["/api/folders", "/api/projects", "/api/jobs", "/api/storage/quota"]) {
      assert.equal((await fetch(`${origin}${p}`, { headers: { cookie: cookieA } })).status, 403);
    }
  });

  // ============================================================
  // Finding 6: chunked-upload handles are bound to session/org
  // ============================================================
  await t.test("another org cannot use, complete, or cancel someone else's upload handle", async () => {
    const init = await fetch(`${origin}/api/uploads/chunked/init`, {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ filename: "handle.glb", sizeBytes: 1024 })
    });
    assert.equal(init.status, 201);
    const { uploadId } = (await init.json()) as { uploadId: string };

    // Org B may not complete or cancel A's handle.
    assert.equal((await fetch(`${origin}/api/uploads/chunked/${uploadId}/complete`, { method: "POST", headers: { cookie: cookieB } })).status, 404);
    assert.equal((await fetch(`${origin}/api/uploads/chunked/${uploadId}`, { method: "DELETE", headers: { cookie: cookieB } })).status, 404);

    // A revision upload handle cannot target another org's model.
    const revInit = await fetch(`${origin}/api/uploads/chunked/init`, {
      method: "POST",
      headers: { cookie: cookieB, "content-type": "application/json" },
      body: JSON.stringify({ filename: "rev.glb", sizeBytes: 1024, modelSlug: modelA.slug })
    });
    assert.equal(revInit.status, 404);

    // The owner can cancel its own handle.
    assert.equal((await fetch(`${origin}/api/uploads/chunked/${uploadId}`, { method: "DELETE", headers: { cookie: cookieA } })).status, 200);
  });

  // ============================================================
  // Positive control: owner A retains full control of its own model
  // ============================================================
  await t.test("owner A can still rename and revoke shares on its own model", async () => {
    const rename = await fetch(`${origin}/api/models/${modelA.slug}`, {
      method: "PATCH",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed By Owner" })
    });
    assert.equal(rename.status, 200);
    const revoke = await fetch(`${origin}/api/models/${modelA.id}/share`, { method: "DELETE", headers: { cookie: cookieA } });
    assert.equal(revoke.status, 200);
  });
});
