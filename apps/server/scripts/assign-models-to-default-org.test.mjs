import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, "assign-models-to-default-org.mjs");

function run(args, env = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

test("requires --owner-email", () => {
  const result = run([], { DATABASE_URL: "postgres://x", DATA_DIR: "/tmp" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--owner-email is required/);
});

test("a real (non-dry-run) invocation refuses to write without --require-backup-confirmation", () => {
  const result = run(["--owner-email", "owner@example.test"], {
    DATABASE_URL: "postgres://x",
    DATA_DIR: "/tmp"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires --require-backup-confirmation/);
  // This must fail before ever touching Postgres/SQLite.
  assert.doesNotMatch(result.stdout, /Updated \d+ model rows/);
});

test("--dry-run bypasses the backup-confirmation guard (fails later, on missing DB config instead)", () => {
  const result = run(["--owner-email", "owner@example.test", "--dry-run"], {
    DATABASE_URL: "",
    DATA_DIR: ""
  });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /requires --require-backup-confirmation/);
  assert.match(result.stderr, /DATABASE_URL is required/);
});

test("requires DATA_DIR even in dry-run mode", () => {
  const result = run(["--owner-email", "owner@example.test", "--dry-run"], {
    DATABASE_URL: "postgres://x",
    DATA_DIR: ""
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATA_DIR is required/);
});
