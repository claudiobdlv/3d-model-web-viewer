import fs from "node:fs";
import { NodeIO, Document, Primitive, type Node, type Material } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { getBounds, mergeDocuments } from "@gltf-transform/functions";

export type MergeGlbsResult = {
  mergedNodeCount: number;
  mergedTriangleCount: number;
  mergedMaterialCount: number;
  stableObjectIds: string[];
  selectableIds: string[];
  bounds: { min: number[]; max: number[] };
};

/**
 * Merges multiple chunk GLBs into a single merged GLB.
 * Preserves node hierarchy, node names, extras, material assignments, transforms, and IDs.
 */
export async function mergeGlbs(glbPaths: string[], outputPath: string): Promise<MergeGlbsResult> {
  if (glbPaths.length === 0) {
    throw new Error("No GLB paths provided to merge.");
  }

  for (const p of glbPaths) {
    if (!fs.existsSync(p)) {
      throw new Error(`Input GLB file not found: ${p}`);
    }
  }

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const mergedDoc = new Document();
  const mergedScene = mergedDoc.createScene("default");

  for (const glbPath of glbPaths) {
    const chunkDoc = await io.read(glbPath);
    const oldScenes = new Set(mergedDoc.getRoot().listScenes());

    // Merge chunk document
    mergeDocuments(mergedDoc, chunkDoc);

    // Relocate all root nodes from newly added scenes into the merged default scene
    const newScenes = mergedDoc.getRoot().listScenes().filter((s) => !oldScenes.has(s));
    for (const scene of newScenes) {
      if (scene === mergedScene) continue;
      for (const node of scene.listChildren()) {
        mergedScene.addChild(node);
      }
      scene.dispose();
    }
  }

  // Consolidate buffers to avoid "GLB must have 0-1 buffers" error
  const buffers = mergedDoc.getRoot().listBuffers();
  if (buffers.length > 1) {
    const primaryBuffer = buffers[0] || mergedDoc.createBuffer();
    for (const accessor of mergedDoc.getRoot().listAccessors()) {
      accessor.setBuffer(primaryBuffer);
    }
    for (let i = 1; i < buffers.length; i++) {
      buffers[i]!.dispose();
    }
  } else if (buffers.length === 0) {
    mergedDoc.createBuffer();
  }

  // Write merged GLB file
  const outBinary = await io.writeBinary(mergedDoc);
  await fs.promises.writeFile(outputPath, outBinary);

  // Compute stats of the merged document
  const root = mergedDoc.getRoot();
  const nodes = root.listNodes();
  const meshes = root.listMeshes();
  const materials = root.listMaterials();

  const primitives = meshes.flatMap((mesh) =>
    mesh.listPrimitives().map((prim) => ({
      mode: prim.getMode(),
      count: prim.getIndices()?.getCount() ?? prim.getAttribute("POSITION")?.getCount() ?? 0,
    }))
  );

  const mergedTriangleCount = primitives.reduce((sum, prim) => sum + triangleCount(prim.mode, prim.count), 0);

  const allExtras = [
    ...nodes.map((n) => n.getExtras()),
    ...meshes.map((m) => m.getExtras()),
    ...materials.map((mat) => mat.getExtras()),
    ...meshes.flatMap((mesh) => mesh.listPrimitives().map((prim) => prim.getExtras())),
  ];

  const stableObjectIds = collectIds(allExtras, "stableObjectId");
  const selectableIds = collectIds(allExtras, "selectableId");

  const sceneBounds = getBounds(mergedScene);

  return {
    mergedNodeCount: nodes.length,
    mergedTriangleCount,
    mergedMaterialCount: materials.length,
    stableObjectIds,
    selectableIds,
    bounds: {
      min: Array.from(sceneBounds.min),
      max: Array.from(sceneBounds.max),
    },
  };
}

export type ValidationReport = {
  passed: boolean;
  errors: string[];
  warnings: string[];
  metrics: {
    expectedNodes: number;
    actualNodes: number;
    expectedTriangles: number;
    actualTriangles: number;
    expectedMaterials: number;
    actualMaterials: number;
  };
};

/**
 * Validates the merged GLB output against the original chunk GLBs.
 */
export async function validateMergedGlb(
  chunkPaths: string[],
  mergedGlbPath: string
): Promise<ValidationReport> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Verify files exist
  for (const chunkPath of chunkPaths) {
    if (!fs.existsSync(chunkPath)) {
      errors.push(`Chunk GLB not found: ${chunkPath}`);
    }
  }

  if (!fs.existsSync(mergedGlbPath)) {
    errors.push(`Merged GLB not found: ${mergedGlbPath}`);
    return {
      passed: false,
      errors,
      warnings,
      metrics: { expectedNodes: 0, actualNodes: 0, expectedTriangles: 0, actualTriangles: 0, expectedMaterials: 0, actualMaterials: 0 },
    };
  }

  // 2. Read merged GLB
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  let mergedDoc: Document;
  try {
    mergedDoc = await io.read(mergedGlbPath);
  } catch (e: any) {
    errors.push(`Failed to read merged GLB: ${e.message}`);
    return {
      passed: false,
      errors,
      warnings,
      metrics: { expectedNodes: 0, actualNodes: 0, expectedTriangles: 0, actualTriangles: 0, expectedMaterials: 0, actualMaterials: 0 },
    };
  }

  // 3. Scan chunk GLBs to aggregate expected metrics
  let expectedNodes = 0;
  let expectedTriangles = 0;
  let expectedMaterialsSet = new Set<string>();
  const chunkRootNodeNames = new Set<string>();
  const expectedStableIds: string[] = [];
  const expectedSelectableIds: string[] = [];

  for (const chunkPath of chunkPaths) {
    try {
      const chunkDoc = await io.read(chunkPath);
      const root = chunkDoc.getRoot();
      const nodes = root.listNodes();
      const meshes = root.listMeshes();
      const materials = root.listMaterials();

      // Collect root nodes
      const scenes = root.listScenes();
      for (const scene of scenes) {
        for (const child of scene.listChildren()) {
          chunkRootNodeNames.add(child.getName());
        }
      }

      expectedNodes += nodes.length;
      
      const prims = meshes.flatMap((mesh) =>
        mesh.listPrimitives().map((prim) => ({
          mode: prim.getMode(),
          count: prim.getIndices()?.getCount() ?? prim.getAttribute("POSITION")?.getCount() ?? 0,
        }))
      );
      expectedTriangles += prims.reduce((sum, prim) => sum + triangleCount(prim.mode, prim.count), 0);

      for (const mat of materials) {
        // Approximate uniquely identified materials
        const name = mat.getName() || "unnamed";
        const color = JSON.stringify(mat.getBaseColorFactor());
        expectedMaterialsSet.add(`${name}-${color}`);
      }

      const extras = [
        ...nodes.map((n) => n.getExtras()),
        ...meshes.map((m) => m.getExtras()),
        ...materials.map((mat) => mat.getExtras()),
        ...meshes.flatMap((mesh) => mesh.listPrimitives().map((prim) => prim.getExtras())),
      ];
      expectedStableIds.push(...collectIds(extras, "stableObjectId"));
      expectedSelectableIds.push(...collectIds(extras, "selectableId"));
    } catch (e: any) {
      errors.push(`Failed to read chunk GLB ${chunkPath}: ${e.message}`);
    }
  }

  expectedStableIds.sort();
  expectedSelectableIds.sort();

  // 4. Extract merged GLB metrics
  const mergedRoot = mergedDoc.getRoot();
  const mergedNodes = mergedRoot.listNodes();
  const mergedMeshes = mergedRoot.listMeshes();
  const mergedMaterials = mergedRoot.listMaterials();

  const mergedPrims = mergedMeshes.flatMap((mesh) =>
    mesh.listPrimitives().map((prim) => ({
      mode: prim.getMode(),
      count: prim.getIndices()?.getCount() ?? prim.getAttribute("POSITION")?.getCount() ?? 0,
    }))
  );
  const actualTriangles = mergedPrims.reduce((sum, prim) => sum + triangleCount(prim.mode, prim.count), 0);

  const mergedExtras = [
    ...mergedNodes.map((n) => n.getExtras()),
    ...mergedMeshes.map((m) => m.getExtras()),
    ...mergedMaterials.map((mat) => mat.getExtras()),
    ...mergedMeshes.flatMap((mesh) => mesh.listPrimitives().map((prim) => prim.getExtras())),
  ];
  const actualStableIds = collectIds(mergedExtras, "stableObjectId");
  const actualSelectableIds = collectIds(mergedExtras, "selectableId");

  // 5. Run gates
  const actualNodes = mergedNodes.length;
  if (actualNodes !== expectedNodes) {
    errors.push(`Node count mismatch: expected ${expectedNodes}, got ${actualNodes}`);
  }

  if (actualTriangles !== expectedTriangles) {
    errors.push(`Triangle count mismatch: expected ${expectedTriangles}, got ${actualTriangles}`);
  }

  // Material count sanity: should be no more than sum of inputs, and ideally equal or deduplicated by reference
  const actualMaterials = mergedMaterials.length;
  if (actualMaterials > expectedMaterialsSet.size) {
    warnings.push(`Material count (${actualMaterials}) exceeds expected unique materials count (${expectedMaterialsSet.size})`);
  }

  // Bounding box sanity check
  const mergedScenes = mergedRoot.listScenes();
  if (mergedScenes.length === 0) {
    errors.push("Merged GLB contains no scenes.");
  } else {
    const sceneBounds = getBounds(mergedScenes[0]!);
    if (!Number.isFinite(sceneBounds.min[0]) || !Number.isFinite(sceneBounds.max[0])) {
      errors.push("Merged GLB bounding box contains invalid bounds.");
    }
  }

  // Root coverage check: check that all root node names from chunks exist as roots in merged scene
  if (mergedScenes.length > 0) {
    const mergedRoots = new Set(mergedScenes[0]!.listChildren().map((n) => n.getName()));
    for (const name of chunkRootNodeNames) {
      if (!mergedRoots.has(name)) {
        errors.push(`Missing chunk root node in merged scene: ${name}`);
      }
    }
  }

  // ID survivability and duplicates
  if (JSON.stringify(actualStableIds) !== JSON.stringify(expectedStableIds)) {
    errors.push("stableObjectId list does not match chunks.");
  }
  if (JSON.stringify(actualSelectableIds) !== JSON.stringify(expectedSelectableIds)) {
    errors.push("selectableId list does not match chunks.");
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    metrics: {
      expectedNodes,
      actualNodes,
      expectedTriangles,
      actualTriangles,
      expectedMaterials: expectedMaterialsSet.size,
      actualMaterials,
    },
  };
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
      if (entryKey === key && (typeof entryValue === "string" || typeof entryValue === "number")) {
        found.push(String(entryValue));
      }
      visit(entryValue);
    }
  };
  values.forEach(visit);
  return found.sort();
}
