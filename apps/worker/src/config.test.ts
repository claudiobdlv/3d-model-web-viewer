import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

test("Meshopt is the explicit worker default and can be disabled", () => {
  const originalToken = process.env.WORKER_API_TOKEN;
  const originalMode = process.env.GLB_OPTIMIZATION_MODE;
  try {
    process.env.WORKER_API_TOKEN = "test-token";
    delete process.env.GLB_OPTIMIZATION_MODE;
    assert.equal(loadConfig(["node", "worker"]).glbOptimizationMode, "meshopt");

    process.env.GLB_OPTIMIZATION_MODE = "disabled";
    assert.equal(loadConfig(["node", "worker"]).glbOptimizationMode, "disabled");
  } finally {
    if (originalToken === undefined) delete process.env.WORKER_API_TOKEN;
    else process.env.WORKER_API_TOKEN = originalToken;
    if (originalMode === undefined) delete process.env.GLB_OPTIMIZATION_MODE;
    else process.env.GLB_OPTIMIZATION_MODE = originalMode;
  }
});
