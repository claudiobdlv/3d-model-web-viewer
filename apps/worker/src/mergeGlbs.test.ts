import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { mergeGlbs, validateMergedGlb } from "./utils/mergeGlbs.js";

test("GLB merge preserves hierarchy, names, materials, and extras", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelbase-merge-"));
  try {
    const chunk1Path = path.join(dir, "chunk1.glb");
    const chunk2Path = path.join(dir, "chunk2.glb");
    const mergedPath = path.join(dir, "merged.glb");

    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    await io.write(chunk1Path, createChunkFixture("A", [1, 0, 0]));
    await io.write(chunk2Path, createChunkFixture("B", [0, 2, 0]));

    // Perform merge
    const mergeStats = await mergeGlbs([chunk1Path, chunk2Path], mergedPath);

    assert.equal(mergeStats.mergedNodeCount, 2);
    assert.equal(mergeStats.mergedTriangleCount, 2);
    assert.equal(mergeStats.mergedMaterialCount, 2);
    assert.deepEqual(mergeStats.stableObjectIds, ["stable-A", "stable-B"]);
    assert.deepEqual(mergeStats.selectableIds, ["selectable-A", "selectable-B"]);

    // Verify file exists
    assert.ok(fs.existsSync(mergedPath));

    // Read back and check contents
    const mergedDoc = await io.read(mergedPath);
    const scenes = mergedDoc.getRoot().listScenes();
    assert.equal(scenes.length, 1, "Should have exactly one scene");
    const scene = scenes[0]!;
    assert.equal(scene.listChildren().length, 2, "Merged scene should have 2 children nodes");

    const [nodeA, nodeB] = scene.listChildren();
    assert.equal(nodeA!.getName(), "Node-A");
    assert.equal(nodeB!.getName(), "Node-B");

    assert.deepEqual(nodeA!.getTranslation(), [1, 0, 0]);
    assert.deepEqual(nodeB!.getTranslation(), [0, 2, 0]);

    assert.equal(nodeA!.getMesh()!.getExtras().stableObjectId, "stable-A");
    assert.equal(nodeA!.getExtras().selectableId, "selectable-A");

    // Perform validation
    const validationReport = await validateMergedGlb([chunk1Path, chunk2Path], mergedPath);
    assert.equal(validationReport.passed, true, `Validation failed: ${validationReport.errors.join(", ")}`);
    assert.equal(validationReport.metrics.expectedNodes, 2);
    assert.equal(validationReport.metrics.actualNodes, 2);
    assert.equal(validationReport.metrics.expectedTriangles, 2);
    assert.equal(validationReport.metrics.actualTriangles, 2);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

function createChunkFixture(suffix: string, translation: [number, number, number]): Document {
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
    .setExtras({ selectableId: `selectable-${suffix}` })
    .setTranslation(translation);
  document.createScene(`Scene-${suffix}`).addChild(node);
  return document;
}
