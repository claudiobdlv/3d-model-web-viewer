import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import { optimizeDisplayGlb } from "./glbOptimizer.js";

test("meshopt candidate preserves guarded semantics and is applied when smaller", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelbase-meshopt-"));
  try {
    const rawPath = path.join(dir, "display.raw.glb");
    const displayPath = path.join(dir, "display.glb");
    const logPath = path.join(dir, "conversion.log");
    await fs.promises.writeFile(logPath, "test conversion\n");
    await new NodeIO().write(rawPath, createFixture());

    const result = await optimizeDisplayGlb({
      requestedMode: "meshopt",
      rawGlbPath: rawPath,
      displayGlbPath: displayPath,
      conversionLogPath: logPath
    });

    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.equal(result.validation.passed, true);
    assert.equal(result.fallbackUsed, false);
    assert.ok(result.displaySizeBytes < result.rawSizeBytes);
    assert.equal(result.bytesSaved, result.rawSizeBytes - result.displaySizeBytes);
    assert.ok(result.reductionPercent > 0);
    assert.equal(result.compression.used, true);
    assert.equal(result.compression.required, true);
    assert.ok(result.compression.compressedBufferViews > 0);
    assert.equal(result.hashes.rawSha256.length, 64);
    assert.equal(result.hashes.finalSha256.length, 64);
    assert.notEqual(result.hashes.rawSha256, result.hashes.finalSha256);
    assert.ok("gates" in result.validation && result.validation.gates.includes("node child hierarchy"));
    assert.ok("gates" in result.validation && result.validation.gates.includes("node world bounds"));
    await MeshoptDecoder.ready;
    const viewerCompatibleIo = new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
    const loaded = await viewerCompatibleIo.read(displayPath);
    assert.equal(loaded.getRoot().listScenes().length, 1);
    assert.match(await fs.promises.readFile(logPath, "utf8"), /status=applied/);
    assert.match(await fs.promises.readFile(logPath, "utf8"), /finalUsesMeshoptCompression=true/);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("disabled mode publishes raw GLB byte-for-byte", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelbase-disabled-"));
  try {
    const rawPath = path.join(dir, "display.raw.glb");
    const displayPath = path.join(dir, "display.glb");
    const logPath = path.join(dir, "conversion.log");
    await fs.promises.writeFile(rawPath, Buffer.from("raw-glb-fixture"));
    await fs.promises.writeFile(logPath, "test conversion\n");
    const result = await optimizeDisplayGlb({
      requestedMode: "disabled",
      rawGlbPath: rawPath,
      displayGlbPath: displayPath,
      conversionLogPath: logPath
    });
    assert.equal(result.status, "disabled");
    assert.equal(result.compression.used, false);
    assert.equal(result.bytesSaved, 0);
    assert.deepEqual(await fs.promises.readFile(displayPath), await fs.promises.readFile(rawPath));
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("validated candidate that is not smaller publishes raw GLB", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelbase-not-smaller-"));
  try {
    const rawPath = path.join(dir, "display.raw.glb");
    const displayPath = path.join(dir, "display.glb");
    const logPath = path.join(dir, "conversion.log");
    await fs.promises.writeFile(logPath, "test conversion\n");
    await new NodeIO().write(rawPath, createTinyFixture());

    const result = await optimizeDisplayGlb({
      requestedMode: "meshopt",
      rawGlbPath: rawPath,
      displayGlbPath: displayPath,
      conversionLogPath: logPath
    });

    assert.equal(result.status, "skipped-not-smaller", JSON.stringify(result));
    assert.equal(result.validation.passed, true);
    assert.equal(result.fallbackUsed, true);
    assert.match(result.fallbackReason ?? "", /not smaller/);
    assert.equal(result.compression.used, false);
    assert.deepEqual(await fs.promises.readFile(displayPath), await fs.promises.readFile(rawPath));
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("optimizer exception fallback", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelbase-fallback-exception-"));
  try {
    const rawPath = path.join(dir, "display.raw.glb");
    const displayPath = path.join(dir, "display.glb");
    const logPath = path.join(dir, "conversion.log");
    await fs.promises.writeFile(rawPath, Buffer.from("invalid-glb-data"));
    await fs.promises.writeFile(logPath, "test conversion\n");

    const result = await optimizeDisplayGlb({
      requestedMode: "meshopt",
      rawGlbPath: rawPath,
      displayGlbPath: displayPath,
      conversionLogPath: logPath
    });

    assert.equal(result.status, "failed");
    assert.equal(result.fallbackUsed, true);
    assert.deepEqual(await fs.promises.readFile(displayPath), await fs.promises.readFile(rawPath));
    assert.match(await fs.promises.readFile(logPath, "utf8"), /status=failed/);
    assert.match(await fs.promises.readFile(logPath, "utf8"), /fallbackUsed=true/);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test("validation failure fallback", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelbase-fallback-validation-"));
  try {
    const rawPath = path.join(dir, "display.raw.glb");
    const displayPath = path.join(dir, "display.glb");
    const logPath = path.join(dir, "conversion.log");
    await fs.promises.writeFile(logPath, "test conversion\n");
    await new NodeIO().write(rawPath, createFixture());

    const originalReadFile = fs.promises.readFile;
    t.mock.method(fs.promises, "readFile", async (p: any, options: any) => {
      if (typeof p === "string" && p.includes("display.meshopt.glb.tmp")) {
        throw new Error("Simulated validator read failure");
      }
      return originalReadFile(p, options);
    });

    const result = await optimizeDisplayGlb({
      requestedMode: "meshopt",
      rawGlbPath: rawPath,
      displayGlbPath: displayPath,
      conversionLogPath: logPath
    });

    assert.equal(result.status, "failed");
    assert.equal(result.fallbackUsed, true);
    assert.deepEqual(await fs.promises.readFile(displayPath), await fs.promises.readFile(rawPath));
    assert.match(await fs.promises.readFile(logPath, "utf8"), /status=failed/);
    assert.match(await fs.promises.readFile(logPath, "utf8"), /fallbackUsed=true/);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

function createFixture(): Document {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions: number[] = [];
  const indices: number[] = [];
  for (let index = 0; index < 600; index += 1) {
    const offset = index * 3;
    positions.push(index % 10, Math.floor(index / 10) % 10, Math.floor(index / 100));
    indices.push(offset, offset + 1, offset + 2);
    positions.push(index % 10 + 0.5, Math.floor(index / 10) % 10, Math.floor(index / 100));
    positions.push(index % 10, Math.floor(index / 10) % 10 + 0.5, Math.floor(index / 100));
  }
  const position = document.createAccessor("positions").setType("VEC3").setArray(new Float32Array(positions)).setBuffer(buffer);
  const indexAccessor = document.createAccessor("indices").setType("SCALAR").setArray(new Uint32Array(indices)).setBuffer(buffer);
  const material = document.createMaterial("Steel").setBaseColorFactor([0.3, 0.5, 0.7, 1]).setMetallicFactor(0.4).setRoughnessFactor(0.6);
  material.setExtras({ colourSource: "fixture" });
  const primitive = document.createPrimitive().setAttribute("POSITION", position).setIndices(indexAccessor).setMaterial(material);
  primitive.setExtras({ geometryTag: "fixture-geometry" });
  const mesh = document.createMesh("Fixture mesh").addPrimitive(primitive).setExtras({ stableObjectId: "stable-1" });
  const node = document.createNode("Fixture node").setMesh(mesh).setTranslation([1, 2, 3]).setExtras({
    selectableId: "selectable-1",
    labelPath: "Assembly/Fixture"
  });
  const assembly = document.createNode("Fixture assembly").setExtras({ stableObjectId: "assembly-1" }).addChild(node);
  document.createScene("Fixture scene").addChild(assembly);
  return document;
}

function createTinyFixture(): Document {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = document.createAccessor("positions").setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
  const indices = document.createAccessor("indices").setType("SCALAR")
    .setArray(new Uint16Array([0, 1, 2])).setBuffer(buffer);
  const primitive = document.createPrimitive().setAttribute("POSITION", positions).setIndices(indices);
  const mesh = document.createMesh("Tiny mesh").addPrimitive(primitive);
  document.createScene("Tiny scene").addChild(document.createNode("Tiny node").setMesh(mesh));
  return document;
}
