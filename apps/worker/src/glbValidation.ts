import fs from "node:fs";
import { NodeIO, Primitive, type Document, type Property } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { getBounds } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import { validateBytes } from "gltf-validator";

export type GlbValidationResult = {
  passed: boolean;
  validator: { errors: number; warnings: number };
  gates: string[];
  compression: GlbCompressionInspection;
  message: string;
};

export type GlbCompressionInspection = {
  extension: "EXT_meshopt_compression";
  used: boolean;
  required: boolean;
  compressedBufferViews: number;
  extensionsUsed: string[];
  extensionsRequired: string[];
};

type Snapshot = ReturnType<typeof snapshot>;

export async function validateOptimizedGlb(rawPath: string, candidatePath: string): Promise<GlbValidationResult> {
  const rawBytes = await fs.promises.readFile(rawPath);
  const candidateBytes = await fs.promises.readFile(candidatePath);
  if (rawBytes.length === 0 || candidateBytes.length === 0) throw new Error("raw or candidate GLB is empty");

  const report = await validateBytes(candidateBytes, { uri: candidatePath, maxIssues: 200 });
  const errors = report.issues?.numErrors ?? 0;
  const warnings = report.issues?.numWarnings ?? 0;
  if (errors !== 0) {
    const details = JSON.stringify(report.issues?.messages?.slice(0, 5) ?? []);
    throw new Error(`glTF Validator reported ${errors} error(s): ${details}`);
  }

  const compression = inspectGlbCompression(candidateBytes);
  if (!compression.used || compression.compressedBufferViews === 0) {
    throw new Error("Meshopt candidate does not contain EXT_meshopt_compression buffer views");
  }
  if (!compression.required) {
    throw new Error("Meshopt candidate does not declare EXT_meshopt_compression as required");
  }

  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });
  const [rawDocument, candidateDocument] = await Promise.all([io.read(rawPath), io.read(candidatePath)]);
  const raw = snapshot(rawDocument);
  const candidate = snapshot(candidateDocument);
  const gates: string[] = [];

  equal("scene count", raw.sceneCount, candidate.sceneCount, gates);
  equal("node count", raw.nodeNames.length, candidate.nodeNames.length, gates);
  equal("mesh count", raw.meshNames.length, candidate.meshNames.length, gates);
  equal("primitive count", raw.primitives.length, candidate.primitives.length, gates);
  deepEqual("primitive modes", raw.primitives.map((item) => item.mode), candidate.primitives.map((item) => item.mode), gates);
  equal("triangle count", raw.triangleCount, candidate.triangleCount, gates);
  deepEqual("attribute semantic sets", raw.primitives.map((item) => item.semantics), candidate.primitives.map((item) => item.semantics), gates);
  deepEqual("node names", raw.nodeNames, candidate.nodeNames, gates);
  deepEqual("mesh names", raw.meshNames, candidate.meshNames, gates);
  deepEqual("scene root hierarchy", raw.sceneRoots, candidate.sceneRoots, gates);
  deepEqual("node child hierarchy", raw.nodeChildren, candidate.nodeChildren, gates);
  compareBounds(raw.nodeBounds, candidate.nodeBounds, gates, "node world bounds");
  deepEqual("stableObjectId multiset", raw.stableObjectIds, candidate.stableObjectIds, gates);
  deepEqual("selectableId multiset", raw.selectableIds, candidate.selectableIds, gates);
  deepEqual("node extras", raw.nodeExtras, candidate.nodeExtras, gates);
  deepEqual("mesh extras", raw.meshExtras, candidate.meshExtras, gates);
  deepEqual("material extras", raw.materialExtras, candidate.materialExtras, gates);
  deepEqual("geometry extras", raw.geometryExtras, candidate.geometryExtras, gates);
  equal("material count", raw.materials.length, candidate.materials.length, gates);
  approximateDeepEqual("material names and PBR factors", raw.materials, candidate.materials, 1e-6, gates);
  deepEqual("material assignments", raw.primitives.map((item) => item.material), candidate.primitives.map((item) => item.material), gates);
  compareBounds(raw.bounds, candidate.bounds, gates, "scene bounds");
  gates.push("EXT_meshopt_compression present and required");

  return {
    passed: true,
    validator: { errors, warnings },
    gates,
    compression,
    message: `passed ${gates.length} semantic gates; glTF Validator errors=${errors}, warnings=${warnings}`
  };
}

export function inspectGlbCompression(bytes: Buffer): GlbCompressionInspection {
  const empty: GlbCompressionInspection = {
    extension: "EXT_meshopt_compression",
    used: false,
    required: false,
    compressedBufferViews: 0,
    extensionsUsed: [],
    extensionsRequired: []
  };
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2) return empty;
  const jsonChunkLength = bytes.readUInt32LE(12);
  const jsonChunkType = bytes.readUInt32LE(16);
  if (jsonChunkType !== 0x4e4f534a || jsonChunkLength <= 0 || 20 + jsonChunkLength > bytes.length) return empty;
  try {
    const jsonText = bytes.toString("utf8", 20, 20 + jsonChunkLength).replace(/[\u0000\s]+$/, "");
    const json = JSON.parse(jsonText) as {
      extensionsUsed?: unknown;
      extensionsRequired?: unknown;
      bufferViews?: Array<{ extensions?: Record<string, unknown> }>;
    };
    const extensionsUsed = stringArray(json.extensionsUsed);
    const extensionsRequired = stringArray(json.extensionsRequired);
    const compressedBufferViews = Array.isArray(json.bufferViews)
      ? json.bufferViews.filter((view) => Boolean(view?.extensions?.EXT_meshopt_compression)).length
      : 0;
    return {
      extension: "EXT_meshopt_compression",
      used: extensionsUsed.includes("EXT_meshopt_compression") || compressedBufferViews > 0,
      required: extensionsRequired.includes("EXT_meshopt_compression"),
      compressedBufferViews,
      extensionsUsed,
      extensionsRequired
    };
  } catch {
    return empty;
  }
}

function snapshot(document: Document) {
  const root = document.getRoot();
  const nodes = root.listNodes();
  const meshes = root.listMeshes();
  const materials = root.listMaterials();
  const nodeIndex = new Map(nodes.map((node, index) => [node, index]));
  const materialIndex = new Map(materials.map((material, index) => [material, index]));
  const primitives = meshes.flatMap((mesh) => mesh.listPrimitives().map((primitive) => ({
    mode: primitive.getMode(),
    semantics: primitive.listSemantics().sort(),
    material: primitive.getMaterial() ? materialIndex.get(primitive.getMaterial()!) ?? null : null,
    count: primitive.getIndices()?.getCount() ?? primitive.getAttribute("POSITION")?.getCount() ?? 0
  })));
  const allExtras = [
    ...nodes.map((item) => item.getExtras()),
    ...meshes.map((item) => item.getExtras()),
    ...materials.map((item) => item.getExtras()),
    ...meshes.flatMap((mesh) => mesh.listPrimitives().map((item) => item.getExtras()))
  ];

  return {
    sceneCount: root.listScenes().length,
    sceneRoots: root.listScenes().map((scene) => scene.listChildren().map((node) => nodeIndex.get(node) ?? -1)),
    nodeNames: nodes.map((item) => item.getName()),
    nodeChildren: nodes.map((node) => node.listChildren().map((child) => nodeIndex.get(child) ?? -1)),
    nodeBounds: nodes.map((node) => getBounds(node)),
    meshNames: meshes.map((item) => item.getName()),
    nodeExtras: nodes.map((item) => item.getExtras()),
    meshExtras: meshes.map((item) => item.getExtras()),
    materialExtras: materials.map((item) => item.getExtras()),
    geometryExtras: meshes.flatMap((mesh) => mesh.listPrimitives().map((primitive) => ({
      primitive: primitive.getExtras(),
      indices: primitive.getIndices()?.getExtras() ?? null,
      attributes: Object.fromEntries(primitive.listSemantics().sort().map((semantic) => [semantic, primitive.getAttribute(semantic)?.getExtras() ?? null]))
    }))),
    stableObjectIds: collectIds(allExtras, "stableObjectId"),
    selectableIds: collectIds(allExtras, "selectableId"),
    materials: materials.map((material) => ({
      name: material.getName(),
      baseColorFactor: material.getBaseColorFactor(),
      metallicFactor: material.getMetallicFactor(),
      roughnessFactor: material.getRoughnessFactor(),
      emissiveFactor: material.getEmissiveFactor(),
      alphaMode: material.getAlphaMode(),
      alphaCutoff: material.getAlphaCutoff(),
      doubleSided: material.getDoubleSided()
    })),
    primitives,
    triangleCount: primitives.reduce((sum, item) => sum + triangleCount(item.mode, item.count), 0),
    bounds: root.listScenes().map((scene) => getBounds(scene))
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function triangleCount(mode: number, count: number): number {
  if (mode === Primitive.Mode.TRIANGLES) return Math.floor(count / 3);
  if (mode === Primitive.Mode.TRIANGLE_STRIP || mode === Primitive.Mode.TRIANGLE_FAN) return Math.max(0, count - 2);
  return 0;
}

function collectIds(values: unknown[], key: string): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      if (entryKey === key && (typeof entryValue === "string" || typeof entryValue === "number")) found.push(String(entryValue));
      visit(entryValue);
    }
  };
  values.forEach(visit);
  return found.sort();
}

function equal(label: string, expected: unknown, actual: unknown, gates: string[]): void {
  if (expected !== actual) throw new Error(`${label} changed: ${String(expected)} -> ${String(actual)}`);
  gates.push(label);
}

function deepEqual(label: string, expected: unknown, actual: unknown, gates: string[]): void {
  if (canonical(expected) !== canonical(actual)) throw new Error(`${label} changed`);
  gates.push(label);
}

function approximateDeepEqual(label: string, expected: unknown, actual: unknown, tolerance: number, gates: string[]): void {
  const compare = (left: unknown, right: unknown): boolean => {
    if (typeof left === "number" && typeof right === "number") return Math.abs(left - right) <= tolerance;
    if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => compare(value, right[index]));
    if (left && right && typeof left === "object" && typeof right === "object") {
      const leftEntries = Object.entries(left as Record<string, unknown>).sort();
      const rightEntries = Object.entries(right as Record<string, unknown>).sort();
      return leftEntries.length === rightEntries.length && leftEntries.every(([key, value], index) => key === rightEntries[index]?.[0] && compare(value, rightEntries[index]?.[1]));
    }
    return left === right;
  };
  if (!compare(expected, actual)) {
    throw new Error(`${label} changed beyond tolerance ${tolerance}: expected=${canonical(expected)} actual=${canonical(actual)}`);
  }
  gates.push(label);
}

function compareBounds(
  expected: Snapshot["bounds"],
  actual: Snapshot["bounds"],
  gates: string[],
  label: string
): void {
  if (expected.length !== actual.length) throw new Error(`${label} count changed`);
  for (let sceneIndex = 0; sceneIndex < expected.length; sceneIndex += 1) {
    const left = expected[sceneIndex]!;
    const right = actual[sceneIndex]!;
    const span = left.max.map((value, axis) => Math.abs(value - left.min[axis]!));
    for (let axis = 0; axis < 3; axis += 1) {
      // Quantization can move the accessor origin/scale into node transforms,
      // adding a second float32 round-trip to the nominal 16-bit position step.
      const coordinateMagnitude = Math.max(
        1,
        Math.abs(left.min[axis]!),
        Math.abs(left.max[axis]!),
        Math.abs(right.min[axis]!),
        Math.abs(right.max[axis]!)
      );
      const float32RoundTripTolerance = coordinateMagnitude * 4 * 2 ** -23;
      // STEP geometry in this pipeline is emitted in millimetres; keep an
      // absolute 1-micron floor so small, translated parts are not rejected
      // by sub-micron transform/accessor rounding.
      const tolerance = Math.max(1e-3, span[axis]! * 8 / 65535, float32RoundTripTolerance);
      const minDelta = Math.abs(left.min[axis]! - right.min[axis]!);
      const maxDelta = Math.abs(left.max[axis]! - right.max[axis]!);
      if (minDelta > tolerance || maxDelta > tolerance) {
        throw new Error(
          `${label} ${sceneIndex} axis ${axis} changed beyond position quantization tolerance ` +
          `(minDelta=${minDelta}, maxDelta=${maxDelta}, tolerance=${tolerance})`
        );
      }
    }
  }
  gates.push(label);
}

function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, normalize(entry)]));
  };
  return JSON.stringify(normalize(value));
}
