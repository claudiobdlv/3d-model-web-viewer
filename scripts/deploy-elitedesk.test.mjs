// Lightweight behavioral test for scripts/deploy-elitedesk.sh's Postgres
// opt-in overlay, without requiring a real Docker daemon or git remote.
//
// It stands up a throwaway "APP_DIR" with copies of the real compose files
// and a fake `docker`/`git` on PATH that just record what they were called
// with, then asserts:
//   - the default invocation (no flag/env var) never references the Postgres
//     compose file and expects exactly server+worker.
//   - INCLUDE_POSTGRES=true / --with-postgres includes the Postgres compose
//     file and expects postgres+server+worker.
//
// Run directly: node --test scripts/deploy-elitedesk.test.mjs
// (Skips itself if `bash` is not on PATH — e.g. a non-Git-Bash Windows shell.)

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const scriptPath = path.resolve(repoRoot, "scripts/deploy-elitedesk.sh");

function toBashPath(winOrPosixPath) {
  const resolved = path.resolve(winOrPosixPath);
  return resolved.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`).replace(/\\/g, "/");
}

const bashAvailable = spawnSync("bash", ["--version"]).error === undefined;

function setupFakeEnv() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-elitedesk-test-"));
  const appDir = path.join(workDir, "app");
  const binDir = path.join(workDir, "bin");
  fs.mkdirSync(path.join(appDir, "deploy"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  fs.copyFileSync(
    path.resolve(repoRoot, "deploy/docker-compose.elitedesk.yml"),
    path.join(appDir, "deploy/docker-compose.elitedesk.yml")
  );
  fs.copyFileSync(
    path.resolve(repoRoot, "deploy/docker-compose.postgres.yml"),
    path.join(appDir, "deploy/docker-compose.postgres.yml")
  );
  fs.writeFileSync(path.join(appDir, ".env"), "POSTGRES_PASSWORD=test-only-not-real\n");

  const dockerLog = path.join(workDir, "docker.log");
  const gitLog = path.join(workDir, "git.log");
  fs.writeFileSync(dockerLog, "");
  fs.writeFileSync(gitLog, "");

  // Fake `docker`: records every invocation, and for `compose ... config
  // --services` answers based on which -f files were actually passed —
  // this is what lets the test tell default vs. --with-postgres apart.
  fs.writeFileSync(
    path.join(binDir, "docker"),
    `#!/usr/bin/env bash
echo "docker $*" >> "${toBashPath(dockerLog)}"
if [ "$1" = "compose" ]; then
  shift
  files=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -f) files+=("$2"); shift 2 ;;
      config)
        shift
        if [ "$1" = "--services" ]; then
          for f in "\${files[@]}"; do
            case "$f" in
              *postgres*) echo postgres ;;
            esac
          done
          printf 'server\\nworker\\n'
          exit 0
        fi
        ;;
      up|ps) exit 0 ;;
      *) shift ;;
    esac
  done
fi
exit 0
`,
    { mode: 0o755 }
  );

  // Fake `git`: no-op so the test never touches the real repo/network.
  fs.writeFileSync(
    path.join(binDir, "git"),
    `#!/usr/bin/env bash
echo "git $*" >> "${toBashPath(gitLog)}"
exit 0
`,
    { mode: 0o755 }
  );

  return { workDir, appDir, binDir, dockerLog, gitLog };
}

function runDeploy(env, extraArgs = []) {
  const { appDir, binDir, dockerLog } = setupFakeEnv();
  const result = spawnSync("bash", [toBashPath(scriptPath), ...extraArgs], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      APP_DIR: toBashPath(appDir),
      ...env
    }
  });
  const dockerCalls = fs.readFileSync(dockerLog, "utf8").trim().split("\n").filter(Boolean);
  return { result, dockerCalls };
}

test(
  "default deploy (no flag/env) never includes the Postgres compose file",
  { skip: !bashAvailable && "bash not found on PATH" },
  () => {
    const { result, dockerCalls } = runDeploy({});
    assert.equal(result.status, 0, result.stderr);
    assert.ok(dockerCalls.length > 0, "expected docker to be invoked");
    for (const call of dockerCalls) {
      assert.doesNotMatch(call, /docker-compose\.postgres\.yml/);
    }
  }
);

test(
  "INCLUDE_POSTGRES=true includes the Postgres compose overlay",
  { skip: !bashAvailable && "bash not found on PATH" },
  () => {
    const { result, dockerCalls } = runDeploy({ INCLUDE_POSTGRES: "true" });
    assert.equal(result.status, 0, result.stderr);
    const upCall = dockerCalls.find((c) => c.includes(" up "));
    assert.ok(upCall, "expected a docker compose up call");
    assert.match(upCall, /docker-compose\.postgres\.yml/);
    assert.match(upCall, /docker-compose\.elitedesk\.yml/);
  }
);

test(
  "--with-postgres flag includes the Postgres compose overlay",
  { skip: !bashAvailable && "bash not found on PATH" },
  () => {
    const { result, dockerCalls } = runDeploy({}, ["--with-postgres"]);
    assert.equal(result.status, 0, result.stderr);
    const upCall = dockerCalls.find((c) => c.includes(" up "));
    assert.ok(upCall, "expected a docker compose up call");
    assert.match(upCall, /docker-compose\.postgres\.yml/);
  }
);
