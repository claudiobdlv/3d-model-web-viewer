import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, "accounts-preflight.mjs");

// Start from a clean slate: strip every accounts-related env var so each test
// controls exactly what's "set".
function cleanEnv(overrides = {}) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) {
    if (
      /^(AUTH_|SESSION_|GOOGLE_|MICROSOFT_|DATABASE_URL|APP_BASE_URL|DATA_DIR|NODE_ENV|ALLOW_INSECURE_SESSION)/.test(
        key
      )
    ) {
      delete clean[key];
    }
  }
  return { ...clean, ...overrides };
}

function run(args, env) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: cleanEnv(env)
  });
}

test("incomplete env: FAIL status with clear blockers, exits 0 (no --check-db)", () => {
  const result = run(["--json"]);
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "FAIL");
  assert.equal(report.ready, false);
  assert.ok(report.blockers.length > 0);
  assert.ok(report.blockers.some((b) => b.includes("AUTH_ALLOWED_EMAILS")));
});

test("never prints secret values, only presence/counts", () => {
  const secrets = {
    SESSION_SECRET: "sekrit-session-value-12345",
    GOOGLE_CLIENT_SECRET: "sekrit-google-value-67890",
    DATABASE_URL: "postgres://user:sekrit-db-password@host:5432/db",
    AUTH_ALLOWED_EMAILS: "owner@example.test,second@example.test"
  };
  const result = run(["--json"], secrets);
  for (const value of Object.values(secrets)) {
    assert.doesNotMatch(result.stdout, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  // Text mode too.
  const textResult = run([], secrets);
  for (const value of Object.values(secrets)) {
    assert.doesNotMatch(textResult.stdout, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const report = JSON.parse(result.stdout);
  assert.equal(report.auth.AUTH_ALLOWED_EMAILS, "present (2 entries)");
});

test("does not enable auth, run migrations, or write anything — flags are report-only", () => {
  const result = run(["--json"], { AUTH_ENABLED: "true" });
  const report = JSON.parse(result.stdout);
  assert.equal(report.notes.includes("AUTH_ENABLED is already true in this environment."), true);
  // The script itself never sets AUTH_ENABLED; it only reports it back.
  assert.equal(process.env.AUTH_ENABLED, undefined);
});

test("complete env (memory-checkable fields) reports fewer blockers and a provider summary", () => {
  const result = run(["--json"], {
    APP_BASE_URL: "https://example.test",
    SESSION_SECRET: "x".repeat(32),
    DATABASE_URL: "postgres://u:p@host:5432/db",
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    AUTH_ALLOWED_EMAILS: "owner@example.test",
    NODE_ENV: "production",
    SESSION_COOKIE_SECURE: "true"
  });
  const report = JSON.parse(result.stdout);
  assert.equal(report.blockers.length, 0);
  assert.equal(report.ready, true);
  assert.equal(report.providers.google.usable, true);
  assert.equal(report.providers.microsoft.usable, false);
  assert.equal(report.secureCookies.status, "PASS");
});

test("microsoft allow-listed unexpectedly produces a warning (Google-only phase)", () => {
  const result = run(["--json"], { AUTH_PROVIDERS: "google,microsoft" });
  const report = JSON.parse(result.stdout);
  assert.ok(report.warnings.some((w) => w.includes("microsoft is in AUTH_PROVIDERS")));
});
