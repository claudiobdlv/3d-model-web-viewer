const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { NodeIO } = require('@gltf-transform/core');
const { StatsRecorder } = require('./stats');
const { convertStepToGlb } = require('./convertStepToGlb');
const { validateGlb } = require('./validateGlb');

class TestLogger {
  start(stage, detail) {
    console.log(`[stage:start] ${stage}${detail ? ` - ${detail}` : ''}`);
  }

  end(stage, detail) {
    console.log(`[stage:end] ${stage}${detail ? ` - ${detail}` : ''}`);
  }

  warn(message) {
    console.warn(message);
  }
}

async function runSmoke(inputFile, label) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `converter-${label}-`));
  const glbPath = path.join(outDir, 'display.raw.glb');
  const statsPath = path.join(outDir, 'stats.json');
  const statsRecorder = new StatsRecorder();

  const success = await convertStepToGlb(inputFile, glbPath, 'balanced', statsRecorder, new TestLogger());
  await statsRecorder.save(statsPath);
  assert.strictEqual(success, true, `${label} conversion should succeed`);

  const validation = await validateGlb(glbPath);
  assert.strictEqual(validation.success, true, `${label} GLB should validate`);

  const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
  assert.strictEqual(stats.success, true, `${label} stats should mark success`);
  assert.ok(stats.materialStats, `${label} should include material stats`);
  assert.ok(stats.normalStats, `${label} should include normal stats`);

  return { outDir, glbPath, stats };
}

async function assertFaceColorsSurvive() {
  const inputFile = path.join(__dirname, '..', 'node_modules', 'occt-import-js', 'test', 'testfiles', 'cube-fcstd', 'cube.step');
  const { glbPath, stats } = await runSmoke(inputFile, 'face-colors');
  const document = await new NodeIO().read(glbPath);
  const materials = document.getRoot().listMaterials();
  const primitiveCount = document.getRoot().listMeshes()
    .reduce((count, mesh) => count + mesh.listPrimitives().length, 0);
  const colorKeys = materials.map((material) => material.getBaseColorFactor().slice(0, 3).map((value) => value.toFixed(3)).join(','));

  assert.ok(stats.materialStats.meshesWithFaceColors >= 1, 'face-colour sample should report face colours');
  assert.ok(stats.materialStats.materialSources.face >= 3, 'face-colour sample should create face material runs');
  assert.ok(stats.normalStats.meshesUsingCadFaceNormals >= 1, 'face-colour sample should use CAD face normals');
  assert.ok(stats.normalStats.planarBrepFaces >= 1, 'face-colour sample should detect planar BREP faces');
  assert.ok(primitiveCount >= 4, 'face-colour sample should split material runs into multiple primitives');
  assert.ok(colorKeys.includes('1.000,0.000,0.000'), 'red face material should be present');
  assert.ok(colorKeys.includes('0.000,0.000,1.000'), 'blue face material should be present');
  assert.ok(colorKeys.includes('0.000,0.402,0.000'), 'green face material should be present');
}

async function assertAssemblySmokeStillWorks() {
  const inputFile = path.join(__dirname, '..', 'node_modules', 'occt-import-js', 'test', 'testfiles', 'cax-if', 'dm1-id-214.stp');
  const { stats } = await runSmoke(inputFile, 'assembly');

  assert.ok(stats.meshCount > 0, 'assembly smoke should contain meshes');
  assert.ok(stats.triangleCount > 0, 'assembly smoke should contain triangles');
  assert.ok(stats.materialStats.meshesWithExplicitColor > 0, 'assembly smoke should preserve mesh colours');
}

async function main() {
  await assertFaceColorsSurvive();
  await assertAssemblySmokeStillWorks();
  console.log('Converter smoke tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
