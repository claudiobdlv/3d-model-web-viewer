import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

// Proves AUTH_ENABLED=false preserves the legacy ADMIN_PASSWORD Basic-auth
// admin flow exactly as before — the rollback path while accounts stay off.
// See basicAuthSessionOnly.test.ts for the AUTH_ENABLED=true half (kept in a
// separate file: ESM module caching means a second in-process import of
// server.js would reuse the first test's already-constructed auth subsystem).

test("AUTH_ENABLED=false preserves the legacy Basic-auth admin flow", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelbase-basic-auth-legacy-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  process.env.ADMIN_PASSWORD = "test-password";
  delete process.env.AUTH_ENABLED;

  const { app, authSubsystem } = await import("./../server.js");
  const { db } = await import("./../db.js");
  assert.equal(authSubsystem.enabled, false);

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.ADMIN_PASSWORD;
  });

  // No credentials: rejected with the legacy Basic challenge, not a redirect.
  const noAuth = await fetch(`${origin}/admin`, { redirect: "manual" });
  assert.equal(noAuth.status, 401);
  assert.match(noAuth.headers.get("www-authenticate") || "", /^Basic /);

  // Wrong password: still rejected.
  const wrongAuth = await fetch(`${origin}/admin`, {
    headers: { authorization: `Basic ${Buffer.from("admin:wrong").toString("base64")}` }
  });
  assert.equal(wrongAuth.status, 401);

  // Correct password: legacy Basic-auth admits the request.
  const rightAuth = await fetch(`${origin}/admin`, {
    headers: { authorization: `Basic ${Buffer.from("admin:test-password").toString("base64")}` }
  });
  assert.equal(rightAuth.status, 200);
});
