const fs = require('fs');
const { NodeIO, Primitive } = require('@gltf-transform/core');

function countPrimitiveTriangles(primitive) {
  const mode = primitive.getMode();
  const indices = primitive.getIndices();
  const position = primitive.getAttribute('POSITION');
  const vertexCount = position ? position.getCount() : 0;
  const indexCount = indices ? indices.getCount() : vertexCount;

  if (mode === Primitive.Mode.TRIANGLES) {
    return Math.floor(indexCount / 3);
  }

  if (mode === Primitive.Mode.TRIANGLE_STRIP || mode === Primitive.Mode.TRIANGLE_FAN) {
    return Math.max(0, indexCount - 2);
  }

  return 0;
}

async function validateGlb(glbPath) {
  const errors = [];
  const warnings = [];
  let fileSizeBytes = 0;

  if (!fs.existsSync(glbPath)) {
    errors.push(`Output GLB does not exist: ${glbPath}`);
    return {
      success: false,
      fileExists: false,
      fileSizeBytes,
      meshCount: 0,
      primitiveCount: 0,
      nodeCount: 0,
      triangleCount: 0,
      errors,
      warnings
    };
  }

  fileSizeBytes = fs.statSync(glbPath).size;
  if (fileSizeBytes <= 0) {
    errors.push(`Output GLB is empty: ${glbPath}`);
  }

  let document;
  try {
    document = await new NodeIO().read(glbPath);
  } catch (err) {
    errors.push(`GLB readback failed: ${err.message}`);
    return {
      success: false,
      fileExists: true,
      fileSizeBytes,
      meshCount: 0,
      primitiveCount: 0,
      nodeCount: 0,
      triangleCount: 0,
      errors,
      warnings
    };
  }

  const root = document.getRoot();
  const meshes = root.listMeshes();
  const nodes = root.listNodes();
  let primitiveCount = 0;
  let triangleCount = 0;

  for (const mesh of meshes) {
    for (const primitive of mesh.listPrimitives()) {
      primitiveCount++;
      const position = primitive.getAttribute('POSITION');
      if (!position || position.getCount() <= 0) {
        errors.push(`Mesh "${mesh.getName() || '(unnamed)'}" has a primitive without POSITION data.`);
        continue;
      }

      const triangles = countPrimitiveTriangles(primitive);
      if (triangles <= 0) {
        errors.push(`Mesh "${mesh.getName() || '(unnamed)'}" has a primitive with no triangles.`);
      }
      triangleCount += triangles;
    }
  }

  if (meshes.length <= 0) {
    errors.push('GLB contains no meshes.');
  }
  if (primitiveCount <= 0) {
    errors.push('GLB contains no mesh primitives.');
  }
  if (triangleCount <= 0) {
    errors.push('GLB contains no triangles.');
  }

  return {
    success: errors.length === 0,
    fileExists: true,
    fileSizeBytes,
    meshCount: meshes.length,
    primitiveCount,
    nodeCount: nodes.length,
    triangleCount,
    errors,
    warnings
  };
}

module.exports = { validateGlb };
