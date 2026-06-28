// FormatIQ DXF — GLB builder using @gltf-transform/core
// Produces a valid GLB from processed DXF scene data.
import { Document, NodeIO, type Mesh, type Material } from "@gltf-transform/core";
import type { ParsedDxf, MaterialGroup } from "./types.js";
import { extractAllTriangles } from "./geometry.js";
import { optimizeMesh } from "./meshOptimize.js";
import { insertRotationQuaternion } from "./blocks.js";
import { resolveColor } from "./colors.js";

export type BuildGlbResult = {
  glbBytes: Uint8Array;
  nodeCount: number;
  materialCount: number;
  triangleCount: number;
  materials: { layer: string; colorHex: string; rgb: [number, number, number] }[];
};

export async function buildGlb(parsedDxf: ParsedDxf): Promise<BuildGlbResult> {
  const doc = new Document();
  const buf = doc.createBuffer();
  const scene = doc.createScene("DXF Scene");
  const root = doc.createNode("DXF Model").setExtras({ sourceFormat: "dxf" });
  scene.addChild(root);

  // ── Material cache (shared across meshes) ──────────────────────────────────
  const materialCache = new Map<string, Material>();

  function getOrCreateMaterial(layer: string, colorHex: string, rgb: [number, number, number]): Material {
    const key = `${layer}|${colorHex}`;
    let mat = materialCache.get(key);
    if (!mat) {
      const r = rgb[0] / 255;
      const g = rgb[1] / 255;
      const b = rgb[2] / 255;
      mat = doc
        .createMaterial(`Layer:${layer}${colorHex}`)
        .setBaseColorFactor([r, g, b, 1.0])
        .setMetallicFactor(0)
        .setRoughnessFactor(0.8)
        .setExtras({ colorSource: "dxf", layer });
      materialCache.set(key, mat);
    }
    return mat;
  }

  // ── Build a GLB Mesh from a list of MaterialGroups ─────────────────────────
  function buildMeshFromGroups(name: string, groups: MaterialGroup[]): Mesh | null {
    if (groups.length === 0) return null;
    const mesh = doc.createMesh(name);
    for (const group of groups) {
      const posAcc = doc
        .createAccessor()
        .setType("VEC3")
        .setArray(group.positions)
        .setBuffer(buf);
      const normAcc = doc
        .createAccessor()
        .setType("VEC3")
        .setArray(group.normals)
        .setBuffer(buf);
      const mat = getOrCreateMaterial(group.layer, group.colorHex, group.rgb);
      const prim = doc
        .createPrimitive()
        .setAttribute("POSITION", posAcc)
        .setAttribute("NORMAL", normAcc)
        .setMaterial(mat)
        .setExtras({ layer: group.layer, colorHex: group.colorHex });
      mesh.addPrimitive(prim);
    }
    return mesh;
  }

  let nodeCount = 0;
  let totalTriangleCount = 0;

  // ── Block definitions: build one Mesh per named block ─────────────────────
  const blockMeshes = new Map<string, Mesh>();

  function blockMeshForInsert(blockName: string, insertColor: ReturnType<typeof resolveColor>): Mesh | null {
    const block = parsedDxf.blocks[blockName];
    if (!block) return null;
    const hasByBlock = block.supported.some((entity) => entity.color.source === "byblock");
    const cacheKey = hasByBlock ? `${blockName}|${insertColor.hex}` : blockName;
    const cached = blockMeshes.get(cacheKey);
    if (cached) return cached;
    const blockTriangles = extractAllTriangles(block.supported, insertColor);
    if (blockTriangles.length === 0) return null;
    const { groups } = optimizeMesh(blockTriangles);
    const mesh = buildMeshFromGroups(`Block:${blockName}${hasByBlock ? `:${insertColor.hex}` : ""}`, groups);
    if (mesh) blockMeshes.set(cacheKey, mesh);
    return mesh;
  }

  // ── INSERT instances ───────────────────────────────────────────────────────
  let insertIndex = 0;
  for (const insert of parsedDxf.entities.inserts) {
    const insertColor = resolveColor(insert.colorIndex, insert.trueColor, insert.layer, parsedDxf.layers);
    const mesh = blockMeshForInsert(insert.blockName, insertColor);
    if (!mesh) {
      // Unknown or empty block — skip silently
      insertIndex++;
      continue;
    }

    const rotation = insertRotationQuaternion(insert.rotation, insert.extrusion);
    const handle = insert.handle ?? `INSERT_${insertIndex}`;
    const nodeName = `${insert.blockName}_${insertIndex}`;

    const node = doc
      .createNode(nodeName)
      .setMesh(mesh)
      .setTranslation(insert.position)
      .setScale(insert.scale)
      .setRotation(rotation)
      .setExtras({
        stableObjectId: handle,
        displayName: insert.blockName,
        sourceFormat: "dxf",
        entityType: "INSERT",
        entityHandle: handle,
        layer: insert.layer,
        blockName: insert.blockName,
        insertName: insert.blockName,
        extrusion: insert.extrusion,
        ocsApplied: insert.ocsApplied,
        byBlockColor: insertColor.hex,
      });

    root.addChild(node);
    nodeCount++;

    // Accumulate triangle count for each block insert
    const block = parsedDxf.blocks[insert.blockName];
    if (block) {
      totalTriangleCount += block.triangleCount;
    }

    insertIndex++;
  }

  // ── Ungrouped entities (3DFACE / POLYFACE_MESH directly in ENTITIES) ──────
  const entityTriangles = extractAllTriangles(parsedDxf.entities.supported);
  if (entityTriangles.length > 0) {
    const { groups } = optimizeMesh(entityTriangles);
    const mesh = buildMeshFromGroups("ungrouped", groups);
    if (mesh) {
      const ungroupedNode = doc
        .createNode("ungrouped")
        .setMesh(mesh)
        .setExtras({ sourceFormat: "dxf", entityType: "ungrouped" });
      root.addChild(ungroupedNode);
      nodeCount++;
      for (const group of groups) {
        totalTriangleCount += group.triangleCount;
      }
    }
  }

  // ── Serialize ──────────────────────────────────────────────────────────────
  const io = new NodeIO();
  const glbBytes = await io.writeBinary(doc);

  return {
    glbBytes,
    nodeCount,
    materialCount: materialCache.size,
    triangleCount: totalTriangleCount,
    materials: [...materialCache.entries()].map(([key, material]) => {
      const separator = key.lastIndexOf("|");
      const factor = material.getBaseColorFactor();
      return {
        layer: key.slice(0, separator),
        colorHex: key.slice(separator + 1),
        rgb: [Math.round(factor[0] * 255), Math.round(factor[1] * 255), Math.round(factor[2] * 255)],
      };
    }),
  };
}
