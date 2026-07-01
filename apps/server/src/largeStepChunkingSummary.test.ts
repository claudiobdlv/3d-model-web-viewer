import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("largeStepChunkingSummary helper normalization and log parsing", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelbase-summary-test-"));
  process.env.DATA_DIR = tempDir;

  const { getLargeStepChunkingSummary } = await import("./utils/largeStepChunkingSummary.js");

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const slug = "test-model-slug";
  const modelDir = path.join(tempDir, "models", slug);
  const logDir = path.join(tempDir, "logs", slug);
  fs.mkdirSync(modelDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const manifestPath = path.join(modelDir, "manifest.json");
  const statsPath = path.join(modelDir, "stats.json");
  const logPath = path.join(logDir, "conversion.log");

  await t.test("returns undefined if no metadata files exist", () => {
    const summary = getLargeStepChunkingSummary(slug, false);
    assert.equal(summary, undefined);
  });

  await t.test("extracts and normalizes skipped chunking metadata", () => {
    const manifest = {
      slug,
      largeStepChunking: {
        mode: "auto",
        status: "skipped",
        skipReason: "below-auto-min-size",
        decision: {
          reasons: ["file_size_below_auto_min_size"]
        }
      }
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const summary = getLargeStepChunkingSummary(slug, false);
    assert.ok(summary);
    assert.equal(summary.mode, "auto");
    assert.equal(summary.status, "skipped");
    assert.equal(summary.skipReason, "below-auto-min-size");
    assert.equal(summary.label, "Auto skipped");
    assert.equal(summary.detailLabel, "below 25 MB");
    assert.deepEqual(summary.decisionReasons, ["file_size_below_auto_min_size"]);
  });

  await t.test("extracts and normalizes applied/chunked metadata", () => {
    const manifest = {
      slug,
      largeStepChunking: {
        mode: "auto",
        status: "applied",
        targetChunks: 4,
        actualChunks: 4,
        plannerDurationSeconds: 1.5,
        totalWallClockSeconds: 10.2,
        adaptiveConcurrency: {
          maxReached: 2,
          summary: {
            peakMemoryUsedFraction: 0.65,
            swapGrowthBytes: 104857600
          }
        },
        decision: {
          reasons: ["file_size_large_complexity", "memory_based_cap"]
        },
        chunks: [
          { index: 0, durationMs: 1500, triangleCount: 1000 },
          { index: 1, durationMs: 2000, triangleCount: 2000 }
        ]
      },
      optimization: {
        rawSizeBytes: 50000000,
        displaySizeBytes: 20000000,
        reductionPercent: 60.0
      }
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const summary = getLargeStepChunkingSummary(slug, false);
    assert.ok(summary);
    assert.equal(summary.mode, "auto");
    assert.equal(summary.status, "applied");
    assert.equal(summary.label, "Auto chunked");
    assert.equal(summary.detailLabel, "4 chunks, max active 2 — memory capped");
    assert.equal(summary.maxActiveChunks, 2);
    assert.equal(summary.plannerDurationSeconds, 1.5);
    assert.equal(summary.totalWallClockSeconds, 10.2);
    assert.equal(summary.peakMemoryFraction, 0.65);
    assert.equal(summary.swapGrowthBytes, 104857600);
    assert.equal(summary.rawGlbBytes, 50000000);
    assert.equal(summary.finalGlbBytes, 20000000);
    assert.equal(summary.meshoptReductionPercent, 60.0);
    assert.ok(Array.isArray(summary.chunks));
    assert.equal(summary.chunks[0].durationSeconds, 1.5);
    assert.equal(summary.chunks[1].triangles, 2000);
  });

  await t.test("exposes trustworthy Meshopt details from a revision artifact directory", () => {
    const revisionDir = path.join(modelDir, "revisions", "7");
    fs.mkdirSync(revisionDir, { recursive: true });
    fs.writeFileSync(path.join(revisionDir, "manifest.json"), JSON.stringify({
      converterBackend: "xcaf-baseline",
      quality: "medium",
      optimization: {
        optimizationRequested: true,
        optimizationEnabled: true,
        requestedMode: "meshopt",
        status: "applied",
        optimizer: "@gltf-transform direct APIs + meshoptimizer",
        rawSizeBytes: 1000,
        candidateSizeBytes: 400,
        displaySizeBytes: 400,
        bytesSaved: 600,
        reductionPercent: 60,
        compressionRatio: 2.5,
        validation: { passed: true, message: "passed semantic gates" },
        fallbackUsed: false,
        fallbackReason: null,
        finalUsesMeshoptCompression: true,
        compression: { compressedBufferViews: 3 }
      }
    }));
    fs.writeFileSync(path.join(revisionDir, "stats.json"), JSON.stringify({
      sourceFileSizeBytes: 2500,
      converterBackend: "xcaf-baseline",
      qualityPreset: "medium",
      colourMode: "xcaf-baseline",
      triangleCount: 1234,
      meshReuse: { reusedInstances: 9 }
    }));

    const summary = getLargeStepChunkingSummary(slug, { artifactDir: revisionDir });
    assert.ok(summary);
    assert.equal(summary.optimizationLabel, "Meshopt applied");
    assert.equal(summary.optimizationDetailLabel, "60% smaller");
    assert.equal(summary.sourceBytes, 2500);
    assert.equal(summary.rawGlbBytes, 1000);
    assert.equal(summary.finalGlbBytes, 400);
    assert.equal(summary.bytesSaved, 600);
    assert.equal(summary.compressionRatio, 2.5);
    assert.equal(summary.validationPassed, true);
    assert.equal(summary.finalUsesMeshoptCompression, true);
    assert.equal(summary.compressedBufferViews, 3);
    assert.equal(summary.backend, "xcaf-baseline");
    assert.equal(summary.qualityPreset, "medium");
    assert.equal(summary.colourMode, "xcaf-baseline");
    assert.equal(summary.triangleCount, 1234);
    assert.deepEqual(summary.meshReuse, { reusedInstances: 9 });
  });

  await t.test("extracts and normalizes failed chunking/fallback metadata", () => {
    const stats = {
      largeStepChunking: {
        mode: "auto",
        status: "fallback-full-conversion",
        fallbackReason: "Planner failed with error: exit code 1"
      }
    };
    fs.writeFileSync(manifestPath, "{}"); // Empty manifest
    fs.writeFileSync(statsPath, JSON.stringify(stats));

    const summary = getLargeStepChunkingSummary(slug, false);
    assert.ok(summary);
    assert.equal(summary.status, "fallback-full-conversion");
    assert.equal(summary.label, "Chunking failed");
    assert.equal(summary.detailLabel, "planner failed");
  });

  await t.test("parses conversion log if readLog is true", () => {
    if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
    if (fs.existsSync(statsPath)) fs.unlinkSync(statsPath);

    // Write conversion.log
    fs.writeFileSync(logPath, `
[CHUNKING] Running STEP pre-scan for medium file...
[CHUNKING] Running planner: with target chunks 3
[CHUNKING] Starting chunk 0
[CHUNKING] Completed chunk 0 in 5.2s
[CHUNKING] Starting chunk 1
`);

    const summary = getLargeStepChunkingSummary(slug, true);
    assert.ok(summary);
    assert.equal(summary.label, "Processing: chunk 2/3");

    // Test merging state
    fs.writeFileSync(logPath, `
[CHUNKING] Starting chunk 2
[CHUNKING] Completed chunk 2 in 4.1s
[CHUNKING] Merging chunk GLBs...
`);
    const summary2 = getLargeStepChunkingSummary(slug, true);
    assert.ok(summary2);
    assert.equal(summary2.label, "Processing: merging");
  });
});
