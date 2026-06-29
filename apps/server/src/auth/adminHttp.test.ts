import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { ProviderProfile } from "./types.js";

// End-to-end HTTP test of the accounts-enabled admin protection using the
// in-memory store (no PostgreSQL, no live OAuth provider). Sessions are minted
// directly via the exported auth subsystem service, exercising the exact same
// cookie + middleware path a real login would use.

const googleProfile: ProviderProfile = {
  provider: "google",
  issuer: "https://accounts.google.com",
  subject: "google-sub-http",
  email: "owner@example.com",
  emailVerified: true,
  displayName: "Owner One",
  avatarUrl: null
};

test("accounts-enabled admin protection, scoping, and logout", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelbase-auth-http-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.AUTH_ENABLED = "true";
  process.env.AUTH_STORE = "memory";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.APP_BASE_URL = "http://127.0.0.1";
  // No ADMIN_PASSWORD needed: the session guard governs when accounts are on.

  const { app, authSubsystem } = await import("./../server.js");
  const { db } = await import("./../db.js");
  assert.equal(authSubsystem.enabled, true);
  const service = authSubsystem.service!;
  const cookieName = authSubsystem.config.cookieName;

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.AUTH_ENABLED;
    delete process.env.AUTH_STORE;
    delete process.env.SESSION_SECRET;
  });

  // --- Unauthenticated access is blocked ---
  const adminRes = await fetch(`${origin}/admin`, { redirect: "manual" });
  assert.equal(adminRes.status, 302);
  assert.match(adminRes.headers.get("location") || "", /^\/login/);

  const apiRes = await fetch(`${origin}/api/models`);
  assert.equal(apiRes.status, 401);

  const loginPage = await fetch(`${origin}/login`);
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /ModelBase/);

  // --- Mint a session for org A's owner (same path a real login uses) ---
  const loginA = await service.loginWithProvider(googleProfile);
  assert.equal(loginA.ok, true);
  if (!loginA.ok) return;
  const sessionA = await service.createSession(loginA.user.id, {
    activeOrganizationId: loginA.organization.id,
    ipAddress: null,
    userAgent: null
  });
  const cookieA = `${cookieName}=${sessionA.token}`;

  // /api/me returns 401 with authenticated:false when there is no session.
  const meAnon = await fetch(`${origin}/api/me`);
  assert.equal(meAnon.status, 401);
  assert.equal((await meAnon.json() as { authenticated: boolean }).authenticated, false);

  // /api/me returns user and organisation for an authenticated session.
  const meA = await fetch(`${origin}/api/me`, { headers: { cookie: cookieA } });
  assert.equal(meA.status, 200);
  const meABody = await meA.json() as { authenticated: boolean; user: { email: string; displayName: string | null }; organization: { name: string } | null };
  assert.equal(meABody.authenticated, true);
  assert.equal(meABody.user.email, googleProfile.email);
  assert.equal(meABody.user.displayName, googleProfile.displayName);
  assert.ok(meABody.organization !== null);

  // Authenticated list works and is initially empty for this workspace.
  const listA0 = await fetch(`${origin}/api/models`, { headers: { cookie: cookieA } });
  assert.equal(listA0.status, 200);
  assert.deepEqual(await listA0.json(), []);

  // --- Upload a model as org A; it must receive org + creator ownership ---
  const form = new FormData();
  form.set("modelFile", new Blob([Buffer.from("glb-bytes")], { type: "model/gltf-binary" }), "accounts-phase1-v1-test.glb");
  const upload = await fetch(`${origin}/api/models`, {
    method: "POST",
    headers: { cookie: cookieA, accept: "application/json" },
    body: form
  });
  assert.equal(upload.status, 201);
  const model = (await upload.json()) as { id: number; slug: string };

  const row = db.prepare("SELECT organization_id, created_by_user_id, visibility FROM models WHERE id = ?").get(model.id) as {
    organization_id: string;
    created_by_user_id: string;
    visibility: string;
  };
  assert.equal(row.organization_id, loginA.organization.id);
  assert.equal(row.created_by_user_id, loginA.user.id);
  assert.equal(row.visibility, "private");

  const listA1 = await fetch(`${origin}/api/models`, { headers: { cookie: cookieA } });
  assert.equal((await listA1.json() as unknown[]).length, 1);

  // --- A different workspace cannot see or fetch org A's model ---
  const loginB = await service.loginWithProvider({
    ...googleProfile,
    subject: "google-sub-http-b",
    email: "other@example.com"
  });
  assert.equal(loginB.ok, true);
  if (!loginB.ok) return;
  const sessionB = await service.createSession(loginB.user.id, {
    activeOrganizationId: loginB.organization.id,
    ipAddress: null,
    userAgent: null
  });
  const cookieB = `${cookieName}=${sessionB.token}`;

  const listB = await fetch(`${origin}/api/models`, { headers: { cookie: cookieB } });
  assert.deepEqual(await listB.json(), []);

  const crossOrg = await fetch(`${origin}/api/models/${model.slug}`, { headers: { cookie: cookieB } });
  assert.equal(crossOrg.status, 404);

  // Owner can still fetch its own model by slug.
  const ownFetch = await fetch(`${origin}/api/models/${model.slug}`, { headers: { cookie: cookieA } });
  assert.equal(ownFetch.status, 200);

  // --- POST logout revokes the session (canonical UI path) ---
  const logout = await fetch(`${origin}/auth/logout`, { method: "POST", headers: { cookie: cookieA }, redirect: "manual" });
  assert.equal(logout.status, 302);
  assert.match(logout.headers.get("location") || "", /^\/login/);
  const afterLogout = await fetch(`${origin}/api/models`, { headers: { cookie: cookieA } });
  assert.equal(afterLogout.status, 401);

  // GET logout also works (kept for backward compatibility, e.g. manual navigation).
  const sessionC = await service.createSession(loginA.user.id, {
    activeOrganizationId: loginA.organization.id,
    ipAddress: null,
    userAgent: null
  });
  const cookieC = `${cookieName}=${sessionC.token}`;
  const logoutGet = await fetch(`${origin}/auth/logout`, { headers: { cookie: cookieC }, redirect: "manual" });
  assert.equal(logoutGet.status, 302);
  const afterLogoutGet = await fetch(`${origin}/api/models`, { headers: { cookie: cookieC } });
  assert.equal(afterLogoutGet.status, 401);
});
