const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { Document, NodeIO, Accessor } = require('@gltf-transform/core');
const { validateGlb } = require('./validateGlb');
const { findMaterialRule, loadMaterialRules } = require('./materialRules');

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
  } else if (preset === 'high' || preset === 'detailed') {
    linearDeflection = 0.035;
    angularDeflection = 0.25;
  }

  return {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: linearDeflection,
    angularDeflection: angularDeflection,
  };
}

const DEFAULT_COLOR = [0.72, 0.72, 0.72, 1.0];

function generateFlatGeometry(positions, indices) {
  const flatPositions = new Float32Array(indices.length * 3);
  const flatNormals = new Float32Array(indices.length * 3);
  const flatIndices = new Uint32Array(indices.length);

  for (let i = 0; i < indices.length; i += 3) {
    const source1 = indices[i] * 3;
    const source2 = indices[i + 1] * 3;
    const source3 = indices[i + 2] * 3;
    const target1 = i * 3;
    const target2 = (i + 1) * 3;
    const target3 = (i + 2) * 3;

    const v1 = [positions[source1], positions[source1 + 1], positions[source1 + 2]];
    const v2 = [positions[source2], positions[source2 + 1], positions[source2 + 2]];
    const v3 = [positions[source3], positions[source3 + 1], positions[source3 + 2]];

    const ax = v2[0] - v1[0];
    const ay = v2[1] - v1[1];
    const az = v2[2] - v1[2];

    const bx = v3[0] - v1[0];
    const by = v3[1] - v1[1];
    const bz = v3[2] - v1[2];

    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 0) {
      nx /= len;
      ny /= len;
      nz /= len;
    }

    flatPositions.set(v1, target1);
    flatPositions.set(v2, target2);
    flatPositions.set(v3, target3);
    flatNormals.set([nx, ny, nz], target1);
    flatNormals.set([nx, ny, nz], target2);
    flatNormals.set([nx, ny, nz], target3);
    flatIndices[i] = i;
    flatIndices[i + 1] = i + 1;
    flatIndices[i + 2] = i + 2;
  }

  return {
    positions: flatPositions,
    normals: flatNormals,
    indices: flatIndices,
    source: 'generated_flat_triangle_normals'
  };
}

function triangleNormalFromPositions(positions, i1, i2, i3) {
  const idx1 = i1 * 3;
  const idx2 = i2 * 3;
  const idx3 = i3 * 3;

  const ax = positions[idx2] - positions[idx1];
  const ay = positions[idx2 + 1] - positions[idx1 + 1];
  const az = positions[idx2 + 2] - positions[idx1 + 2];

  const bx = positions[idx3] - positions[idx1];
  const by = positions[idx3 + 1] - positions[idx1 + 1];
  const bz = positions[idx3 + 2] - positions[idx1 + 2];

  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);

  if (len === 0) {
    return [0, 0, 0];
  }

  return [nx / len, ny / len, nz / len];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function getPlanarFaceNormal(positions, indices, firstTriangle, lastTriangle) {
  const normals = [];
  let sum = [0, 0, 0];

  for (let triangleIndex = firstTriangle; triangleIndex <= lastTriangle; triangleIndex++) {
    const offset = triangleIndex * 3;
    const normal = triangleNormalFromPositions(positions, indices[offset], indices[offset + 1], indices[offset + 2]);
    if (normal[0] === 0 && normal[1] === 0 && normal[2] === 0) continue;
    normals.push(normal);
    sum = [sum[0] + normal[0], sum[1] + normal[1], sum[2] + normal[2]];
  }

  const len = Math.sqrt(sum[0] * sum[0] + sum[1] * sum[1] + sum[2] * sum[2]);
  if (len === 0 || normals.length === 0) return null;

  const average = [sum[0] / len, sum[1] / len, sum[2] / len];
  const cosTolerance = Math.cos(2.5 * Math.PI / 180);
  return normals.every((normal) => dot(normal, average) >= cosTolerance) ? average : null;
}

function buildCadFaceGeometry(positions, indices, normals, brepFaces) {
  const triangleTotal = Math.floor(indices.length / 3);
  const flatPositions = new Float32Array(indices.length * 3);
  const flatNormals = new Float32Array(indices.length * 3);
  const flatIndices = new Uint32Array(indices.length);
  const faceByTriangle = new Map();
  let planarFaceCount = 0;
  let curvedFaceCount = 0;

  for (const face of brepFaces) {
    const first = Math.max(0, face.first);
    const last = Math.min(face.last, triangleTotal - 1);
    if (first > last) continue;
    const planarNormal = getPlanarFaceNormal(positions, indices, first, last);
    if (planarNormal) {
      planarFaceCount++;
    } else {
      curvedFaceCount++;
    }
    for (let triangleIndex = first; triangleIndex <= last; triangleIndex++) {
      faceByTriangle.set(triangleIndex, planarNormal);
    }
  }

  for (let i = 0; i < indices.length; i += 3) {
    const triangleIndex = i / 3;
    const planarNormal = faceByTriangle.get(triangleIndex);
    const triangleNormal = planarNormal || triangleNormalFromPositions(positions, indices[i], indices[i + 1], indices[i + 2]);

    for (let vertexOffset = 0; vertexOffset < 3; vertexOffset++) {
      const sourceVertex = indices[i + vertexOffset];
      const sourcePositionOffset = sourceVertex * 3;
      const targetOffset = (i + vertexOffset) * 3;
      flatPositions[targetOffset] = positions[sourcePositionOffset];
      flatPositions[targetOffset + 1] = positions[sourcePositionOffset + 1];
      flatPositions[targetOffset + 2] = positions[sourcePositionOffset + 2];

      if (planarNormal || !normals || normals.length !== positions.length) {
        flatNormals[targetOffset] = triangleNormal[0];
        flatNormals[targetOffset + 1] = triangleNormal[1];
        flatNormals[targetOffset + 2] = triangleNormal[2];
      } else {
        const sourceNormalOffset = sourceVertex * 3;
        flatNormals[targetOffset] = normals[sourceNormalOffset];
        flatNormals[targetOffset + 1] = normals[sourceNormalOffset + 1];
        flatNormals[targetOffset + 2] = normals[sourceNormalOffset + 2];
      }

      flatIndices[i + vertexOffset] = i + vertexOffset;
    }
  }

  return {
    positions: flatPositions,
    normals: flatNormals,
    indices: flatIndices,
    planarFaceCount,
    curvedFaceCount,
    source: normals && normals.length === positions.length
      ? 'cad_face_planar_normals_with_occt_curves'
      : 'cad_face_planar_normals_with_generated_curves'
  };
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

function isValidColor(value) {
  return isArrayLike(value)
    && value.length >= 3
    && Number.isFinite(value[0])
    && Number.isFinite(value[1])
    && Number.isFinite(value[2]);
}

function normalizeColor(value) {
  if (!isValidColor(value)) return null;
  return [
    Math.min(1, Math.max(0, Number(value[0]))),
    Math.min(1, Math.max(0, Number(value[1]))),
    Math.min(1, Math.max(0, Number(value[2]))),
    value.length >= 4 && Number.isFinite(value[3]) ? Math.min(1, Math.max(0, Number(value[3]))) : 1.0
  ];
}

function colorKey(color) {
  return color.map((value) => Number(value).toFixed(6)).join(',');
}

function safeName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function getObjectColor(value) {
  if (!value || typeof value !== 'object') return null;

  const directCandidates = [
    value.color,
    value.colour,
    value.diffuseColor,
    value.diffuse_color,
    value.materialColor,
    value.material_color,
    value.layerColor,
    value.layer_color,
    value.styleColor,
    value.style_color
  ];

  for (const candidate of directCandidates) {
    const color = normalizeColor(candidate);
    if (color) return color;
  }

  if (value.material && typeof value.material === 'object') {
    const color = getObjectColor(value.material);
    if (color) return color;
  }

  if (value.style && typeof value.style === 'object') {
    const color = getObjectColor(value.style);
    if (color) return color;
  }

  return null;
}

function addCount(target, key) {
  target[key] = (target[key] || 0) + 1;
}

function collectNodeStats(node, stats, depth = 0) {
  if (!node || typeof node !== 'object') return;

  stats.nodeCount++;
  stats.maxNodeDepth = Math.max(stats.maxNodeDepth, depth);
  const nodeName = safeName(node.name);
  if (nodeName) stats.nodeNamesWithValues++;
  if (getObjectColor(node)) stats.nodesWithExplicitColor++;

  for (const key of Object.keys(node)) {
    const value = node[key];
    if (key === 'children') continue;
    if (key === 'meshes') {
      if (Array.isArray(value)) stats.nodesWithMeshReferences += value.length > 0 ? 1 : 0;
      continue;
    }

    if (typeof value === 'string' && value.trim()) addCount(stats.nodeStringFields, key);
    if (getObjectColor({ [key]: value })) addCount(stats.nodeColorFields, key);
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      collectNodeStats(child, stats, depth + 1);
    }
  }
}

function collectOcctMetadataStats(result) {
  const stats = {
    topLevelKeys: Object.keys(result || {}),
    meshCount: Array.isArray(result && result.meshes) ? result.meshes.length : 0,
    nodeCount: 0,
    maxNodeDepth: 0,
    nodesWithMeshReferences: 0,
    nodeNamesWithValues: 0,
    nodesWithExplicitColor: 0,
    meshesWithNames: 0,
    meshesWithExplicitColor: 0,
    brepFaceCount: 0,
    brepFacesWithExplicitColor: 0,
    meshStringFields: {},
    meshColorFields: {},
    faceColorFields: {},
    nodeStringFields: {},
    nodeColorFields: {},
    uniqueExplicitMeshColors: {},
    uniqueExplicitFaceColors: {}
  };

  collectNodeStats(result && result.root, stats);

  for (const mesh of result.meshes || []) {
    if (!mesh || typeof mesh !== 'object') continue;
    if (safeName(mesh.name)) stats.meshesWithNames++;
    const meshColor = getObjectColor(mesh);
    if (meshColor) {
      stats.meshesWithExplicitColor++;
      addCount(stats.uniqueExplicitMeshColors, colorKey(meshColor));
    }

    for (const key of Object.keys(mesh)) {
      if (['attributes', 'index', 'brep_faces'].includes(key)) continue;
      if (typeof mesh[key] === 'string' && mesh[key].trim()) addCount(stats.meshStringFields, key);
      if (getObjectColor({ [key]: mesh[key] })) addCount(stats.meshColorFields, key);
    }

    for (const face of mesh.brep_faces || []) {
      stats.brepFaceCount++;
      const faceColor = getObjectColor(face);
      if (faceColor) {
        stats.brepFacesWithExplicitColor++;
        addCount(stats.uniqueExplicitFaceColors, colorKey(faceColor));
      }
      for (const key of Object.keys(face)) {
        if (getObjectColor({ [key]: face[key] })) addCount(stats.faceColorFields, key);
      }
    }
  }

  return stats;
}

function buildNameColorIndex(result) {
  const buckets = new Map();

  function add(name, color, reason = 'name') {
    const normalizedName = safeName(name);
    if (!normalizedName || !color) return;
    const key = normalizedName.toLowerCase();
    if (!buckets.has(key)) {
      buckets.set(key, { name: normalizedName, counts: new Map() });
    }
    const bucket = buckets.get(key);
    const materialKey = colorKey(color);
    const current = bucket.counts.get(materialKey) || { color, count: 0, reasons: new Set() };
    current.count++;
    current.reasons.add(reason);
    bucket.counts.set(materialKey, current);
  }

  function get(name) {
    const bucket = buckets.get(safeName(name).toLowerCase());
    if (!bucket) return null;
    const ranked = Array.from(bucket.counts.values()).sort((a, b) => b.count - a.count);
    if (ranked.length === 0) return null;
    const reasons = Array.from(ranked[0].reasons || []);
    return {
      color: ranked[0].color,
      source: reasons.includes('node-sibling') ? 'assembly' : ranked.length === 1 ? 'name' : 'name-dominant',
      matchingColorCount: ranked[0].count,
      colorVariantCount: ranked.length
    };
  }

  for (const mesh of result.meshes || []) {
    add(mesh && mesh.name, getObjectColor(mesh), 'mesh-name');
  }

  function walkNode(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.meshes)) {
      for (const meshIndex of node.meshes) {
        const mesh = result.meshes && result.meshes[meshIndex];
        add(node.name, getObjectColor(mesh), 'node-sibling');
      }
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) walkNode(child);
    }
  }
  walkNode(result.root);

  return { get };
}

function materialNameFromColor(color, source) {
  const rgb = color.slice(0, 3).map((value) => Math.round(value * 255).toString(16).padStart(2, '0')).join('');
  return `CAD_${source}_${rgb}`;
}

function collectMeshHierarchyPaths(root) {
  const paths = new Map();

  function add(meshIndex, value) {
    if (!paths.has(meshIndex)) paths.set(meshIndex, []);
    paths.get(meshIndex).push(value);
  }

  function walk(node, parentPath = []) {
    if (!node || typeof node !== 'object') return;
    const nodeName = safeName(node.name) || 'Node';
    const nextPath = [...parentPath, nodeName];

    if (Array.isArray(node.meshes)) {
      for (const meshIndex of node.meshes) {
        add(meshIndex, nextPath.join(' > '));
      }
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child, nextPath);
    }
  }

  walk(root);
  return paths;
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
  logger.warn(`[tessellation] quality=${quality} linearUnit=${options.linearUnit} linearDeflectionType=${options.linearDeflectionType} linearDeflection=${options.linearDeflection} angularDeflection=${options.angularDeflection}`);
  logger.warn('[normals] using BREP face ranges to keep planar CAD faces flat; preserving OCCT normals for curved/non-planar faces where available.');

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
  const occtMetadataStats = collectOcctMetadataStats(result);
  const nameColorIndex = buildNameColorIndex(result);
  const meshHierarchyPaths = collectMeshHierarchyPaths(result.root);
  const materialRules = loadMaterialRules();
  statsRecorder.recordOcctMetadataStats(occtMetadataStats);
  logger.warn(`[occt:metadata] keys=${occtMetadataStats.topLevelKeys.join(',')} nodes=${occtMetadataStats.nodeCount} maxDepth=${occtMetadataStats.maxNodeDepth} meshes=${occtMetadataStats.meshCount} namedNodes=${occtMetadataStats.nodeNamesWithValues} namedMeshes=${occtMetadataStats.meshesWithNames}`);
  logger.warn(`[occt:colors] meshColors=${occtMetadataStats.meshesWithExplicitColor} faceColors=${occtMetadataStats.brepFacesWithExplicitColor} nodeColors=${occtMetadataStats.nodesWithExplicitColor} uniqueMeshColors=${Object.keys(occtMetadataStats.uniqueExplicitMeshColors).length} uniqueFaceColors=${Object.keys(occtMetadataStats.uniqueExplicitFaceColors).length}`);
  logger.warn(`[occt:fields] meshColorFields=${Object.keys(occtMetadataStats.meshColorFields).join(',') || 'none'} faceColorFields=${Object.keys(occtMetadataStats.faceColorFields).join(',') || 'none'} nodeColorFields=${Object.keys(occtMetadataStats.nodeColorFields).join(',') || 'none'}`);
  logger.warn(`[material-rules] mode=${materialRules.mode} path=${materialRules.path} loadedRules=${materialRules.rules.length}${materialRules.error ? ` error=${materialRules.error}` : ''}`);
  if (materialRules.error) {
    statsRecorder.warn(`Could not load material rules from ${materialRules.path}: ${materialRules.error}`);
  }

  let triangleCount = 0;
  let totalNodeCount = 0;
  const materialStats = {
    totalMeshes: result.meshes.length,
    referencedMeshes: referencedMeshIndices.size,
    meshesWithExplicitColor: 0,
    explicitMeshColorCount: 0,
    explicitFaceColorCount: 0,
    meshesUsingDefaultMaterial: 0,
    meshesWithFaceColors: 0,
    meshesUsingInheritedColor: 0,
    meshesUsingRuleColor: 0,
    defaultMaterialCount: 0,
    unknownUncoloredCount: 0,
    uniqueMaterialCount: 0,
    uniqueColors: [],
    materialSources: {
      face: 0,
      mesh: 0,
      assembly: 0,
      name: 0,
      'name-dominant': 0,
      rule: 0,
      default: 0
    },
    meshDetails: []
  };
  const materialDebug = {
    rulesMode: materialRules.mode,
    rulesPath: materialRules.path,
    rulesLoaded: materialRules.rules.length,
    rulesError: materialRules.error,
    meshes: []
  };
  const normalStats = {
    mode: 'cad_face_planar_normals_with_occt_curves',
    meshesUsingOcctNormals: 0,
    meshesUsingGeneratedFlatNormals: 0,
    meshesUsingCadFaceNormals: 0,
    planarBrepFaces: 0,
    curvedOrNonPlanarBrepFaces: 0,
    expandedVertexMeshes: 0
  };

  // Cache glTF meshes to avoid duplicating
  const gltfMeshes = new Map();
  const materialCache = new Map();
  const normalizedGeometry = new Map();

  function getOrCreateMaterial(color, source) {
    const baseColor = color || DEFAULT_COLOR;
    const key = `${source}:${colorKey(baseColor)}`;

    if (materialCache.has(key)) {
      return materialCache.get(key);
    }

    const material = document.createMaterial()
      .setBaseColorFactor(baseColor)
      .setRoughnessFactor(0.78)
      .setMetallicFactor(0)
      .setDoubleSided(true)
      .setName(materialNameFromColor(baseColor, source));

    materialCache.set(key, material);
    return material;
  }

  function getMaterialRuleForMesh(meshIndex, occtMesh) {
    return findMaterialRule(materialRules, [
      occtMesh && occtMesh.name,
      ...(meshHierarchyPaths.get(meshIndex) || [])
    ]);
  }

  function getMaterialRuns(meshIndex, occtMesh, triangleTotal, inheritedMaterial) {
    const meshColor = getObjectColor(occtMesh);
    const ruleMatch = getMaterialRuleForMesh(meshIndex, occtMesh);
    const shouldOverrideWithRule = materialRules.mode === 'override' && ruleMatch;
    const fallbackColor = inheritedMaterial && inheritedMaterial.color ? inheritedMaterial.color : DEFAULT_COLOR;
    const fallbackSource = inheritedMaterial && inheritedMaterial.color ? inheritedMaterial.source : 'default';
    const fallbackRuleColor = materialRules.mode === 'fallback' && ruleMatch ? ruleMatch.color : null;
    const fallbackRuleSource = fallbackRuleColor ? 'rule' : fallbackSource;
    const faces = Array.isArray(occtMesh.brep_faces)
      ? occtMesh.brep_faces
        .filter((face) => Number.isInteger(face.first) && Number.isInteger(face.last) && face.first <= face.last)
        .sort((a, b) => a.first - b.first)
      : [];
    const runs = [];
    let triangleIndex = 0;
    let explicitFaceColorCount = 0;

    if (shouldOverrideWithRule) {
      return {
        runs: [{
          firstTriangle: 0,
          lastTriangle: triangleTotal - 1,
          color: ruleMatch.color,
          source: 'rule',
          ruleName: ruleMatch.name
        }],
        meshColor,
        inheritedMaterial,
        ruleMatch,
        explicitFaceColorCount: faces.reduce((count, face) => count + (getObjectColor(face) ? 1 : 0), 0),
        faceRangeCount: faces.length
      };
    }

    for (const face of faces) {
      if (triangleIndex < face.first) {
        const gapColor = meshColor || inheritedMaterial && inheritedMaterial.color || fallbackRuleColor || fallbackColor;
        const gapSource = meshColor ? 'mesh' : inheritedMaterial && inheritedMaterial.color ? fallbackSource : fallbackRuleSource;
        runs.push({
          firstTriangle: triangleIndex,
          lastTriangle: Math.min(face.first - 1, triangleTotal - 1),
          color: gapColor,
          source: gapSource,
          ruleName: gapSource === 'rule' ? ruleMatch.name : undefined
        });
      }

      const faceColor = getObjectColor(face);
      if (faceColor) explicitFaceColorCount++;
      const runColor = faceColor || meshColor || inheritedMaterial && inheritedMaterial.color || fallbackRuleColor || fallbackColor;
      const runSource = faceColor ? 'face' : meshColor ? 'mesh' : inheritedMaterial && inheritedMaterial.color ? fallbackSource : fallbackRuleSource;
      runs.push({
        firstTriangle: Math.max(0, face.first),
        lastTriangle: Math.min(face.last, triangleTotal - 1),
        color: runColor,
        source: runSource,
        ruleName: runSource === 'rule' ? ruleMatch.name : undefined
      });
      triangleIndex = Math.min(face.last + 1, triangleTotal);
    }

    if (triangleIndex < triangleTotal) {
      const tailColor = meshColor || inheritedMaterial && inheritedMaterial.color || fallbackRuleColor || fallbackColor;
      const tailSource = meshColor ? 'mesh' : inheritedMaterial && inheritedMaterial.color ? fallbackSource : fallbackRuleSource;
      runs.push({
        firstTriangle: triangleIndex,
        lastTriangle: triangleTotal - 1,
        color: tailColor,
        source: tailSource,
        ruleName: tailSource === 'rule' ? ruleMatch.name : undefined
      });
    }

    if (runs.length === 0 && triangleTotal > 0) {
      const wholeColor = meshColor || inheritedMaterial && inheritedMaterial.color || fallbackRuleColor || fallbackColor;
      const wholeSource = meshColor ? 'mesh' : inheritedMaterial && inheritedMaterial.color ? fallbackSource : fallbackRuleSource;
      runs.push({
        firstTriangle: 0,
        lastTriangle: triangleTotal - 1,
        color: wholeColor,
        source: wholeSource,
        ruleName: wholeSource === 'rule' ? ruleMatch.name : undefined
      });
    }

    const mergedRuns = [];
    for (const run of runs) {
      if (run.firstTriangle > run.lastTriangle) continue;
      const previous = mergedRuns.at(-1);
      if (previous && previous.source === run.source && colorKey(previous.color) === colorKey(run.color) && previous.lastTriangle + 1 === run.firstTriangle) {
        previous.lastTriangle = run.lastTriangle;
      } else {
        mergedRuns.push(run);
      }
    }

    return {
      runs: mergedRuns,
      meshColor,
      inheritedMaterial,
      ruleMatch,
      explicitFaceColorCount,
      faceRangeCount: faces.length
    };
  }

  function createGeometryAccessors(meshIndex, positions, indices, normals) {
    const occtMesh = result.meshes[meshIndex];
    const brepFaces = Array.isArray(occtMesh.brep_faces)
      ? occtMesh.brep_faces.filter((face) => Number.isInteger(face.first) && Number.isInteger(face.last) && face.first <= face.last)
      : [];

    if (brepFaces.length > 0) {
      const cadGeometry = buildCadFaceGeometry(positions, indices, normals, brepFaces);
      normalStats.meshesUsingCadFaceNormals++;
      normalStats.planarBrepFaces += cadGeometry.planarFaceCount;
      normalStats.curvedOrNonPlanarBrepFaces += cadGeometry.curvedFaceCount;
      normalStats.expandedVertexMeshes++;
      if (normals && normals.length === positions.length) {
        normalStats.meshesUsingOcctNormals++;
      }
      return {
        positionsArray: cadGeometry.positions,
        normalsArray: cadGeometry.normals,
        indicesArray: cadGeometry.indices,
        normalSource: cadGeometry.source
      };
    }

    if (normals && normals.length === positions.length) {
      normalStats.meshesUsingOcctNormals++;
      return {
        positionsArray: new Float32Array(positions),
        normalsArray: new Float32Array(normals),
        indicesArray: new Uint32Array(indices),
        normalSource: 'occt'
      };
    }

    statsRecorder.warn(`Generating flat normals for mesh index ${meshIndex}; OCCT normals were missing.`);
    const flatGeometry = generateFlatGeometry(positions, indices);
    normalStats.meshesUsingGeneratedFlatNormals++;
    return {
      positionsArray: flatGeometry.positions,
      normalsArray: flatGeometry.normals,
      indicesArray: flatGeometry.indices,
      normalSource: flatGeometry.source
    };
  }

  function getOrCreateMesh(meshIndex, inheritedMaterial) {
    const cacheKey = inheritedMaterial && inheritedMaterial.color
      ? `${meshIndex}:${inheritedMaterial.source}:${colorKey(inheritedMaterial.color)}`
      : `${meshIndex}:none`;
    if (gltfMeshes.has(cacheKey)) {
      return gltfMeshes.get(cacheKey);
    }

    const occtMesh = result.meshes[meshIndex];

    let geometry = normalizedGeometry.get(meshIndex);
    if (!geometry) {
      geometry = getNormalizedMeshGeometry(occtMesh);
      normalizedGeometry.set(meshIndex, geometry);
    }

    const positions = geometry.positions;
    const indices = geometry.indices;
    const { positionsArray, normalsArray, indicesArray, normalSource } = createGeometryAccessors(
      meshIndex,
      positions,
      indices,
      geometry.normals
    );

    triangleCount += Math.floor(indices.length / 3);
    const triangleTotal = Math.floor(indicesArray.length / 3);
    const materialInfo = getMaterialRuns(meshIndex, occtMesh, triangleTotal, inheritedMaterial);
    const meshHasExplicitColor = Boolean(materialInfo.meshColor || materialInfo.explicitFaceColorCount > 0);
    const meshUsesInherited = !meshHasExplicitColor && Boolean(inheritedMaterial && inheritedMaterial.color);
    const meshUsesRule = materialInfo.runs.some((run) => run.source === 'rule');
    const meshUsesDefault = materialInfo.runs.some((run) => run.source === 'default');

    if (meshHasExplicitColor) materialStats.meshesWithExplicitColor++;
    if (materialInfo.meshColor) materialStats.explicitMeshColorCount++;
    materialStats.explicitFaceColorCount += materialInfo.explicitFaceColorCount;
    if (meshUsesInherited) materialStats.meshesUsingInheritedColor++;
    if (meshUsesRule) materialStats.meshesUsingRuleColor++;
    if (meshUsesDefault) materialStats.meshesUsingDefaultMaterial++;
    if (materialInfo.explicitFaceColorCount > 0) materialStats.meshesWithFaceColors++;

    const positionAccessor = document.createAccessor()
      .setArray(positionsArray)
      .setType(Accessor.Type.VEC3)
      .setBuffer(buffer);

    const normalAccessor = document.createAccessor()
      .setArray(normalsArray)
      .setType(Accessor.Type.VEC3)
      .setBuffer(buffer);

    const gltfMesh = document.createMesh(occtMesh.name || `Mesh_${meshIndex}`);

    for (const run of materialInfo.runs) {
      const runIndices = indicesArray.slice(run.firstTriangle * 3, (run.lastTriangle + 1) * 3);
      const indexAccessor = document.createAccessor()
        .setArray(runIndices)
        .setType(Accessor.Type.SCALAR)
        .setBuffer(buffer);
      const material = getOrCreateMaterial(run.color, run.source);

      gltfMesh.addPrimitive(
        document.createPrimitive()
          .setAttribute('POSITION', positionAccessor)
          .setAttribute('NORMAL', normalAccessor)
          .setIndices(indexAccessor)
          .setMaterial(material)
      );

      materialStats.materialSources[run.source] = (materialStats.materialSources[run.source] || 0) + 1;
    }

    if (meshUsesDefault) {
      materialStats.unknownUncoloredCount++;
    }

    materialStats.meshDetails.push({
      meshIndex,
      name: occtMesh.name || `Mesh_${meshIndex}`,
      hierarchyPaths: meshHierarchyPaths.get(meshIndex) || [],
      meshColor: materialInfo.meshColor,
      inheritedColor: inheritedMaterial && inheritedMaterial.color ? inheritedMaterial.color : null,
      inheritedSource: inheritedMaterial && inheritedMaterial.color ? inheritedMaterial.source : null,
      ruleMatch: materialInfo.ruleMatch ? materialInfo.ruleMatch.name : null,
      brepFaceRanges: materialInfo.faceRangeCount,
      explicitFaceColors: materialInfo.explicitFaceColorCount,
      materialRuns: materialInfo.runs.length,
      usedDefaultMaterial: meshUsesDefault,
      normalSource
    });

    materialDebug.meshes.push({
      meshIndex,
      meshName: occtMesh.name || `Mesh_${meshIndex}`,
      hierarchyPaths: meshHierarchyPaths.get(meshIndex) || [],
      sourceColorPresence: {
        face: materialInfo.explicitFaceColorCount > 0,
        mesh: Boolean(materialInfo.meshColor),
        inherited: Boolean(inheritedMaterial && inheritedMaterial.color),
        rule: Boolean(materialInfo.ruleMatch)
      },
      finalMaterials: materialInfo.runs.map((run) => ({
        firstTriangle: run.firstTriangle,
        lastTriangle: run.lastTriangle,
        materialSource: run.source,
        materialName: materialNameFromColor(run.color, run.source),
        color: run.color,
        ruleName: run.ruleName || null
      })),
      normalSource
    });

    gltfMeshes.set(cacheKey, gltfMesh);
    return gltfMesh;
  }

  function resolveInheritedMaterial(occtNode, parentInheritedMaterial) {
    const explicitColor = getObjectColor(occtNode);
    if (explicitColor) {
      return { color: explicitColor, source: 'assembly' };
    }

    const nameMatch = nameColorIndex.get(occtNode && occtNode.name);
    if (nameMatch) {
      return {
        color: nameMatch.color,
        source: nameMatch.source,
        matchingColorCount: nameMatch.matchingColorCount,
        colorVariantCount: nameMatch.colorVariantCount
      };
    }

    return parentInheritedMaterial || null;
  }

  function traverseNode(occtNode, parentGltfNode, parentInheritedMaterial = null) {
    totalNodeCount++;
    const nodeName = occtNode.name || 'Node';
    const gltfNode = document.createNode(nodeName);
    const inheritedMaterial = resolveInheritedMaterial(occtNode, parentInheritedMaterial);

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
        const meshIndex = occtNode.meshes[0];
        const mesh = result.meshes[meshIndex];
        const meshNameMatch = nameColorIndex.get(mesh && mesh.name);
        const gltfMesh = getOrCreateMesh(meshIndex, meshNameMatch || inheritedMaterial);
        if (gltfMesh) gltfNode.setMesh(gltfMesh);
      } else {
        for (const meshIndex of occtNode.meshes) {
          const mesh = result.meshes[meshIndex];
          const meshNameMatch = nameColorIndex.get(mesh && mesh.name);
          const meshInheritedMaterial = meshNameMatch || inheritedMaterial;
          const gltfMesh = getOrCreateMesh(meshIndex, meshInheritedMaterial);
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
        traverseNode(child, gltfNode, inheritedMaterial);
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
  materialStats.uniqueColors = Array.from(new Set(Array.from(materialCache.keys()).map((key) => key.split(':').slice(1).join(':'))));
  materialStats.uniqueMaterialCount = materialCache.size;
  materialStats.defaultMaterialCount = materialStats.materialSources.default || 0;
  statsRecorder.recordMaterialStats(materialStats);
  statsRecorder.recordNormalStats(normalStats);
  const materialDebugPath = path.join(path.dirname(outputPath), 'material-debug.json');
  fs.writeFileSync(materialDebugPath, `${JSON.stringify(materialDebug, null, 2)}\n`);
  logger.warn(`[materials] totalMeshes=${materialStats.totalMeshes} referencedMeshes=${materialStats.referencedMeshes} explicitMeshColorMeshes=${materialStats.meshesWithExplicitColor} explicitFaceColorMeshes=${materialStats.meshesWithFaceColors} inheritedColorMeshes=${materialStats.meshesUsingInheritedColor} ruleColorMeshes=${materialStats.meshesUsingRuleColor} defaultMaterialMeshes=${materialStats.meshesUsingDefaultMaterial} unknownUncoloredMeshes=${materialStats.unknownUncoloredCount} uniqueMaterials=${materialStats.uniqueMaterialCount}`);
  logger.warn(`[materials] sources faceRuns=${materialStats.materialSources.face || 0} meshRuns=${materialStats.materialSources.mesh || 0} assemblyRuns=${materialStats.materialSources.assembly || 0} nameRuns=${materialStats.materialSources.name || 0} nameDominantRuns=${materialStats.materialSources['name-dominant'] || 0} ruleRuns=${materialStats.materialSources.rule || 0} defaultRuns=${materialStats.materialSources.default || 0}`);
  logger.warn(`[materials] debug=${materialDebugPath}`);
  logger.warn(`[normals] mode=${normalStats.mode} cadFaceMeshes=${normalStats.meshesUsingCadFaceNormals} occtMeshes=${normalStats.meshesUsingOcctNormals} generatedFlatMeshes=${normalStats.meshesUsingGeneratedFlatNormals} planarBrepFaces=${normalStats.planarBrepFaces} curvedOrNonPlanarBrepFaces=${normalStats.curvedOrNonPlanarBrepFaces}`);

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
