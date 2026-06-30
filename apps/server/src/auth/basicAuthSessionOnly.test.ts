import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

// Proves AUTH_ENABLED=true uses session/OIDC auth only for /admin — a valid
// Basic-auth header is no longer sufficient (and is not consulted at all).
// See basicAuthLegacy.test.ts for the AUTH_ENABLED=false half (kept separate:
// ESM module caching means a second in-process import of server.js would
// reuse whichever auth subsystem the first test in the file constructed).

test("AUTH_ENABLED=true does not accept Basic-auth for /admin (session/OIDC only)", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelbase-basic-auth-disabled-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  // A correct ADMIN_PASSWORD is configured to prove it is ignored once accounts
  // are enabled, not merely absent.
  process.env.ADMIN_PASSWORD = "test-password";
  process.env.AUTH_ENABLED = "true";
  process.env.AUTH_STORE = "memory";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.AUTH_ALLOWED_EMAILS = "owner@example.com";
  process.env.APP_BASE_URL = "http://127.0.0.1";

  const { app, authSubsystem } = await import("./../server.js");
  const { db } = await import("./../db.js");
  assert.equal(authSubsystem.enabled, true);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.ADMIN_PASSWORD;
    delete process.env.AUTH_ENABLED;
    delete process.env.AUTH_STORE;
    delete process.env.SESSION_SECRET;
    delete process.env.AUTH_ALLOWED_EMAILS;
  });

  // A correct Basic-auth header is no longer sufficient: the session guard
  // redirects to /login instead of admitting the request.
  const basicAuthAttempt = await fetch(`${origin}/admin`, {
    headers: { authorization: `Basic ${Buffer.from("admin:test-password").toString("base64")}` },
    redirect: "manual"
  });
  assert.equal(basicAuthAttempt.status, 302);
  assert.match(basicAuthAttempt.headers.get("location") || "", /^\/login/);

  // No credentials at all: same redirect (no WWW-Authenticate Basic challenge).
  const noAuth = await fetch(`${origin}/admin`, { redirect: "manual" });
  assert.equal(noAuth.status, 302);
  assert.equal(noAuth.headers.get("www-authenticate"), null);

  // A valid session cookie (minted the same way real login does) is required.
  const service = authSubsystem.service!;
  const login = await service.loginWithProvider({
    provider: "google",
    issuer: "https://accounts.google.com",
    subject: "google-sub-basic-retirement",
    email: "owner@example.com",
    emailVerified: true,
    displayName: "Owner",
    avatarUrl: null
  });
  assert.equal(login.ok, true);
  if (!login.ok) return;
  const session = await service.createSession(login.user.id, {
    activeOrganizationId: login.organization.id,
    ipAddress: null,
    userAgent: null
  });
  const withSession = await fetch(`${origin}/admin`, {
    headers: { cookie: `${authSubsystem.config.cookieName}=${session.token}` }
  });
  assert.equal(withSession.status, 200);
});
