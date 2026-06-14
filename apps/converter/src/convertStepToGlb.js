const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { Document, NodeIO, Accessor } = require('@gltf-transform/core');
const { validateGlb } = require('./validateGlb');

function getQualityOptions(preset) {
  // Map preset to linearDeflection and angularDeflection
  // Default is 'balanced'
  let linearDeflection = 0.1;
  let angularDeflection = 0.5;

  if (preset === 'fast') {
    linearDeflection = 0.5;
    angularDeflection = 1.0;
  } else if (preset === 'balanced') {
    linearDeflection = 0.1;
    angularDeflection = 0.5;
  } else if (preset === 'high') {
    linearDeflection = 0.01;
    angularDeflection = 0.1;
  }

  return {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: linearDeflection,
    angularDeflection: angularDeflection,
  };
}

function generateNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const idx1 = indices[i] * 3;
    const idx2 = indices[i + 1] * 3;
    const idx3 = indices[i + 2] * 3;

    const v1 = [positions[idx1], positions[idx1 + 1], positions[idx1 + 2]];
    const v2 = [positions[idx2], positions[idx2 + 1], positions[idx2 + 2]];
    const v3 = [positions[idx3], positions[idx3 + 1], positions[idx3 + 2]];

    const ax = v2[0] - v1[0];
    const ay = v2[1] - v1[1];
    const az = v2[2] - v1[2];

    const bx = v3[0] - v1[0];
    const by = v3[1] - v1[1];
    const bz = v3[2] - v1[2];

    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;

    normals[idx1] += nx; normals[idx1 + 1] += ny; normals[idx1 + 2] += nz;
    normals[idx2] += nx; normals[idx2 + 1] += ny; normals[idx2 + 2] += nz;
    normals[idx3] += nx; normals[idx3 + 1] += ny; normals[idx3 + 2] += nz;
  }

  for (let i = 0; i < normals.length; i += 3) {
    const nx = normals[i], ny = normals[i + 1], nz = normals[i + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 0) {
      normals[i] /= len;
      normals[i + 1] /= len;
      normals[i + 2] /= len;
    }
  }
  return normals;
}

function isArrayLike(value) {
  return Array.isArray(value) || ArrayBuffer.isView(value);
}

function flattenNumericArray(value, tupleSize) {
  if (!isArrayLike(value)) return null;
  if (value.length === 0) return [];

  if (isArrayLike(value[0])) {
    const flattened = [];
    for (const tuple of value) {
      if (!isArrayLike(tuple) || tuple.length !== tupleSize) return null;
      for (const item of tuple) {
        flattened.push(item);
      }
    }
    return flattened;
  }

  return Array.from(value);
}

function hasFiniteNumbers(value) {
  if (!isArrayLike(value)) return false;
  for (const item of value) {
    if (!Number.isFinite(item)) return false;
  }
  return true;
}

function getNormalizedMeshGeometry(occtMesh) {
  const positions = flattenNumericArray(
    occtMesh && occtMesh.attributes && occtMesh.attributes.position && occtMesh.attributes.position.array,
    3
  );
  const indices = flattenNumericArray(occtMesh && occtMesh.index && occtMesh.index.array, 3);
  const normals = flattenNumericArray(
    occtMesh && occtMesh.attributes && occtMesh.attributes.normal && occtMesh.attributes.normal.array,
    3
  );

  return { positions, indices, normals };
}

function validateMeshGeometry(occtMesh, meshIndex) {
  const errors = [];
  if (!occtMesh || typeof occtMesh !== 'object') {
    return [`Mesh index ${meshIndex} is missing or invalid.`];
  }

  const { positions, indices, normals } = getNormalizedMeshGeometry(occtMesh);

  if (!hasFiniteNumbers(positions)) {
    errors.push(`Mesh index ${meshIndex} is missing finite POSITION data.`);
  } else if (positions.length === 0 || positions.length % 3 !== 0) {
    errors.push(`Mesh index ${meshIndex} POSITION array length must be a non-zero multiple of 3.`);
  }

  if (!hasFiniteNumbers(indices)) {
    errors.push(`Mesh index ${meshIndex} is missing finite index data.`);
  } else if (indices.length === 0 || indices.length % 3 !== 0) {
    errors.push(`Mesh index ${meshIndex} index array length must be a non-zero multiple of 3.`);
  } else if (positions && positions.length) {
    const vertexCount = positions.length / 3;
    for (let i = 0; i < indices.length; i++) {
      const index = indices[i];
      if (!Number.isInteger(index) || index < 0 || index >= vertexCount) {
        errors.push(`Mesh index ${meshIndex} has invalid triangle index ${index} at offset ${i}.`);
        break;
      }
    }
  }

  if (normals && normals.length > 0 && (!hasFiniteNumbers(normals) || normals.length !== positions.length)) {
    errors.push(`Mesh index ${meshIndex} NORMAL array is malformed or does not match POSITION length.`);
  }

  return errors;
}

function collectReferencedMeshIndices(root, referenced = new Set()) {
  if (!root || typeof root !== 'object') return referenced;
  if (Array.isArray(root.meshes)) {
    for (const meshIndex of root.meshes) {
      referenced.add(meshIndex);
    }
  }
  if (Array.isArray(root.children)) {
    for (const child of root.children) {
      collectReferencedMeshIndices(child, referenced);
    }
  }
  return referenced;
}

function runStepImportWorker(inputPath, options, logger) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'readStepWorker.js'), {
      workerData: { inputPath, options }
    });

    worker.on('message', (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'stage:start') {
        logger.start(message.stage, message.detail);
      } else if (message.type === 'stage:end') {
        logger.end(message.stage, message.detail);
      } else if (message.type === 'warning') {
        logger.warn(`[worker:warn] ${message.message}`);
      } else if (message.type === 'result') {
        resolve(message.result);
      } else if (message.type === 'error') {
        const err = new Error(message.message);
        if (message.stack) err.stack = message.stack;
        reject(err);
      }
    });

    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`STEP import worker exited with code ${code}`));
      }
    });
  });
}

async function convertStepToGlb(inputPath, outputPath, quality, statsRecorder, logger = console) {
  statsRecorder.setSourceFile(inputPath);
  statsRecorder.start();

  const options = getQualityOptions(quality);
  statsRecorder.setQuality(quality, options);

  let result;
  try {
    result = await runStepImportWorker(inputPath, options, logger);
  } catch (err) {
    statsRecorder.error(`occt-import-js threw while reading STEP file: ${err.message}`);
    statsRecorder.stop();
    return false;
  }

  if (!result || typeof result !== 'object') {
    statsRecorder.error('occt-import-js returned an invalid result object.');
    statsRecorder.stop();
    return false;
  }

  if (!result.success) {
    statsRecorder.error('Failed to parse STEP file via occt-import-js');
    statsRecorder.stop();
    return false;
  }

  if (!Array.isArray(result.meshes) || result.meshes.length === 0) {
    statsRecorder.error('occt-import-js reported success but returned no meshes.');
    statsRecorder.stop();
    return false;
  }

  if (!result.root || typeof result.root !== 'object') {
    statsRecorder.error('occt-import-js reported success but returned no root node.');
    statsRecorder.stop();
    return false;
  }

  logger.start('mesh extraction', `occtMeshes=${result.meshes.length}`);
  const referencedMeshIndices = collectReferencedMeshIndices(result.root);
  if (referencedMeshIndices.size === 0) {
    statsRecorder.error('occt-import-js returned meshes, but the root hierarchy references none of them.');
    statsRecorder.stop();
    return false;
  }

  for (const meshIndex of referencedMeshIndices) {
    if (!Number.isInteger(meshIndex) || meshIndex < 0 || meshIndex >= result.meshes.length) {
      statsRecorder.error(`Root hierarchy references invalid mesh index ${meshIndex}.`);
      statsRecorder.stop();
      return false;
    }

    const geometryErrors = validateMeshGeometry(result.meshes[meshIndex], meshIndex);
    if (geometryErrors.length > 0) {
      for (const message of geometryErrors) {
        statsRecorder.error(message);
      }
      statsRecorder.stop();
      return false;
    }
  }

  const document = new Document();
  const scene = document.createScene('Scene');
  const buffer = document.createBuffer('Data');

  let triangleCount = 0;
  let totalNodeCount = 0;

  // Cache glTF meshes to avoid duplicating
  const gltfMeshes = new Map();
  const materialCache = new Map();
  const normalizedGeometry = new Map();

  function getOrCreateMaterial(colorArray) {
    let colorKey = 'default';
    let baseColor = [0.8, 0.8, 0.8, 1.0];
    if (colorArray && colorArray.length >= 3) {
      baseColor = [colorArray[0], colorArray[1], colorArray[2], 1.0];
      colorKey = baseColor.join(',');
    }

    if (materialCache.has(colorKey)) {
      return materialCache.get(colorKey);
    }

    const material = document.createMaterial()
      .setBaseColorFactor(baseColor)
      .setRoughnessFactor(0.5)
      .setMetallicFactor(0.1)
      .setName(`Material_${colorKey}`);

    materialCache.set(colorKey, material);
    return material;
  }

  function getOrCreateMesh(meshIndex) {
    if (gltfMeshes.has(meshIndex)) {
      return gltfMeshes.get(meshIndex);
    }

    const occtMesh = result.meshes[meshIndex];

    let geometry = normalizedGeometry.get(meshIndex);
    if (!geometry) {
      geometry = getNormalizedMeshGeometry(occtMesh);
      normalizedGeometry.set(meshIndex, geometry);
    }

    const positions = geometry.positions;
    const indices = geometry.indices;
    let normals = geometry.normals;

    if (!normals || normals.length === 0) {
      statsRecorder.warn(`Generating missing normals for mesh index ${meshIndex}`);
      normals = generateNormals(positions, indices);
    }

    triangleCount += Math.floor(indices.length / 3);

    const positionAccessor = document.createAccessor()
      .setArray(new Float32Array(positions))
      .setType(Accessor.Type.VEC3)
      .setBuffer(buffer);

    const normalAccessor = document.createAccessor()
      .setArray(new Float32Array(normals))
      .setType(Accessor.Type.VEC3)
      .setBuffer(buffer);

    // Depending on max index, we can use Uint16 or Uint32. Let's use Uint32 for safety
    const indexAccessor = document.createAccessor()
      .setArray(new Uint32Array(indices))
      .setType(Accessor.Type.SCALAR)
      .setBuffer(buffer);

    const material = getOrCreateMaterial(occtMesh.color);

    const primitive = document.createPrimitive()
      .setAttribute('POSITION', positionAccessor)
      .setAttribute('NORMAL', normalAccessor)
      .setIndices(indexAccessor)
      .setMaterial(material);

    const gltfMesh = document.createMesh(occtMesh.name || `Mesh_${meshIndex}`)
      .addPrimitive(primitive);

    gltfMeshes.set(meshIndex, gltfMesh);
    return gltfMesh;
  }

  function traverseNode(occtNode, parentGltfNode) {
    totalNodeCount++;
    const nodeName = occtNode.name || 'Node';
    const gltfNode = document.createNode(nodeName);

    if (parentGltfNode) {
      parentGltfNode.addChild(gltfNode);
    } else {
      scene.addChild(gltfNode);
    }

    // Assign meshes
    if (occtNode.meshes && occtNode.meshes.length > 0) {
      // If there are multiple meshes, we might need multiple nodes,
      // but glTF allows one mesh per node.
      // So if multiple meshes, we create child nodes for each mesh.
      if (occtNode.meshes.length === 1) {
        const gltfMesh = getOrCreateMesh(occtNode.meshes[0]);
        if (gltfMesh) gltfNode.setMesh(gltfMesh);
      } else {
        for (const meshIndex of occtNode.meshes) {
          const gltfMesh = getOrCreateMesh(meshIndex);
          if (gltfMesh) {
            const childMeshNode = document.createNode(`${nodeName}_mesh_${meshIndex}`).setMesh(gltfMesh);
            gltfNode.addChild(childMeshNode);
            totalNodeCount++;
          }
        }
      }
    }

    // Traverse children
    if (occtNode.children) {
      for (const child of occtNode.children) {
        traverseNode(child, gltfNode);
      }
    }
  }

  // occt-import-js root might have empty name and contain everything
  traverseNode(result.root, null);

  if (gltfMeshes.size === 0 || triangleCount <= 0) {
    statsRecorder.error('Conversion produced no usable glTF meshes or triangles.');
    statsRecorder.stop();
    return false;
  }

  statsRecorder.recordCounts(
    triangleCount,
    totalNodeCount,
    gltfMeshes.size,
    totalNodeCount // Treating nodes as objects
  );

  const io = new NodeIO();

  // Ensure output directory exists
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  logger.end('mesh extraction', `gltfMeshes=${gltfMeshes.size} triangles=${triangleCount}`);
  logger.start('GLB writing', outputPath);
  await io.write(outputPath, document);
  logger.end('GLB writing', outputPath);

  logger.start('GLB validation', outputPath);
  const validation = await validateGlb(outputPath);
  logger.end('GLB validation', `success=${validation.success}`);
  statsRecorder.recordValidation(validation);

  for (const message of validation.warnings) {
    statsRecorder.warn(message);
  }

  if (!validation.success) {
    for (const message of validation.errors) {
      statsRecorder.error(message);
    }
    statsRecorder.stop();
    statsRecorder.setSuccess(false);
    return false;
  }

  statsRecorder.stop();
  statsRecorder.setSuccess(true);
  return true;
}

module.exports = { convertStepToGlb };
