import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

// Proves the auth-endpoint rate limiter triggers (429) on a limited route and
// does NOT affect unrelated routes, and that an attempt against an unavailable
// provider records a sanitized audit event. Uses /auth/microsoft/start, which
// is reachable but unconfigured (Google-only default) so it returns 503 without
// any network/OAuth round-trip — the limiter runs before that handler.

test("auth endpoints are rate limited; /login is not; provider-unavailable is audited", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelbase-ratelimit-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.AUTH_ENABLED = "true";
  process.env.AUTH_STORE = "memory";
  process.env.SESSION_SECRET = "test-session-secret";
  process.env.APP_BASE_URL = "http://127.0.0.1";
  process.env.AUTH_ALLOWED_EMAILS = "owner@example.com";
  process.env.GOOGLE_CLIENT_ID = "test-google-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
  // Tight limit so the test triggers it deterministically in a few requests.
  process.env.AUTH_RATE_LIMIT_MAX = "3";
  delete process.env.AUTH_RATE_LIMIT_WINDOW_MS;
  delete process.env.AUTH_RATE_LIMIT_LOGIN_MAX;
  delete process.env.AUTH_PROVIDERS;

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
    delete process.env.AUTH_RATE_LIMIT_MAX;
  });

  // The OAuth limiter allows AUTH_RATE_LIMIT_MAX hits, then returns 429. The
  // unconfigured Microsoft provider returns 503 until the limit is hit.
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${origin}/auth/microsoft/start`, { redirect: "manual" });
    statuses.push(res.status);
    if (res.status === 429) {
      assert.ok(Number(res.headers.get("retry-after")) >= 1);
    }
  }
  assert.deepEqual(statuses, [503, 503, 503, 429]);

  // /login uses a separate, higher limiter — it is NOT tripped by exhausting
  // the OAuth limiter, proving the limit is scoped per endpoint group.
  const login = await fetch(`${origin}/login`);
  assert.equal(login.status, 200);

  // The provider-unavailable attempts were audited (sanitized: provider + phase
  // only, no PII/tokens). Exactly the three pre-429 attempts are recorded.
  const events = (authSubsystem.store as any)._auditEvents() as Array<{ event_type: string; metadata: any }>;
  const unavailable = events.filter((e) => e.event_type === "auth.provider_unavailable");
  assert.equal(unavailable.length, 3);
  assert.equal(unavailable[0].metadata.provider, "microsoft");
  assert.equal(unavailable[0].metadata.phase, "start");
});
