import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import child_process from "node:child_process";
import EventEmitter from "node:events";
import { Readable } from "node:stream";
import { convertStepJob } from "./converterProcessor.js";
import { loadConfig } from "./config.js";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";

// Helper for Mocking ChildProcess
class MockChildProcess extends EventEmitter {
  public stdout: Readable;
  public exitCode: number | null = null;
  public signalCode: string | null = null;
  public killed = false;
  public pid = 12345;
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
    if (signal === "SIGKILL") {
      this.signalCode = "SIGKILL";
    } else {
      this.signalCode = signal;
    }
    process.nextTick(() => {
      this.emit("exit", null, signal);
    });
    return true;
  }
}

// Set up env for default test runs
process.env.WORKER_API_TOKEN = "dummy-token";

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

// Helper to setup dummy paths
async function setupTestDir(dir: string) {
  const xcafConverterBin = path.join(dir, "xcaf-step-to-glb");
  const plannerBin = path.join(dir, "xcaf-step-planner");
  await fs.promises.writeFile(xcafConverterBin, "dummy bin");
  await fs.promises.writeFile(plannerBin, "dummy bin");
  return { xcafConverterBin, plannerBin };
}

test("config parsing and defaults", () => {
  const config = loadConfig([]);
  assert.equal(config.largeStepChunkingMode, "disabled");
  assert.equal(config.largeStepFileSizeThresholdMb, 80);
  assert.equal(config.largeStepLeafCountThreshold, 2000);
  assert.equal(config.largeStepFaceCountThreshold, 50000);
  assert.equal(config.largeStepTargetChunks, 3);
  assert.equal(config.largeStepMaxConcurrentChunks, 3);
  assert.equal(config.largeStepChunkFallbackMode, "fail");
  assert.equal(config.meshiqAdaptiveMesh, "off");
});

test("config validates MeshIQ adaptive mesh mode", () => {
  const previous = process.env.MESHIQ_ADAPTIVE_MESH;
  try {
    process.env.MESHIQ_ADAPTIVE_MESH = "on";
    assert.equal(loadConfig([]).meshiqAdaptiveMesh, "on");
    process.env.MESHIQ_ADAPTIVE_MESH = "maybe";
    assert.throws(() => loadConfig([]), /MESHIQ_ADAPTIVE_MESH must be off or on/);
  } finally {
    if (previous === undefined) {
      delete process.env.MESHIQ_ADAPTIVE_MESH;
    } else {
      process.env.MESHIQ_ADAPTIVE_MESH = previous;
    }
  }
});

test("disabled mode does not run planner/chunks", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelbase-chunk-disabled-"));
  const spawnMock = t.mock.method(child_process, "spawn");
  
  try {
    const { xcafConverterBin } = await setupTestDir(dir);
    const sourcePath = path.join(dir, "model.step");
    await fs.promises.writeFile(sourcePath, "dummy step content");
    
    const xcafReport = {
      openCascadeVersion: "7.8.0",
      summary: { triangles: 10, nodeCount: 5, meshesPrimitivesExported: 1, primitiveCount: 1, materialCount: 1 },
      quality: { preset: "balanced" }
    };
    const meshReport = {
      schemaVersion: 1,
      converterBackend: "xcaf-baseline",
      sourceFileName: "model.step",
      quality: {
        semantic: "medium",
        nativePreset: "balanced",
        adaptiveEnabled: false,
        simplificationEnabled: false,
        baseLinearDeflection: 0.45,
        baseAngularDeflection: 0.5,
        relative: true,
        parallelMesh: true
      },
      assemblyBoundingBox: { min: [0, 0, 0], max: [1, 1, 1], diagonal: 1.732 },
      totals: {
        trianglesBeforeSimplification: 10,
        trianglesAfterSimplification: 10,
        verticesBeforeSimplification: 30,
        verticesAfterSimplification: 30,
        primitiveCount: 1,
        partCount: 1,
        meshingTimeMs: 2,
        simplificationTimeMs: 0
      },
      parts: [],
      rankings: { topTinyDenseParts: [], topLargeSparseParts: [], topSlowMeshParts: [] },
      warnings: [],
      recommendations: []
    };
    
    spawnMock.mock.mockImplementation((cmd: any, args: any) => {
      const child = new MockChildProcess();
      const outDir = args[1] || dir;
      process.nextTick(async () => {
        const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
        const glbPath = path.join(outDir, "display.glb");
        fs.mkdirSync(outDir, { recursive: true });
        await io.write(glbPath, createChunkFixture("normal"));
        fs.writeFileSync(path.join(outDir, "xcaf-report.json"), JSON.stringify(xcafReport));
        fs.writeFileSync(path.join(outDir, "mesh-report.json"), JSON.stringify(meshReport));
        fs.writeFileSync(path.join(outDir, "conversion.log"), "normal conversion log");
        child.emit("exit", 0);
      });
      return child as any;
    });

    const result = await convertStepJob({
      slug: "test-model",
      sourcePath,
      outputDir: dir,
      converterBackend: "xcaf-baseline",
      converterCli: "cli.js",
      xcafConverterBin,
      xcafColourMode: "xcaf-baseline",
      quality: "medium",
      glbOptimizationMode: "disabled",
      largeStepChunkingMode: "disabled"
    });

    assert.ok(result.displayGlbPath);
    assert.equal(result.meshReportPath, path.join(dir, "test-model", "mesh-report.json"));
    const writtenMeshReport = JSON.parse(await fs.promises.readFile(result.meshReportPath!, "utf8"));
    assert.equal(writtenMeshReport.schemaVersion, 1);
    assert.equal(writtenMeshReport.converterBackend, "xcaf-baseline");
    assert.equal(writtenMeshReport.quality.adaptiveEnabled, false);
    assert.equal(writtenMeshReport.quality.simplificationEnabled, false);
    const calls = spawnMock.mock.calls;
    assert.equal(calls.length, 1);
    assert.ok(!calls[0]!.arguments[0].includes("xcaf-step-planner"));
    assert.ok(!calls[0]!.arguments[1].includes("--adaptive-mesh"));
    
    const manifest = JSON.parse(await fs.promises.readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.largeStepChunking.mode, "disabled");
    assert.equal(manifest.largeStepChunking.status, "disabled");
    assert.equal(manifest.artifacts.meshReport, "mesh-report.json");
    assert.equal(manifest.adaptiveMesh.enabled, false);
    assert.equal(manifest.adaptiveMesh.mode, "off");
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("MESHIQ_ADAPTIVE_MESH=on passes native adaptive mesh flag", async (t) => {
  const previous = process.env.MESHIQ_ADAPTIVE_MESH;
  process.env.MESHIQ_ADAPTIVE_MESH = "on";
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelbase-adaptive-mesh-on-"));
  const spawnMock = t.mock.method(child_process, "spawn");

  try {
    const { xcafConverterBin } = await setupTestDir(dir);
    const sourcePath = path.join(dir, "model.step");
    await fs.promises.writeFile(sourcePath, "dummy step content");

    spawnMock.mock.mockImplementation((cmd: any, args: any) => {
      const child = new MockChildProcess();
      const outDir = args[1] || dir;
      process.nextTick(async () => {
        const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
        fs.mkdirSync(outDir, { recursive: true });
        await io.write(path.join(outDir, "display.glb"), createChunkFixture("adaptive-on"));
        fs.writeFileSync(path.join(outDir, "xcaf-report.json"), JSON.stringify({
          openCascadeVersion: "7.8.0",
          summary: { triangles: 10, nodeCount: 5, meshesPrimitivesExported: 1, primitiveCount: 1, materialCount: 1 },
          quality: { preset: "balanced", adaptiveEnabled: true, adaptiveMode: "large_sparse_smoothing" }
        }));
        fs.writeFileSync(path.join(outDir, "mesh-report.json"), JSON.stringify({
          schemaVersion: 1,
          converterBackend: "xcaf-baseline",
          quality: { adaptiveEnabled: true, adaptiveMode: "large_sparse_smoothing" },
          totals: {},
          parts: [],
          rankings: {},
          warnings: ["large_sparse_smoothed"]
        }));
        fs.writeFileSync(path.join(outDir, "conversion.log"), "normal conversion log");
        child.emit("exit", 0);
      });
      return child as any;
    });

    const result = await convertStepJob({
      slug: "test-adaptive-on",
      sourcePath,
      outputDir: dir,
      converterBackend: "xcaf-baseline",
      converterCli: "cli.js",
      xcafConverterBin,
      xcafColourMode: "xcaf-baseline",
      quality: "medium",
      glbOptimizationMode: "disabled",
      largeStepChunkingMode: "disabled"
    });

    const args = spawnMock.mock.calls[0]!.arguments[1];
    assert.deepEqual(args.slice(args.indexOf("--adaptive-mesh"), args.indexOf("--adaptive-mesh") + 2), ["--adaptive-mesh", "on"]);
    const manifest = JSON.parse(await fs.promises.readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.adaptiveMesh.enabled, true);
    assert.equal(manifest.adaptiveMesh.mode, "large_sparse_smoothing");
  } finally {
    if (previous === undefined) {
      delete process.env.MESHIQ_ADAPTIVE_MESH;
    } else {
      process.env.MESHIQ_ADAPTIVE_MESH = previous;
    }
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("non-STEP does not run chunking", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelbase-chunk-nonstep-"));
  const spawnMock = t.mock.method(child_process, "spawn");
  
  try {
    const { xcafConverterBin } = await setupTestDir(dir);
    const sourcePath = path.join(dir, "model.glb");
    await fs.promises.writeFile(sourcePath, "dummy glb content");

    spawnMock.mock.mockImplementation((cmd: any, args: any) => {
      const child = new MockChildProcess();
      let outDir = dir;
      if (args && args.includes("--outdir")) {
        outDir = args[args.indexOf("--outdir") + 1] || dir;
      } else if (args && args[1] && !args[1].startsWith("-")) {
        outDir = args[1];
      }
      process.nextTick(() => {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, "display.raw.glb"), "dummy glb");
        fs.writeFileSync(path.join(outDir, "material-debug.json"), "{}");
        fs.writeFileSync(path.join(outDir, "stats.json"), "{}");
        fs.writeFileSync(path.join(outDir, "conversion.log"), "normal log");
        child.emit("exit", 0);
      });
      return child as any;
    });

    const result = await convertStepJob({
      slug: "test-model",
      sourcePath,
      outputDir: dir,
      converterBackend: "occt-js",
      converterCli: "cli.js",
      xcafConverterBin,
      xcafColourMode: "xcaf-baseline",
      quality: "medium",
      glbOptimizationMode: "disabled",
      largeStepChunkingMode: "direct-filter"
    });

    assert.ok(result.displayGlbPath);
    const calls = spawnMock.mock.calls;
    assert.equal(calls.length, 1);
    
    const manifest = JSON.parse(await fs.promises.readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.largeStepChunking.status, "skipped");
    assert.equal(manifest.largeStepChunking.skipReason, "non-step");
    assert.equal(manifest.artifacts.meshReport, null);
    assert.equal(result.meshReportPath, undefined);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("below threshold does not run chunking", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelbase-chunk-threshold-"));
  const spawnMock = t.mock.method(child_process, "spawn");
  
  try {
    const { xcafConverterBin } = await setupTestDir(dir);
    const sourcePath = path.join(dir, "model.step");
    await fs.promises.writeFile(sourcePath, "small");

    const xcafReport = {
      openCascadeVersion: "7.8.0",
      summary: { triangles: 10, nodeCount: 5, meshesPrimitivesExported: 1, primitiveCount: 1, materialCount: 1 },
      quality: { preset: "balanced" }
    };

    spawnMock.mock.mockImplementation((cmd: any, args: any) => {
      const child = new MockChildProcess();
      const outDir = args[1] || dir;
      process.nextTick(async () => {
        fs.mkdirSync(outDir, { recursive: true });
        const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
        const glbPath = path.join(outDir, "display.glb");
        await io.write(glbPath, createChunkFixture("normal"));
        fs.writeFileSync(path.join(outDir, "xcaf-report.json"), JSON.stringify(xcafReport));
        fs.writeFileSync(path.join(outDir, "conversion.log"), "normal log");
        child.emit("exit", 0);
      });
      return child as any;
    });

    const result = await convertStepJob({
      slug: "test-model",
      sourcePath,
      outputDir: dir,
      converterBackend: "xcaf-baseline",
      converterCli: "cli.js",
      xcafConverterBin,
      xcafColourMode: "xcaf-baseline",
      quality: "medium",
      glbOptimizationMode: "disabled",
      largeStepChunkingMode: "direct-filter",
      largeStepFileSizeThresholdMb: 10
    });

    const manifest = JSON.parse(await fs.promises.readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.largeStepChunking.status, "skipped");
    assert.match(manifest.largeStepChunking.skipReason, /below-auto-min-size/);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("planner failure with fallback fail", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelbase-planner-fail-"));
  const spawnMock = t.mock.method(child_process, "spawn");
  
  try {
    const { xcafConverterBin } = await setupTestDir(dir);
    const sourcePath = path.join(dir, "model.step");
    await fs.promises.writeFile(sourcePath, Buffer.alloc(1024 * 1024 * 2));

    spawnMock.mock.mockImplementation((cmd) => {
      const child = new MockChildProcess();
      process.nextTick(() => {
        if (cmd.includes("xcaf-step-planner")) {
          child.emit("exit", 1); // Planner fails
        } else {
          child.emit("exit", 0);
        }
      });
      return child as any;
    });

    await assert.rejects(
      convertStepJob({
        slug: "test-model",
        sourcePath,
        outputDir: dir,
        converterBackend: "xcaf-baseline",
        converterCli: "cli.js",
        xcafConverterBin,
        xcafColourMode: "xcaf-baseline",
        quality: "medium",
        glbOptimizationMode: "disabled",
        largeStepChunkingMode: "direct-filter",
        largeStepFileSizeThresholdMb: 0,
        largeStepChunkFallbackMode: "fail"
      }),
      /Planner exited with code 1/
    );
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("planner failure with fallback full-conversion", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelbase-planner-fallback-"));
  const spawnMock = t.mock.method(child_process, "spawn");
  
  try {
    const { xcafConverterBin } = await setupTestDir(dir);
    const sourcePath = path.join(dir, "model.step");
    await fs.promises.writeFile(sourcePath, Buffer.alloc(1024 * 1024 * 2));

    const xcafReport = {
      openCascadeVersion: "7.8.0",
      summary: { triangles: 10, nodeCount: 5, meshesPrimitivesExported: 1, primitiveCount: 1, materialCount: 1 },
      quality: { preset: "balanced" }
    };

    spawnMock.mock.mockImplementation((cmd: any, args: any) => {
      const child = new MockChildProcess();
      const outDir = args[1] || dir;
      process.nextTick(async () => {
        if (cmd.includes("xcaf-step-planner")) {
          child.emit("exit", 1); // Planner fails
        } else {
          // Normal converter succeeds
          fs.mkdirSync(outDir, { recursive: true });
          const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
          const glbPath = path.join(outDir, "display.glb");
          await io.write(glbPath, createChunkFixture("normal"));
          fs.writeFileSync(path.join(outDir, "xcaf-report.json"), JSON.stringify(xcafReport));
          fs.writeFileSync(path.join(outDir, "conversion.log"), "normal log");
          child.emit("exit", 0);
        }
      });
      return child as any;
    });

    const result = await convertStepJob({
      slug: "test-model",
      sourcePath,
      outputDir: dir,
      converterBackend: "xcaf-baseline",
      converterCli: "cli.js",
      xcafConverterBin,
      xcafColourMode: "xcaf-baseline",
      quality: "medium",
      glbOptimizationMode: "disabled",
      largeStepChunkingMode: "direct-filter",
      largeStepFileSizeThresholdMb: 0,
      largeStepChunkFallbackMode: "full-conversion"
    });

    assert.ok(result.displayGlbPath);
    const manifest = JSON.parse(await fs.promises.readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.largeStepChunking.status, "fallback-full-conversion");
    assert.match(manifest.largeStepChunking.fallbackReason, /Planner exited with code 1/);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("chunk failure with fallback fail", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelbase-chunk-fail-"));
  const spawnMock = t.mock.method(child_process, "spawn");
  
  try {
    const { xcafConverterBin } = await setupTestDir(dir);
    const sourcePath = path.join(dir, "model.step");
    await fs.promises.writeFile(sourcePath, Buffer.alloc(1024 * 1024 * 2));

    const plan = {
      model_summary: { total_leaf_shape_count: 5000, total_face_count: 100000 },
      chunking_recommendation: { chunking_enabled: true, target_chunks: 2 },
      chunks: [
        { chunk_index: 0, name: "chunk_0", root_label_paths: ["0:1"] },
        { chunk_index: 1, name: "chunk_1", root_label_paths: ["0:2"] }
      ]
    };

    spawnMock.mock.mockImplementation((cmd: any, args: any) => {
      const child = new MockChildProcess();
      const outDir = args[1] || dir;
      process.nextTick(() => {
        fs.mkdirSync(outDir, { recursive: true });
        if (cmd.includes("xcaf-step-planner")) {
          fs.writeFileSync(path.join(outDir, "large-model-plan.json"), JSON.stringify(plan));
          child.stdout.emit("data", Buffer.from("planner output summary"));
          child.emit("exit", 0);
        } else if (cmd.includes("xcaf-step-to-glb")) {
          if (outDir && path.basename(outDir).startsWith("chunk-0")) {
            child.emit("exit", 1); // Chunk 0 fails
          } else {
            child.emit("exit", 0);
          }
        }
      });
      return child as any;
    });

    await assert.rejects(
      convertStepJob({
        slug: "test-model",
        sourcePath,
        outputDir: dir,
        converterBackend: "xcaf-baseline",
        converterCli: "cli.js",
        xcafConverterBin,
        xcafColourMode: "xcaf-baseline",
        quality: "medium",
        glbOptimizationMode: "disabled",
        largeStepChunkingMode: "direct-filter",
        largeStepFileSizeThresholdMb: 0,
        largeStepChunkFallbackMode: "fail"
      }),
      /Chunk 0 exited with code 1/
    );
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("chunk failure with fallback full-conversion", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelbase-chunk-fallback-"));
  const spawnMock = t.mock.method(child_process, "spawn");
  
  try {
    const { xcafConverterBin } = await setupTestDir(dir);
    const sourcePath = path.join(dir, "model.step");
    await fs.promises.writeFile(sourcePath, Buffer.alloc(1024 * 1024 * 2));

    const plan = {
      model_summary: { total_leaf_shape_count: 5000, total_face_count: 100000 },
      chunking_recommendation: { chunking_enabled: true, target_chunks: 2 },
      chunks: [
        { chunk_index: 0, name: "chunk_0", root_label_paths: ["0:1"] },
        { chunk_index: 1, name: "chunk_1", root_label_paths: ["0:2"] }
      ]
    };

    const xcafReport = {
      openCascadeVersion: "7.8.0",
      summary: { triangles: 10, nodeCount: 5, meshesPrimitivesExported: 1, primitiveCount: 1, materialCount: 1 },
      quality: { preset: "balanced" }
    };

    spawnMock.mock.mockImplementation((cmd: any, args: any) => {
      const child = new MockChildProcess();
      const outDir = args[1] || dir;
      process.nextTick(async () => {
        fs.mkdirSync(outDir, { recursive: true });
        if (cmd.includes("xcaf-step-planner")) {
          fs.writeFileSync(path.join(outDir, "large-model-plan.json"), JSON.stringify(plan));
          child.stdout.emit("data", Buffer.from("planner output summary"));
          child.emit("exit", 0);
        } else if (cmd.includes("xcaf-step-to-glb")) {
          if (outDir && path.basename(outDir).startsWith("chunk-")) {
            child.emit("exit", 1); // Chunk conversion fails
          } else {
            // Normal baseline converter succeeds
            const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
            const glbPath = path.join(outDir, "display.glb");
            await io.write(glbPath, createChunkFixture("normal"));
            fs.writeFileSync(path.join(outDir, "xcaf-report.json"), JSON.stringify(xcafReport));
            fs.writeFileSync(path.join(outDir, "conversion.log"), "normal log");
            child.emit("exit", 0);
          }
        }
      });
      return child as any;
    });

    const result = await convertStepJob({
      slug: "test-model",
      sourcePath,
      outputDir: dir,
      converterBackend: "xcaf-baseline",
      converterCli: "cli.js",
      xcafConverterBin,
      xcafColourMode: "xcaf-baseline",
      quality: "medium",
      glbOptimizationMode: "disabled",
      largeStepChunkingMode: "direct-filter",
      largeStepFileSizeThresholdMb: 0,
      largeStepChunkFallbackMode: "full-conversion"
    });

    assert.ok(result.displayGlbPath);
    const manifest = JSON.parse(await fs.promises.readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.largeStepChunking.status, "fallback-full-conversion");
    assert.match(manifest.largeStepChunking.fallbackReason, /Chunk conversion failed/);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("cancellation terminates active chunks with SIGTERM and then SIGKILL", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelbase-chunk-cancel-"));
  const spawnMock = t.mock.method(child_process, "spawn");
  
  try {
    const { xcafConverterBin } = await setupTestDir(dir);
    const sourcePath = path.join(dir, "model.step");
    await fs.promises.writeFile(sourcePath, Buffer.alloc(1024 * 1024 * 2));

    const plan = {
      model_summary: { total_leaf_shape_count: 5000, total_face_count: 100000 },
      chunking_recommendation: { chunking_enabled: true, target_chunks: 2 },
      chunks: [
        { chunk_index: 0, name: "chunk_0", root_label_paths: ["0:1"] },
        { chunk_index: 1, name: "chunk_1", root_label_paths: ["0:2"] }
      ]
    };

    const activeProcesses: MockChildProcess[] = [];

    spawnMock.mock.mockImplementation((cmd: any, args: any) => {
      const child = new MockChildProcess();
      activeProcesses.push(child);
      const outDir = args[1] || dir;
      process.nextTick(() => {
        fs.mkdirSync(outDir, { recursive: true });
        if (cmd.includes("xcaf-step-planner")) {
          fs.writeFileSync(path.join(outDir, "large-model-plan.json"), JSON.stringify(plan));
          child.emit("exit", 0);
        }
      });
      return child as any;
    });

    const controller = new AbortController();

    setTimeout(() => {
      controller.abort();
    }, 100);

    await assert.rejects(
      convertStepJob({
        slug: "test-model",
        sourcePath,
        outputDir: dir,
        converterBackend: "xcaf-baseline",
        converterCli: "cli.js",
        xcafConverterBin,
        xcafColourMode: "xcaf-baseline",
        quality: "medium",
        glbOptimizationMode: "disabled",
        largeStepChunkingMode: "direct-filter",
        largeStepFileSizeThresholdMb: 0,
        signal: controller.signal
      }),
      (err: any) => err.name === "AbortError"
    );

    const killedProcs = activeProcesses.filter(p => p.killed);
    assert.ok(killedProcs.length >= 1);
    assert.equal(killedProcs[0]!.lastSignal, "SIGTERM");

    const rawGlbPath = path.join(dir, "display.raw.glb");
    assert.ok(!fs.existsSync(rawGlbPath), "Should not have merged partial chunks");
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("successful chunking flow completes and publishes", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelbase-chunk-success-"));
  const spawnMock = t.mock.method(child_process, "spawn");

  try {
    const { xcafConverterBin } = await setupTestDir(dir);
    const sourcePath = path.join(dir, "model.step");
    await fs.promises.writeFile(sourcePath, Buffer.alloc(1024 * 1024 * 2));

    const plan = {
      model_summary: { total_leaf_shape_count: 5000, total_face_count: 100000 },
      chunking_recommendation: { chunking_enabled: true, target_chunks: 2 },
      chunks: [
        { chunk_index: 0, name: "chunk_0", root_label_paths: ["0:1"] },
        { chunk_index: 1, name: "chunk_1", root_label_paths: ["0:2"] }
      ]
    };

    const chunkReport = {
      openCascadeVersion: "7.8.0",
      summary: { triangles: 5, nodeCount: 3, meshesPrimitivesExported: 1, primitiveCount: 1, materialCount: 1 },
      quality: { preset: "balanced" },
      globalBoundingBox: { min: [0, 0, 0], max: [1, 1, 1], diagonal: 1.732 }
    };

    spawnMock.mock.mockImplementation((cmd: any, args: any) => {
      const child = new MockChildProcess();
      const outDir = args[1] || dir;
      process.nextTick(async () => {
        fs.mkdirSync(outDir, { recursive: true });
        if (cmd.includes("xcaf-step-planner")) {
          fs.writeFileSync(path.join(outDir, "large-model-plan.json"), JSON.stringify(plan));
          child.stdout.emit("data", Buffer.from("planner output summary"));
          child.emit("exit", 0);
        } else if (cmd.includes("xcaf-step-to-glb")) {
          const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
          const chunkGlbPath = path.join(outDir, "display.glb");
          await io.write(chunkGlbPath, createChunkFixture(`chunk-${args[args.length - 1]}`));
          fs.writeFileSync(path.join(outDir, "xcaf-report.json"), JSON.stringify(chunkReport));
          fs.writeFileSync(path.join(outDir, "conversion.log"), "chunk log");
          child.emit("exit", 0);
        }
      });
      return child as any;
    });

    const result = await convertStepJob({
      slug: "test-model",
      sourcePath,
      outputDir: dir,
      converterBackend: "xcaf-baseline",
      converterCli: "cli.js",
      xcafConverterBin,
      xcafColourMode: "xcaf-baseline",
      quality: "medium",
      glbOptimizationMode: "disabled",
      largeStepChunkingMode: "direct-filter",
      largeStepFileSizeThresholdMb: 0
    });

    assert.equal(result.displayGlbPath, path.join(dir, "test-model", "display.glb"));
    assert.ok(fs.existsSync(result.manifestPath));
    assert.ok(fs.existsSync(result.statsPath));
    assert.ok(fs.existsSync(result.materialDebugPath));

    const manifest = JSON.parse(await fs.promises.readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.largeStepChunking.status, "applied");
    assert.equal(manifest.largeStepChunking.actualChunks, 2);
    assert.equal(manifest.largeStepChunking.chunks[0].triangleCount, 5);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
