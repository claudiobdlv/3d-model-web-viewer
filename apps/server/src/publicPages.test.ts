import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

// /privacy and /security must be reachable regardless of AUTH_ENABLED — they
// carry no account data and are linked from the (feature-flagged) /login page.

test("/privacy and /security are always available and carry the required copy", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelbase-public-pages-"));
  process.env.NODE_ENV = "test";
  process.env.DATA_DIR = dataDir;
  delete process.env.AUTH_ENABLED;
  delete process.env.ADMIN_PASSWORD;

  const [{ app }, { db }] = await Promise.all([import("./server.js"), import("./db.js")]);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const privacy = await fetch(`${origin}/privacy`);
  assert.equal(privacy.status, 200);
  const privacyHtml = await privacy.text();
  assert.match(privacyHtml, /Private by default/);
  assert.match(privacyHtml, /revocable/i);
  assert.match(privacyHtml, /not used to train/i);
  assert.match(privacyHtml, /Secrets stay out of the UI/);
  assert.match(privacyHtml, /backups/i);
  // Must not overpromise instant/permanent deletion ahead of documented retention.
  assert.match(privacyHtml, /should not be assumed to be instant or permanent/i);

  const security = await fetch(`${origin}/security`);
  assert.equal(security.status, 200);
  const securityHtml = await security.text();
  assert.match(securityHtml, /Google sign-in/);
  assert.match(securityHtml, /Workspace-scoped access/);
  assert.match(securityHtml, /Approved accounts only/);
  assert.match(securityHtml, /Audit trail/);
  assert.match(securityHtml, /No secret exposure/);
});
