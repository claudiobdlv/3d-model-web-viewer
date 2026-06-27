import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import child_process from "node:child_process";
import EventEmitter from "node:events";
import { Readable } from "node:stream";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";

import { preScanStepFile } from "./utils/stepPreScan.js";
import { decideLargeStepChunking } from "./utils/largeStepDecision.js";
import { getResourceSnapshot } from "./utils/resourceMonitor.js";
import { convertStepJob } from "./converterProcessor.js";

// Helper Mock ChildProcess
class MockChildProcess extends EventEmitter {
  public stdout: Readable;
  public exitCode: number | null = null;
  public signalCode: string | null = null;
  public killed = false;
  public pid = 99999;
  public lastSignal: string | null = null;

  constructor() {
    super();
    this.stdout = new Readable({
      read() {}
    });
  }

  kill(signal: string = "SIGTERM") {
    this.killed = true;
    this.lastSignal = signal;
    this.signalCode = signal;
    process.nextTick(() => {
      this.emit("exit", null, signal);
    });
    return true;
  }
}

function createChunkFixture(suffix: string): Document {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const indices = [0, 1, 2];

  const position = document
    .createAccessor(`positions-${suffix}`)
    .setType("VEC3")
    .setArray(new Float32Array(positions))
    .setBuffer(buffer);
  const indexAccessor = document
    .createAccessor(`indices-${suffix}`)
    .setType("SCALAR")
    .setArray(new Uint32Array(indices))
    .setBuffer(buffer);
  const material = document.createMaterial(`Material-${suffix}`).setBaseColorFactor([0.3, 0.5, 0.7, 1]);
  material.setExtras({ colourSource: `source-${suffix}` });
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", position)
    .setIndices(indexAccessor)
    .setMaterial(material);
  primitive.setExtras({ geometryTag: `tag-${suffix}` });
  const mesh = document.createMesh(`Mesh-${suffix}`).addPrimitive(primitive).setExtras({ stableObjectId: `stable-${suffix}` });
  const node = document
    .createNode(`Node-${suffix}`)
    .setMesh(mesh)
    .setExtras({ selectableId: `selectable-${suffix}` });
  document.createScene(`Scene-${suffix}`).addChild(node);
  return document;
}

async function setupTestDir(dir: string) {
  const xcafConverterBin = path.join(dir, "xcaf-step-to-glb");
  const plannerBin = path.join(dir, "xcaf-step-planner");
  await fs.promises.writeFile(xcafConverterBin, "dummy bin");
  await fs.promises.writeFile(plannerBin, "dummy bin");
  return { xcafConverterBin, plannerBin };
}

// ----------------------------------------------------
// 1. STEP Text Pre-Scan Tests
// ----------------------------------------------------
test("stepPreScan: simple step file", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "prescan-test-"));
  const filePath = path.join(tempDir, "simple.step");
  const stepContent = `
HEADER;
ENDSEC;
DATA;
#1 = PRODUCT('test', 'test', '', ($));
#2 = SHAPE_REPRESENTATION('rep', (), #1);
ENDSEC;
END-ISO-10303-21;
  `;
  await fs.promises.writeFile(filePath, stepContent);

  try {
    const result = await preScanStepFile(filePath);
    assert.equal(result.productCount, 1);
    assert.equal(result.relationshipCount, 0);
    assert.equal(result.probablyComplex, false);
    assert.equal(result.reasons.length, 0);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test("stepPreScan: complex step file (advanced faces)", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "prescan-test-"));
  const filePath = path.join(tempDir, "complex.step");
  
  // Write 50001 advanced faces to trigger threshold
  let stepContent = "DATA;\n";
  for (let i = 0; i < 50005; i++) {
    stepContent += `#${i} = ADVANCED_FACE('', (), #1, .T.);\n`;
  }
  await fs.promises.writeFile(filePath, stepContent);

  try {
    const result = await preScanStepFile(filePath);
    assert.equal(result.advancedFaceCount, 50005);
    assert.equal(result.probablyComplex, true);
    assert.ok(result.reasons[0].includes("advancedFaceCount"));
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------
// 2. Standalone Decision Logic Tests
// ----------------------------------------------------
test("largeStepDecision: disabled mode", () => {
  const input = { filePath: "model.step", fileSizeBytes: 100 * 1024 * 1024, converterBackend: "xcaf-baseline" };
  const config = {
    largeStepChunkingMode: "disabled" as const,
    largeStepAutoMinFileSizeMb: 25,
    largeStepAutoPlannerFileSizeMb: 80,
    largeStepAutoPrescanEnabled: true,
    largeStepForcePlanner: false,
    largeStepLeafCountThreshold: 2000,
    largeStepFaceCountThreshold: 50000,
    largeStepWorkScoreThreshold: 35000
  };
  const result = decideLargeStepChunking(input, config);
  assert.equal(result.shouldChunk, false);
  assert.equal(result.skipReason, "disabled");
});

test("largeStepDecision: non-step extension", () => {
  const input = { filePath: "model.glb", fileSizeBytes: 100 * 1024 * 1024, converterBackend: "xcaf-baseline" };
  const config = {
    largeStepChunkingMode: "auto" as const,
    largeStepAutoMinFileSizeMb: 25,
    largeStepAutoPlannerFileSizeMb: 80,
    largeStepAutoPrescanEnabled: true,
    largeStepForcePlanner: false,
    largeStepLeafCountThreshold: 2000,
    largeStepFaceCountThreshold: 50000,
    largeStepWorkScoreThreshold: 35000
  };
  const result = decideLargeStepChunking(input, config);
  assert.equal(result.shouldChunk, false);
  assert.equal(result.skipReason, "non-step");
});

test("largeStepDecision: below auto min size", () => {
  const input = { filePath: "model.step", fileSizeBytes: 10 * 1024 * 1024, converterBackend: "xcaf-baseline" };
  const config = {
    largeStepChunkingMode: "auto" as const,
    largeStepAutoMinFileSizeMb: 25,
    largeStepAutoPlannerFileSizeMb: 80,
    largeStepAutoPrescanEnabled: true,
    largeStepForcePlanner: false,
    largeStepLeafCountThreshold: 2000,
    largeStepFaceCountThreshold: 50000,
    largeStepWorkScoreThreshold: 35000
  };
  const result = decideLargeStepChunking(input, config);
  assert.equal(result.shouldChunk, false);
  assert.equal(result.skipReason, "below-auto-min-size");
});

test("largeStepDecision: auto mode requests prescan for medium files", () => {
  const input = { filePath: "model.step", fileSizeBytes: 40 * 1024 * 1024, converterBackend: "xcaf-baseline" };
  const config = {
    largeStepChunkingMode: "auto" as const,
    largeStepAutoMinFileSizeMb: 25,
    largeStepAutoPlannerFileSizeMb: 80,
    largeStepAutoPrescanEnabled: true,
    largeStepForcePlanner: false,
    largeStepLeafCountThreshold: 2000,
    largeStepFaceCountThreshold: 50000,
    largeStepWorkScoreThreshold: 35000
  };
  const result = decideLargeStepChunking(input, config);
  assert.equal(result.shouldRunPreScan, true);
  assert.equal(result.shouldRunPlanner, false);
  assert.equal(result.shouldChunk, false);
});

test("largeStepDecision: prescan simple skips planner", () => {
  const input = { filePath: "model.step", fileSizeBytes: 40 * 1024 * 1024, converterBackend: "xcaf-baseline" };
  const config = {
    largeStepChunkingMode: "auto" as const,
    largeStepAutoMinFileSizeMb: 25,
    largeStepAutoPlannerFileSizeMb: 80,
    largeStepAutoPrescanEnabled: true,
    largeStepForcePlanner: false,
    largeStepLeafCountThreshold: 2000,
    largeStepFaceCountThreshold: 50000,
    largeStepWorkScoreThreshold: 35000
  };
  const preScan = {
    fileSizeBytes: 40 * 1024 * 1024,
    advancedFaceCount: 100,
    manifoldSolidBrepCount: 5,
    closedShellCount: 5,
    productCount: 10,
    shapeRepresentationCount: 10,
    relationshipCount: 0,
    probablyComplex: false,
    reasons: []
  };
  const result = decideLargeStepChunking(input, config, preScan);
  assert.equal(result.shouldRunPlanner, false);
  assert.equal(result.shouldChunk, false);
  assert.equal(result.skipReason, "prescan-not-complex");
});

test("largeStepDecision: prescan complex runs planner", () => {
  const input = { filePath: "model.step", fileSizeBytes: 40 * 1024 * 1024, converterBackend: "xcaf-baseline" };
  const config = {
    largeStepChunkingMode: "auto" as const,
    largeStepAutoMinFileSizeMb: 25,
    largeStepAutoPlannerFileSizeMb: 80,
    largeStepAutoPrescanEnabled: true,
    largeStepForcePlanner: false,
    largeStepLeafCountThreshold: 2000,
    largeStepFaceCountThreshold: 50000,
    largeStepWorkScoreThreshold: 35000
  };
  const preScan = {
    fileSizeBytes: 40 * 1024 * 1024,
    advancedFaceCount: 60000,
    manifoldSolidBrepCount: 5,
    closedShellCount: 5,
    productCount: 10,
    shapeRepresentationCount: 10,
    relationshipCount: 0,
    probablyComplex: true,
    reasons: ["advancedFaceCount >= 50000"]
  };
  const result = decideLargeStepChunking(input, config, preScan);
  assert.equal(result.shouldRunPlanner, true);
  assert.equal(result.shouldChunk, false);
});

test("largeStepDecision: large file runs planner directly", () => {
  const input = { filePath: "model.step", fileSizeBytes: 90 * 1024 * 1024, converterBackend: "xcaf-baseline" };
  const config = {
    largeStepChunkingMode: "auto" as const,
    largeStepAutoMinFileSizeMb: 25,
    largeStepAutoPlannerFileSizeMb: 80,
    largeStepAutoPrescanEnabled: true,
    largeStepForcePlanner: false,
    largeStepLeafCountThreshold: 2000,
    largeStepFaceCountThreshold: 50000,
    largeStepWorkScoreThreshold: 35000
  };
  const result = decideLargeStepChunking(input, config);
  assert.equal(result.shouldRunPreScan, false);
  assert.equal(result.shouldRunPlanner, true);
  assert.equal(result.shouldChunk, false);
});

test("largeStepDecision: planner threshold matching", () => {
  const input = { filePath: "model.step", fileSizeBytes: 90 * 1024 * 1024, converterBackend: "xcaf-baseline" };
  const config = {
    largeStepChunkingMode: "auto" as const,
    largeStepAutoMinFileSizeMb: 25,
    largeStepAutoPlannerFileSizeMb: 80,
    largeStepAutoPrescanEnabled: true,
    largeStepForcePlanner: false,
    largeStepLeafCountThreshold: 2000,
    largeStepFaceCountThreshold: 50000,
    largeStepWorkScoreThreshold: 35000
  };

  // 1. Thresholds below limits
  const p1 = { leafCount: 1000, faceCount: 20000, workScore: 15000, recommended: false };
  const r1 = decideLargeStepChunking(input, config, undefined, p1);
  assert.equal(r1.shouldChunk, false);
  assert.equal(r1.skipReason, "planner-not-worth-it");

  // 2. Leaf count above threshold
  const p2 = { leafCount: 2500, faceCount: 20000, workScore: 15000, recommended: false };
  const r2 = decideLargeStepChunking(input, config, undefined, p2);
  assert.equal(r2.shouldChunk, true);

  // 3. Work score above threshold
  const p3 = { leafCount: 1000, faceCount: 20000, workScore: 40000, recommended: false };
  const r3 = decideLargeStepChunking(input, config, undefined, p3);
  assert.equal(r3.shouldChunk, true);

  // 4. Recommended true
  const p4 = { leafCount: 1000, faceCount: 20000, workScore: 15000, recommended: true };
  const r4 = decideLargeStepChunking(input, config, undefined, p4);
  assert.equal(r4.shouldChunk, true);
});

// ----------------------------------------------------
// 3. Resource Monitor Tests
// ----------------------------------------------------
test("resourceMonitor: cgroup-aware and safe conditions", (t) => {
  const config = {
    largeStepMaxWorkerMemoryFraction: 0.75,
    largeStepMinFreeMemoryMb: 900,
    largeStepMaxSwapGrowthMb: 512,
    largeStepEmergencyMemoryFraction: 0.92
  };

  const fsExistsMock = t.mock.method(fs, "existsSync", (p: string) => true);
  const fsReadFileMock = t.mock.method(fs, "readFileSync", (p: string) => {
    if (p.includes("memory.current")) return "3000000000"; // 3GB
    if (p.includes("memory.max")) return "8000000000"; // 8GB
    if (p.includes("memory.swap.current")) return "100000000"; // 100MB
    return "0";
  });

  const snapshot = getResourceSnapshot(config, 50 * 1024 * 1024); // 50MB initial swap -> delta is 100_000_000 - 52_428_800 = 47_571_200
  assert.equal(snapshot.safeToLaunchMore, true);
  assert.equal(snapshot.emergencyPressure, false);
  assert.equal(snapshot.memoryUsedFraction, 3 / 8);
  assert.equal(snapshot.swapDeltaBytes, 47571200);
});

test("resourceMonitor: memory used fraction too high (unsafe to launch)", (t) => {
  const config = {
    largeStepMaxWorkerMemoryFraction: 0.75,
    largeStepMinFreeMemoryMb: 900,
    largeStepMaxSwapGrowthMb: 512,
    largeStepEmergencyMemoryFraction: 0.92
  };

  t.mock.method(fs, "existsSync", (p: string) => true);
  t.mock.method(fs, "readFileSync", (p: string) => {
    if (p.includes("memory.current")) return "6500000000"; // 6.5GB / 8GB = 0.8125
    if (p.includes("memory.max")) return "8000000000";
    if (p.includes("memory.swap.current")) return "0";
    return "0";
  });

  const snapshot = getResourceSnapshot(config, 0);
  assert.equal(snapshot.safeToLaunchMore, false);
  assert.equal(snapshot.emergencyPressure, false);
});

test("resourceMonitor: emergency memory pressure", (t) => {
  const config = {
    largeStepMaxWorkerMemoryFraction: 0.75,
    largeStepMinFreeMemoryMb: 900,
    largeStepMaxSwapGrowthMb: 512,
    largeStepEmergencyMemoryFraction: 0.92
  };

  t.mock.method(fs, "existsSync", (p: string) => true);
  t.mock.method(fs, "readFileSync", (p: string) => {
    if (p.includes("memory.current")) return "7500000000"; // 7.5GB / 8GB = 0.9375
    if (p.includes("memory.max")) return "8000000000";
    if (p.includes("memory.swap.current")) return "0";
    return "0";
  });

  const snapshot = getResourceSnapshot(config, 0);
  assert.equal(snapshot.safeToLaunchMore, false);
  assert.equal(snapshot.emergencyPressure, true);
});

// ----------------------------------------------------
// 4. Adaptive Scheduler Integration Tests
// ----------------------------------------------------
test("converterProcessor: adaptive scheduler loops and completes chunking", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelbase-adaptive-"));
  const spawnMock = t.mock.method(child_process, "spawn");

  // Mock cgroup reads to simulate safe memory conditions
  t.mock.method(fs, "existsSync", (p: string) => true);
  t.mock.method(fs, "readFileSync", (p: string) => {
    if (p.includes("memory.current")) return "2000000000"; // 2GB
    if (p.includes("memory.max")) return "8000000000"; // 8GB
    if (p.includes("memory.swap.current")) return "0";
    return "0";
  });

  try {
    const { xcafConverterBin } = await setupTestDir(dir);
    const sourcePath = path.join(dir, "large_model.step");
    await fs.promises.writeFile(sourcePath, "dummy complex STEP content");

    const plannerPlan = {
      model_summary: {
        total_leaf_shape_count: 5000,
        total_face_count: 100000,
        naive_complexity_score: 40000,
        total_solid_count: 1000,
        free_shape_count: 1
      },
      chunking_recommendation: {
        chunking_enabled: true,
        target_chunks: 3
      },
      chunks: [
        { chunk_index: 0, name: "chunk_0", root_label_paths: ["/0/1"], leaf_count: 2000, face_count: 40000, naive_work_score: 15000 },
        { chunk_index: 1, name: "chunk_1", root_label_paths: ["/0/2"], leaf_count: 2000, face_count: 40000, naive_work_score: 15000 },
        { chunk_index: 2, name: "chunk_2", root_label_paths: ["/0/3"], leaf_count: 1000, face_count: 20000, naive_work_score: 10000 }
      ]
    };

    const xcafReport = {
      openCascadeVersion: "7.8.0",
      summary: { triangles: 10, nodeCount: 5, meshesPrimitivesExported: 1, primitiveCount: 1, materialCount: 1 },
      quality: { preset: "balanced" }
    };

    spawnMock.mock.mockImplementation((cmd: any, args: any) => {
      const child = new MockChildProcess();
      // args[1] represents target directory
      const outDir = args[1] || dir;

      process.nextTick(async () => {
        if (cmd.includes("xcaf-step-planner")) {
          fs.mkdirSync(outDir, { recursive: true });
          fs.writeFileSync(path.join(outDir, "large-model-plan.json"), JSON.stringify(plannerPlan));
        } else {
          // Normal converter chunk run
          const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
          const glbPath = path.join(outDir, "display.glb");
          fs.mkdirSync(outDir, { recursive: true });
          await io.write(glbPath, createChunkFixture(args.includes("chunk-0") ? "c0" : "c1"));
          fs.writeFileSync(path.join(outDir, "xcaf-report.json"), JSON.stringify(xcafReport));
          const chunkIndex = Number(outDir.match(/chunk-(\d+)$/)?.[1] ?? 0);
          fs.writeFileSync(path.join(outDir, "mesh-report.json"), JSON.stringify({
            schemaVersion: 1,
            converterBackend: "xcaf-baseline",
            quality: {
              adaptiveEnabled: true,
              adaptiveMode: "large_sparse_smoothing",
              adaptiveProfile: "strong",
              adaptiveBoundsSource: "finite_leaf_fallback",
              adaptiveBoundsFallbackUsed: true,
              adaptiveDisabledReason: null,
              adaptiveAppliedPartCount: chunkIndex + 1,
              adaptiveFallbackPartCount: 0
            },
            assemblyBoundingBox: { min: [0, 0, 0], max: [10, 10, 10], diagonal: 17.32 },
            totals: {},
            parts: [],
            rankings: {},
            warnings: []
          }));
        }
        child.emit("exit", 0);
      });
      return child as any;
    });

    const result = await convertStepJob({
      slug: "test-adaptive-model",
      sourcePath,
      outputDir: dir,
      converterBackend: "xcaf-baseline",
      converterCli: "cli.js",
      xcafConverterBin,
      xcafColourMode: "xcaf-baseline",
      quality: "medium",
      glbOptimizationMode: "disabled",
      largeStepChunkingMode: "auto",
      largeStepChunkConcurrencyMode: "adaptive",
      largeStepAutoMinFileSizeMb: 0, // ensure it evaluates it as large step
      largeStepAutoPlannerFileSizeMb: 0,
      largeStepInitialConcurrentChunks: 2,
      largeStepMaxConcurrentChunks: 3,
      largeStepScaleUpWarmupSeconds: 0,
      largeStepScaleUpCooldownSeconds: 0,
      largeStepResourcePollSeconds: 1
    });

    assert.ok(result.displayGlbPath);
    // Should have 1 planner call + 3 chunk calls
    assert.equal(spawnMock.mock.calls.length, 4);

    const stats = JSON.parse(await fs.promises.readFile(result.statsPath, "utf8"));
    const chunking = stats.largeStepChunking;
    assert.equal(chunking.mode, "auto");
    assert.equal(chunking.status, "applied");
    assert.equal(chunking.adaptiveConcurrency.enabled, true);
    assert.equal(chunking.adaptiveConcurrency.initial, 2);
    assert.equal(chunking.adaptiveConcurrency.maxConfigured, 3);
    assert.ok(chunking.adaptiveConcurrency.maxReached >= 2);
    assert.ok(chunking.adaptiveConcurrency.snapshots.length > 0);
    const meshReport = JSON.parse(await fs.promises.readFile(result.meshReportPath!, "utf8"));
    assert.equal(meshReport.quality.adaptiveBoundsSource, "finite_leaf_fallback");
    assert.equal(meshReport.quality.adaptiveBoundsFallbackUsed, true);
    assert.equal(meshReport.quality.adaptiveDisabledReason, null);
    assert.equal(meshReport.quality.adaptiveAppliedPartCount, 6);
    assert.equal(meshReport.quality.adaptiveFallbackPartCount, 0);
    assert.deepEqual(meshReport.assemblyBoundingBox.min, [0, 0, 0]);
    assert.deepEqual(meshReport.assemblyBoundingBox.max, [10, 10, 10]);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------
// 5. Adaptive Scheduler Safety & Headroom Tests
// ----------------------------------------------------
test("adaptive scheduler: initial concurrency cap and warmup delay", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "scheduler-test-"));
  const spawnMock = t.mock.method(child_process, "spawn");

  // Mock cgroup reads to simulate safe memory conditions
  t.mock.method(fs, "existsSync", (p: string) => true);
  t.mock.method(fs, "readFileSync", (p: string) => {
    if (p.includes("memory.current")) return "2000000000"; // 2GB
    if (p.includes("memory.max")) return "16000000000"; // 16GB
    if (p.includes("memory.swap.current")) return "0";
    return "0";
  });

  try {
    const { xcafConverterBin } = await setupTestDir(dir);
    const sourcePath = path.join(dir, "large_model.step");
    await fs.promises.writeFile(sourcePath, "dummy complex STEP content");

    const plannerPlan = {
      model_summary: { total_leaf_shape_count: 5000, total_face_count: 100000, naive_complexity_score: 40000, total_solid_count: 1000, free_shape_count: 1 },
      chunking_recommendation: { chunking_enabled: true, target_chunks: 3 },
      chunks: [
        { chunk_index: 0, name: "chunk_0", root_label_paths: ["/0/1"], leaf_count: 2000, face_count: 40000, naive_work_score: 15000 },
        { chunk_index: 1, name: "chunk_1", root_label_paths: ["/0/2"], leaf_count: 2000, face_count: 40000, naive_work_score: 15000 },
        { chunk_index: 2, name: "chunk_2", root_label_paths: ["/0/3"], leaf_count: 1000, face_count: 20000, naive_work_score: 10000 }
      ]
    };

    const xcafReport = {
      openCascadeVersion: "7.8.0",
      summary: { triangles: 10, nodeCount: 5, meshesPrimitivesExported: 1, primitiveCount: 1, materialCount: 1 },
      quality: { preset: "balanced" }
    };

    // We control when chunk exits using promise resolver
    const activeResolvers: (() => void)[] = [];

    spawnMock.mock.mockImplementation((cmd: any, args: any) => {
      const child = new MockChildProcess();
      const outDir = args[1] || dir;

      if (cmd.includes("xcaf-step-planner")) {
        process.nextTick(() => {
          fs.mkdirSync(outDir, { recursive: true });
          fs.writeFileSync(path.join(outDir, "large-model-plan.json"), JSON.stringify(plannerPlan));
          child.emit("exit", 0);
        });
      } else {
        activeResolvers.push(() => {
          const run = async () => {
            const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
            const glbPath = path.join(outDir, "display.glb");
            fs.mkdirSync(outDir, { recursive: true });
            await io.write(glbPath, createChunkFixture("c"));
            fs.writeFileSync(path.join(outDir, "xcaf-report.json"), JSON.stringify(xcafReport));
            child.emit("exit", 0);
          };
          run();
        });
      }
      return child as any;
    });

    const jobPromise = convertStepJob({
      slug: "test-warmup-model",
      sourcePath,
      outputDir: dir,
      converterBackend: "xcaf-baseline",
      converterCli: "cli.js",
      xcafConverterBin,
      xcafColourMode: "xcaf-baseline",
      quality: "medium",
      glbOptimizationMode: "disabled",
      largeStepChunkingMode: "auto",
      largeStepChunkConcurrencyMode: "adaptive",
      largeStepAutoMinFileSizeMb: 0,
      largeStepAutoPlannerFileSizeMb: 0,
      largeStepInitialConcurrentChunks: 2,
      largeStepMaxConcurrentChunks: 3,
      largeStepScaleUpWarmupSeconds: 100, // Large warmup delay to ensure it doesn't scale up
      largeStepResourcePollSeconds: 1
    });

    // Wait a short moment to let initial chunks start
    await new Promise((r) => setTimeout(r, 100));

    // Verify initial cap: only 2 chunks launched initially, not 3
    assert.equal(spawnMock.mock.calls.length, 3);
    assert.equal(activeResolvers.length, 2);

    // Let the first chunk complete
    activeResolvers[0]();
    await new Promise((r) => setTimeout(r, 100));

    // Warmup is still active (100 seconds), but activeCount went from 2 to 1.
    // The scheduler can launch chunk 2 because launching it makes activeCount = 2,
    // which does not exceed the initial cap of 2. So it is not a scale-up.
    assert.equal(activeResolvers.length, 3);

    // Let other chunks complete to finish the job
    activeResolvers[1]();
    activeResolvers[2]();

    const result = await jobPromise;
    assert.ok(result.displayGlbPath);

    const stats = JSON.parse(await fs.promises.readFile(result.statsPath, "utf8"));
    const chunking = stats.largeStepChunking;
    const decisions = chunking.adaptiveConcurrency.decisions;
    assert.ok(decisions.length > 0);
    const warmupBlocked = decisions.find((d: any) => d.reasons.includes("warmup_not_elapsed"));
    assert.ok(warmupBlocked);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("adaptive scheduler: memory reserve headroom check", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "reserve-test-"));
  const spawnMock = t.mock.method(child_process, "spawn");

  // We want to test two different memory levels
  let currentMem = "2000000000"; // 2GB (leaving 14GB free)
  t.mock.method(fs, "existsSync", (p: string) => true);
  t.mock.method(fs, "readFileSync", (p: string) => {
    if (p.includes("memory.current")) return currentMem;
    if (p.includes("memory.max")) return "16000000000"; // 16GB
    if (p.includes("memory.swap.current")) return "0";
    return "0";
  });

  try {
    const { xcafConverterBin } = await setupTestDir(dir);
    const sourcePath = path.join(dir, "large_model.step");
    await fs.promises.writeFile(sourcePath, "dummy complex STEP content");

    const plannerPlan = {
      model_summary: { total_leaf_shape_count: 5000, total_face_count: 100000, naive_complexity_score: 40000, total_solid_count: 1000, free_shape_count: 1 },
      chunking_recommendation: { chunking_enabled: true, target_chunks: 3 },
      chunks: [
        { chunk_index: 0, name: "chunk_0", root_label_paths: ["/0/1"], leaf_count: 2000, face_count: 40000, naive_work_score: 15000 },
        { chunk_index: 1, name: "chunk_1", root_label_paths: ["/0/2"], leaf_count: 2000, face_count: 40000, naive_work_score: 15000 },
        { chunk_index: 2, name: "chunk_2", root_label_paths: ["/0/3"], leaf_count: 1000, face_count: 20000, naive_work_score: 10000 }
      ]
    };

    const xcafReport = {
      openCascadeVersion: "7.8.0",
      summary: { triangles: 10, nodeCount: 5, meshesPrimitivesExported: 1, primitiveCount: 1, materialCount: 1 },
      quality: { preset: "balanced" }
    };

    const activeResolvers: (() => void)[] = [];
    spawnMock.mock.mockImplementation((cmd: any, args: any) => {
      const child = new MockChildProcess();
      const outDir = args[1] || dir;

      if (cmd.includes("xcaf-step-planner")) {
        process.nextTick(() => {
          fs.mkdirSync(outDir, { recursive: true });
          fs.writeFileSync(path.join(outDir, "large-model-plan.json"), JSON.stringify(plannerPlan));
          child.emit("exit", 0);
        });
      } else {
        activeResolvers.push(() => {
          const run = async () => {
            const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
            const glbPath = path.join(outDir, "display.glb");
            fs.mkdirSync(outDir, { recursive: true });
            await io.write(glbPath, createChunkFixture("c"));
            fs.writeFileSync(path.join(outDir, "xcaf-report.json"), JSON.stringify(xcafReport));
            child.emit("exit", 0);
          };
          run();
        });
      }
      return child as any;
    });

    // Run first with unsafe memory (high memory usage -> low free memory)
    currentMem = "14000000000"; // 14GB used, leaving only 2GB free.

    const jobPromise1 = convertStepJob({
      slug: "test-reserve-fail",
      sourcePath,
      outputDir: dir,
      converterBackend: "xcaf-baseline",
      converterCli: "cli.js",
      xcafConverterBin,
      xcafColourMode: "xcaf-baseline",
      quality: "medium",
      glbOptimizationMode: "disabled",
      largeStepChunkingMode: "auto",
      largeStepChunkConcurrencyMode: "adaptive",
      largeStepAutoMinFileSizeMb: 0,
      largeStepAutoPlannerFileSizeMb: 0,
      largeStepInitialConcurrentChunks: 2,
      largeStepMaxConcurrentChunks: 3,
      largeStepScaleUpWarmupSeconds: 0, // no warmup delay
      largeStepScaleUpCooldownSeconds: 0, // no cooldown delay
      largeStepEstimatedChunkMemoryMb: 2600,
      largeStepScaleUpMinFreeAfterReserveMb: 900,
      largeStepMaxWorkerMemoryFraction: 0.95, // bypass memory fraction check
      largeStepResourcePollSeconds: 1
    });

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(activeResolvers.length, 2);

    // Let them finish
    activeResolvers[0]();
    activeResolvers[1]();

    let attempts = 0;
    while (activeResolvers.length < 3 && attempts < 50) {
      await new Promise((r) => setTimeout(r, 50));
      attempts++;
    }
    if (activeResolvers[2]) {
      activeResolvers[2]();
    }
    const res1 = await jobPromise1;

    // Check that reserve blocked was logged in manifest
    const chunking1 = JSON.parse(await fs.promises.readFile(res1.statsPath, "utf8")).largeStepChunking;
    const blockedDec = chunking1.adaptiveConcurrency.decisions.find((d: any) => d.reasons.includes("not_enough_free_after_chunk_reserve"));
    assert.ok(blockedDec);

    // Now run with safe memory (low memory usage -> high free memory)
    currentMem = "2000000000"; // 2GB used -> 14GB free.
    activeResolvers.length = 0;
    spawnMock.mock.resetCalls();

    const jobPromise2 = convertStepJob({
      slug: "test-reserve-pass",
      sourcePath,
      outputDir: dir,
      converterBackend: "xcaf-baseline",
      converterCli: "cli.js",
      xcafConverterBin,
      xcafColourMode: "xcaf-baseline",
      quality: "medium",
      glbOptimizationMode: "disabled",
      largeStepChunkingMode: "auto",
      largeStepChunkConcurrencyMode: "adaptive",
      largeStepAutoMinFileSizeMb: 0,
      largeStepAutoPlannerFileSizeMb: 0,
      largeStepInitialConcurrentChunks: 2,
      largeStepMaxConcurrentChunks: 3,
      largeStepScaleUpWarmupSeconds: 0,
      largeStepScaleUpCooldownSeconds: 0,
      largeStepEstimatedChunkMemoryMb: 2600,
      largeStepScaleUpMinFreeAfterReserveMb: 900,
      largeStepResourcePollSeconds: 1
    });

    await new Promise((r) => setTimeout(r, 100));
    // All 3 chunks should launch immediately
    assert.equal(activeResolvers.length, 3);

    activeResolvers[0]();
    activeResolvers[1]();
    activeResolvers[2]();
    await jobPromise2;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("adaptive scheduler: memory-based cap", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "memcap-test-"));
  const spawnMock = t.mock.method(child_process, "spawn");

  let totalMem = "8000000000"; // 8GB by default
  t.mock.method(fs, "existsSync", (p: string) => true);
  t.mock.method(fs, "readFileSync", (p: string) => {
    if (p.includes("memory.current")) return "2000000000";
    if (p.includes("memory.max")) return totalMem;
    if (p.includes("memory.swap.current")) return "0";
    return "0";
  });

  try {
    const { xcafConverterBin } = await setupTestDir(dir);
    const sourcePath = path.join(dir, "large_model.step");
    await fs.promises.writeFile(sourcePath, "dummy complex STEP content");

    const plannerPlan = {
      model_summary: { total_leaf_shape_count: 5000, total_face_count: 100000, naive_complexity_score: 40000, total_solid_count: 1000, free_shape_count: 1 },
      chunking_recommendation: { chunking_enabled: true, target_chunks: 3 },
      chunks: [
        { chunk_index: 0, name: "chunk_0", root_label_paths: ["/0/1"], leaf_count: 2000, face_count: 40000, naive_work_score: 15000 },
        { chunk_index: 1, name: "chunk_1", root_label_paths: ["/0/2"], leaf_count: 2000, face_count: 40000, naive_work_score: 15000 },
        { chunk_index: 2, name: "chunk_2", root_label_paths: ["/0/3"], leaf_count: 1000, face_count: 20000, naive_work_score: 10000 }
      ]
    };

    const xcafReport = {
      openCascadeVersion: "7.8.0",
      summary: { triangles: 10, nodeCount: 5, meshesPrimitivesExported: 1, primitiveCount: 1, materialCount: 1 },
      quality: { preset: "balanced" }
    };

    const activeResolvers: (() => void)[] = [];
    spawnMock.mock.mockImplementation((cmd: any, args: any) => {
      const child = new MockChildProcess();
      const outDir = args[1] || dir;

      if (cmd.includes("xcaf-step-planner")) {
        process.nextTick(() => {
          fs.mkdirSync(outDir, { recursive: true });
          fs.writeFileSync(path.join(outDir, "large-model-plan.json"), JSON.stringify(plannerPlan));
          child.emit("exit", 0);
        });
      } else {
        activeResolvers.push(() => {
          const run = async () => {
            const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
            const glbPath = path.join(outDir, "display.glb");
            fs.mkdirSync(outDir, { recursive: true });
            await io.write(glbPath, createChunkFixture("c"));
            fs.writeFileSync(path.join(outDir, "xcaf-report.json"), JSON.stringify(xcafReport));
            child.emit("exit", 0);
          };
          run();
        });
      }
      return child as any;
    });

    // 1. Host has 4GB memory (< 6 GiB -> cap = 1)
    totalMem = "4000000000";
    const jobPromise1 = convertStepJob({
      slug: "test-memcap-4gb",
      sourcePath,
      outputDir: dir,
      converterBackend: "xcaf-baseline",
      converterCli: "cli.js",
      xcafConverterBin,
      xcafColourMode: "xcaf-baseline",
      quality: "medium",
      glbOptimizationMode: "disabled",
      largeStepChunkingMode: "auto",
      largeStepChunkConcurrencyMode: "adaptive",
      largeStepAutoMinFileSizeMb: 0,
      largeStepAutoPlannerFileSizeMb: 0,
      largeStepInitialConcurrentChunks: 2,
      largeStepMaxConcurrentChunks: 3,
      largeStepMemoryBasedMaxCapEnabled: true,
      largeStepResourcePollSeconds: 1
    });

    await new Promise((r) => setTimeout(r, 100));
    // Should cap at 1 active chunk even though initial concurrency is 2
    assert.equal(activeResolvers.length, 1);

    activeResolvers[0]();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(activeResolvers.length, 2);
    activeResolvers[1]();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(activeResolvers.length, 3);
    activeResolvers[2]();

    await jobPromise1;

    // 2. Host has 8GB memory (< 10 GiB -> cap = 2)
    totalMem = "8000000000";
    activeResolvers.length = 0;
    spawnMock.mock.resetCalls();

    const jobPromise2 = convertStepJob({
      slug: "test-memcap-8gb",
      sourcePath,
      outputDir: dir,
      converterBackend: "xcaf-baseline",
      converterCli: "cli.js",
      xcafConverterBin,
      xcafColourMode: "xcaf-baseline",
      quality: "medium",
      glbOptimizationMode: "disabled",
      largeStepChunkingMode: "auto",
      largeStepChunkConcurrencyMode: "adaptive",
      largeStepAutoMinFileSizeMb: 0,
      largeStepAutoPlannerFileSizeMb: 0,
      largeStepInitialConcurrentChunks: 2,
      largeStepMaxConcurrentChunks: 3,
      largeStepScaleUpWarmupSeconds: 0, // no warmup delay
      largeStepScaleUpCooldownSeconds: 0,
      largeStepMemoryBasedMaxCapEnabled: true,
      largeStepResourcePollSeconds: 1
    });

    await new Promise((r) => setTimeout(r, 100));
    // Should cap at 2 active chunks even though max concurrency is 3 and warmup is 0
    assert.equal(activeResolvers.length, 2);

    activeResolvers[0]();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(activeResolvers.length, 3);
    activeResolvers[1]();
    activeResolvers[2]();

    const res2 = await jobPromise2;
    const chunking2 = JSON.parse(await fs.promises.readFile(res2.statsPath, "utf8")).largeStepChunking;
    const capBlocked = chunking2.adaptiveConcurrency.decisions.find((d: any) => d.reasons.includes("memory_based_cap"));
    assert.ok(capBlocked);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("adaptive scheduler: cooldown delay", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cooldown-test-"));
  const spawnMock = t.mock.method(child_process, "spawn");

  t.mock.method(fs, "existsSync", (p: string) => true);
  t.mock.method(fs, "readFileSync", (p: string) => {
    if (p.includes("memory.current")) return "2000000000";
    if (p.includes("memory.max")) return "16000000000";
    if (p.includes("memory.swap.current")) return "0";
    return "0";
  });

  try {
    const { xcafConverterBin } = await setupTestDir(dir);
    const sourcePath = path.join(dir, "large_model.step");
    await fs.promises.writeFile(sourcePath, "dummy complex STEP content");

    const plannerPlan = {
      model_summary: { total_leaf_shape_count: 5000, total_face_count: 100000, naive_complexity_score: 40000, total_solid_count: 1000, free_shape_count: 1 },
      chunking_recommendation: { chunking_enabled: true, target_chunks: 3 },
      chunks: [
        { chunk_index: 0, name: "chunk_0", root_label_paths: ["/0/1"], leaf_count: 2000, face_count: 40000, naive_work_score: 15000 },
        { chunk_index: 1, name: "chunk_1", root_label_paths: ["/0/2"], leaf_count: 2000, face_count: 40000, naive_work_score: 15000 },
        { chunk_index: 2, name: "chunk_2", root_label_paths: ["/0/3"], leaf_count: 1000, face_count: 20000, naive_work_score: 10000 }
      ]
    };

    const xcafReport = {
      openCascadeVersion: "7.8.0",
      summary: { triangles: 10, nodeCount: 5, meshesPrimitivesExported: 1, primitiveCount: 1, materialCount: 1 },
      quality: { preset: "balanced" }
    };

    const activeResolvers: (() => void)[] = [];
    spawnMock.mock.mockImplementation((cmd: any, args: any) => {
      const child = new MockChildProcess();
      const outDir = args[1] || dir;

      if (cmd.includes("xcaf-step-planner")) {
        process.nextTick(() => {
          fs.mkdirSync(outDir, { recursive: true });
          fs.writeFileSync(path.join(outDir, "large-model-plan.json"), JSON.stringify(plannerPlan));
          child.emit("exit", 0);
        });
      } else {
        activeResolvers.push(() => {
          const run = async () => {
            const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
            const glbPath = path.join(outDir, "display.glb");
            fs.mkdirSync(outDir, { recursive: true });
            await io.write(glbPath, createChunkFixture("c"));
            fs.writeFileSync(path.join(outDir, "xcaf-report.json"), JSON.stringify(xcafReport));
            child.emit("exit", 0);
          };
          run();
        });
      }
      return child as any;
    });

    const jobPromise = convertStepJob({
      slug: "test-cooldown",
      sourcePath,
      outputDir: dir,
      converterBackend: "xcaf-baseline",
      converterCli: "cli.js",
      xcafConverterBin,
      xcafColourMode: "xcaf-baseline",
      quality: "medium",
      glbOptimizationMode: "disabled",
      largeStepChunkingMode: "auto",
      largeStepChunkConcurrencyMode: "adaptive",
      largeStepAutoMinFileSizeMb: 0,
      largeStepAutoPlannerFileSizeMb: 0,
      largeStepInitialConcurrentChunks: 1,
      largeStepMaxConcurrentChunks: 3,
      largeStepScaleUpWarmupSeconds: 0,
      largeStepScaleUpCooldownSeconds: 100, // large cooldown delay
      largeStepResourcePollSeconds: 1
    });

    await new Promise((r) => setTimeout(r, 100));
    // Should start chunk 0 immediately. Then try to scale up to chunk 1 immediately (warmup=0).
    // Chunk 1 will start, setting lastScaleUpTime.
    // Chunk 2 will check cooldown (100) and block.
    // So activeResolvers length should be 2.
    assert.equal(activeResolvers.length, 2);

    // Let them finish
    activeResolvers[0]();
    activeResolvers[1]();

    let attempts = 0;
    while (activeResolvers.length < 3 && attempts < 50) {
      await new Promise((r) => setTimeout(r, 50));
      attempts++;
    }
    assert.equal(activeResolvers.length, 3);
    activeResolvers[2]();

    const res = await jobPromise;
    const chunking = JSON.parse(await fs.promises.readFile(res.statsPath, "utf8")).largeStepChunking;
    const cooldownBlocked = chunking.adaptiveConcurrency.decisions.find((d: any) => d.reasons.includes("cooldown_not_elapsed"));
    assert.ok(cooldownBlocked);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
