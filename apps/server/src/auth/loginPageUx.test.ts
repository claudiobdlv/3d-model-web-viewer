import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

// Covers the Accounts UX + Security Visibility Pack 1 login-page polish and
// the distinct email_not_allowed ("access denied") treatment.

test("login page shows ModelBase branding, tagline, and privacy/security links", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelbase-login-ux-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.AUTH_ENABLED = "true";
  process.env.AUTH_STORE = "memory";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.APP_BASE_URL = "http://127.0.0.1";
  process.env.AUTH_ALLOWED_EMAILS = "owner@example.com,secret-admin@example.com";
  process.env.GOOGLE_CLIENT_ID = "test-google-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";

  const { app, authSubsystem } = await import("./../server.js");
  const { db } = await import("./../db.js");

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
    delete process.env.AUTH_ALLOWED_EMAILS;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });
  assert.equal(authSubsystem.enabled, true);

  const loginPage = await fetch(`${origin}/login`);
  assert.equal(loginPage.status, 200);
  const html = await loginPage.text();
  assert.match(html, /ModelBase/);
  assert.match(html, /Private 3D model sharing for engineering teams\./);
  assert.match(html, /Continue with Google/);
  assert.match(html, /href="\/privacy"/);
  assert.match(html, /href="\/security"/);

  // --- email_not_allowed gets a distinct, non-leaking "access denied" state ---
  const denied = await fetch(`${origin}/login?error=email_not_allowed`);
  assert.equal(denied.status, 200);
  const deniedHtml = await denied.text();
  assert.match(deniedHtml, /class="access-denied"/);
  assert.match(deniedHtml, /approved for this workspace/i);
  assert.match(deniedHtml, /No account was created/i);
  assert.match(deniedHtml, /workspace owner or admin/i);
  // Never leaks the actual allow-listed email addresses.
  assert.doesNotMatch(deniedHtml, /owner@example\.com/);
  assert.doesNotMatch(deniedHtml, /secret-admin@example\.com/);

  // Other error codes keep the plain (non-access-denied) banner treatment.
  const collision = await fetch(`${origin}/login?error=collision`);
  const collisionHtml = await collision.text();
  assert.match(collisionHtml, /class="banner"/);
  assert.doesNotMatch(collisionHtml, /class="access-denied"/);
});
