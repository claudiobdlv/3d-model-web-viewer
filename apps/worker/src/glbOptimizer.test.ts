import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
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
    assert.match(await fs.promises.readFile(logPath, "utf8"), /status=applied/);
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
  const node = document.createNode("Fixture node").setMesh(mesh).setExtras({ selectableId: "selectable-1" });
  document.createScene("Fixture scene").addChild(node);
  return document;
}
