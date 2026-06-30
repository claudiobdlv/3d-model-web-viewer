import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

// Proves the Google-only login surface end-to-end: the /login page renders
// only the Google button (with Google-specific copy), and Microsoft's OAuth
// routes are unavailable even when Microsoft credentials happen to be
// configured — because AUTH_PROVIDERS defaults to "google" only.

test("login page shows only Google, and Microsoft OAuth routes are unavailable by default", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelbase-google-only-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.AUTH_ENABLED = "true";
  process.env.AUTH_STORE = "memory";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.APP_BASE_URL = "http://127.0.0.1";
  process.env.AUTH_ALLOWED_EMAILS = "owner@example.com";
  process.env.GOOGLE_CLIENT_ID = "test-google-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
  // Microsoft credentials ARE configured, proving exclusion comes from the
  // AUTH_PROVIDERS allow-list (left at its Google-only default here), not from
  // missing credentials.
  process.env.MICROSOFT_CLIENT_ID = "test-microsoft-client";
  process.env.MICROSOFT_CLIENT_SECRET = "test-microsoft-secret";
  delete process.env.AUTH_PROVIDERS;

  const { app, authSubsystem } = await import("./../server.js");
  const { db } = await import("./../db.js");
  assert.deepEqual(authSubsystem.config.allowedProviders, ["google"]);
  assert.ok(authSubsystem.config.providers.google);
  assert.equal(authSubsystem.config.providers.microsoft, undefined);

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
    delete process.env.MICROSOFT_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_SECRET;
  });

  const loginPage = await fetch(`${origin}/login`);
  assert.equal(loginPage.status, 200);
  const html = await loginPage.text();
  assert.match(html, /Continue with Google/);
  assert.doesNotMatch(html, /Continue with Microsoft/);
  assert.match(html, /Admin access uses Google sign-in\./);

  // Microsoft's start/callback routes are unavailable (503), not 404 — the
  // route exists in the codebase for future reuse, it just isn't configured.
  const msStart = await fetch(`${origin}/auth/microsoft/start`, { redirect: "manual" });
  assert.equal(msStart.status, 503);

  const msCallback = await fetch(`${origin}/auth/microsoft/callback?code=x&state=y`, { redirect: "manual" });
  assert.equal(msCallback.status, 503);
});
