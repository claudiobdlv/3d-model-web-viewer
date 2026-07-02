import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, "accounts-migrate-auth-db.mjs");

function run(args, env = {}) {
  // Start from a clean env so a real DATABASE_URL in the shell can't leak in.
  const clean = { ...process.env };
  delete clean.DATABASE_URL;
  delete clean.AUTH_ENABLED;
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...clean, ...env }
  });
}

test("--help exits 0 and does not require DATABASE_URL", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Applies auth-layer Postgres migrations/);
});

test("a real (non-dry-run) apply fails clearly without DATABASE_URL, touching no Postgres", () => {
  const result = run([]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_URL is required/);
});

test("--dry-run lists migrations without needing DATABASE_URL (safe anywhere)", () => {
  // No DATABASE_URL in env: dry-run must still succeed and open no connection.
  const result = run(["--dry-run"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /DRY RUN: no database connection opened/);
  assert.match(result.stdout, /0001_auth_init\.sql/);
  assert.doesNotMatch(result.stdout, /DATABASE_URL is required/);
  // The script itself must never set AUTH_ENABLED in its own environment.
  assert.equal(process.env.AUTH_ENABLED, undefined);
});

test("never prints the DATABASE_URL (which can contain a password)", () => {
  const secretUrl = "postgres://modelbase:sup3r-secret-pw@postgres:5432/modelbase";
  const result = run(["--dry-run"], { DATABASE_URL: secretUrl });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /sup3r-secret-pw/);
  assert.doesNotMatch(result.stdout, /sup3r-secret-pw/);
});
