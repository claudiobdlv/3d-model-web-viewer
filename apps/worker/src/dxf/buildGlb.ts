// FormatIQ DXF — recursive GLB builder using @gltf-transform/core.
import { Document, NodeIO, type Material, type Mesh, type Node } from "@gltf-transform/core";
import type {
  DxfBlockReuseStats,
  DxfBlockTraversalSummary,
  DxfInsert,
  MaterialGroup,
  ParsedDxf,
  ResolvedColor,
  Triangle,
} from "./types.js";
import { extractAllTriangles } from "./geometry.js";
import { optimizeMesh } from "./meshOptimize.js";
import { hashBlockGeometry, insertRotationQuaternion } from "./blocks.js";
import { resolveColor } from "./colors.js";
import { analyzeBlockTraversal, DEFAULT_BLOCK_NESTING_LIMIT } from "./blockTraversal.js";
import { expandInsertInstances } from "./insertInstances.js";

export type BuildGlbResult = {
  glbBytes: Uint8Array;
  nodeCount: number;
  materialCount: number;
  triangleCount: number;
  materials: { layer: string; colorHex: string; rgb: [number, number, number] }[];
  traversal: DxfBlockTraversalSummary;
  blockReuse: DxfBlockReuseStats;
};

export type BuildGlbOptions = {
  maxBlockNestingDepth?: number;
  traversal?: DxfBlockTraversalSummary;
};

export async function buildGlb(parsedDxf: ParsedDxf, options: BuildGlbOptions = {}): Promise<BuildGlbResult> {
  const maxDepth = options.maxBlockNestingDepth ?? DEFAULT_BLOCK_NESTING_LIMIT;
  const traversal = options.traversal ?? analyzeBlockTraversal(parsedDxf, maxDepth);
  const doc = new Document();
  const buf = doc.createBuffer();
  const scene = doc.createScene("DXF Scene");
  const root = doc.createNode("DXF Model").setExtras({ sourceFormat: "dxf" });
  scene.addChild(root);

  const materialCache = new Map<string, Material>();
  function getOrCreateMaterial(layer: string, colorHex: string, rgb: [number, number, number]): Material {
    const key = `${layer}|${colorHex}`;
    let material = materialCache.get(key);
    if (!material) {
      material = doc
        .createMaterial(`Layer:${layer}${colorHex}`)
        .setBaseColorFactor([rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1])
        .setMetallicFactor(0)
        .setRoughnessFactor(0.8)
        .setExtras({ colorSource: "dxf", layer });
      materialCache.set(key, material);
    }
    return material;
  }

  function buildMeshFromGroups(name: string, groups: MaterialGroup[]): Mesh | null {
    if (groups.length === 0) return null;
    const mesh = doc.createMesh(name);
    for (const group of groups) {
      const positions = doc.createAccessor().setType("VEC3").setArray(group.positions).setBuffer(buf);
      const normals = doc.createAccessor().setType("VEC3").setArray(group.normals).setBuffer(buf);
      const primitive = doc
        .createPrimitive()
        .setAttribute("POSITION", positions)
        .setAttribute("NORMAL", normals)
        .setMaterial(getOrCreateMaterial(group.layer, group.colorHex, group.rgb))
        .setExtras({ layer: group.layer, colorHex: group.colorHex });
      mesh.addPrimitive(primitive);
    }
    return mesh;
  }

  function offsetTriangles(triangles: Triangle[], origin: [number, number, number]): Triangle[] {
    if (origin[0] === 0 && origin[1] === 0 && origin[2] === 0) return triangles;
    return triangles.map((triangle) => ({
      ...triangle,
      v: triangle.v.map((point) => [
        point[0] - origin[0],
        point[1] - origin[1],
        point[2] - origin[2],
      ]) as Triangle["v"],
    }));
  }

  const directMeshCache = new Map<string, { mesh: Mesh; triangleCount: number }>();
  const blockReuse: DxfBlockReuseStats = {
    uniqueRenderedMeshes: 0,
    reusedBlockMeshCount: 0,
    geometryDuplicationAvoidedTriangles: 0,
  };

  function directBlockMesh(blockName: string, insertColor: ResolvedColor, inheritedLayer: string): { mesh: Mesh; triangleCount: number } | null {
    const block = parsedDxf.blocks[blockName];
    if (!block || block.supported.length === 0) return null;
    const hasByBlock = block.supported.some((entity) => entity.color.source === "byblock");
    const hasLayer0 = block.supported.some((entity) => entity.layer === "0");
    const geometryHash = hashBlockGeometry(block, parsedDxf.layers);
    const cacheKey = `${geometryHash}|origin:${block.origin.join(",")}${hasByBlock ? `|byblock:${insertColor.hex}` : ""}${hasLayer0 ? `|layer0:${inheritedLayer}` : ""}`;
    const cached = directMeshCache.get(cacheKey);
    if (cached) {
      blockReuse.reusedBlockMeshCount++;
      blockReuse.geometryDuplicationAvoidedTriangles += cached.triangleCount;
      return cached;
    }

    const triangles = offsetTriangles(
      extractAllTriangles(block.supported, insertColor, inheritedLayer, parsedDxf.layers),
      block.origin
    );
    if (triangles.length === 0) return null;
    const { groups } = optimizeMesh(triangles);
    const mesh = buildMeshFromGroups(`Block:${blockName}${hasByBlock ? `:${insertColor.hex}` : ""}`, groups);
    if (!mesh) return null;
    const entry = { mesh, triangleCount: groups.reduce((sum, group) => sum + group.triangleCount, 0) };
    directMeshCache.set(cacheKey, entry);
    blockReuse.uniqueRenderedMeshes++;
    return entry;
  }

  let nodeCount = 0;
  let totalTriangleCount = 0;

  function addInsertNode(
    parent: Node,
    insert: DxfInsert,
    depth: number,
    stack: string[],
    inheritedColor: ResolvedColor | undefined,
    inheritedLayer: string | undefined,
    parentBlockOrigin: [number, number, number],
    indexPath: number[],
    instancePosition: [number, number, number],
    rowIndex: number,
    columnIndex: number
  ): void {
    if (depth > maxDepth || stack.includes(insert.blockName)) return;
    const block = parsedDxf.blocks[insert.blockName];
    if (!block) return;

    const effectiveInsertLayer = insert.layer === "0" && inheritedLayer ? inheritedLayer : insert.layer;
    const insertColor = resolveColor(
      insert.colorIndex,
      insert.trueColor,
      effectiveInsertLayer,
      parsedDxf.layers,
      inheritedColor
    );
    const handle = insert.handle ?? `INSERT_${indexPath.join("_")}`;
    const arraySuffix = insert.type === "MINSERT" ? `@r${rowIndex}c${columnIndex}` : "";
    const stableObjectId = depth === 1 ? `${handle}${arraySuffix}` : `${handle}${arraySuffix}@${indexPath.join(".")}`;
    const translation: [number, number, number] = [
      instancePosition[0] - parentBlockOrigin[0],
      instancePosition[1] - parentBlockOrigin[1],
      instancePosition[2] - parentBlockOrigin[2],
    ];
    const node = doc
      .createNode(`${insert.blockName}_${indexPath.join("_")}`)
      .setTranslation(translation)
      .setScale(insert.scale)
      .setRotation(insertRotationQuaternion(insert.rotation, insert.extrusion))
      .setExtras({
        stableObjectId,
        displayName: insert.blockName,
        sourceFormat: "dxf",
        entityType: insert.type,
        sourceEntityType: insert.type,
        entityHandle: handle,
        originalHandle: insert.handle,
        layer: effectiveInsertLayer,
        sourceLayer: insert.layer,
        layer0Inherited: insert.layer === "0" && effectiveInsertLayer !== "0",
        blockName: insert.blockName,
        insertName: insert.blockName,
        blockPath: [...stack, insert.blockName],
        nestingDepth: depth,
        parentBlockName: stack.at(-1) ?? null,
        extrusion: insert.extrusion,
        ocsApplied: insert.ocsApplied,
        byBlockColor: insertColor.hex,
        rowIndex,
        columnIndex,
        rowCount: insert.rowCount,
        columnCount: insert.columnCount,
      });
    parent.addChild(node);
    nodeCount++;

    const direct = directBlockMesh(insert.blockName, insertColor, effectiveInsertLayer);
    if (direct) {
      node.setMesh(direct.mesh);
      totalTriangleCount += direct.triangleCount;
    }

    const nextStack = [...stack, insert.blockName];
    block.inserts.forEach((nestedInsert, nestedIndex) => {
      addInsertSource(node, nestedInsert, depth + 1, nextStack, insertColor, effectiveInsertLayer, block.origin, [...indexPath, nestedIndex]);
    });
  }

  function addInsertSource(
    parent: Node,
    insert: DxfInsert,
    depth: number,
    stack: string[],
    inheritedColor: ResolvedColor | undefined,
    inheritedLayer: string | undefined,
    parentBlockOrigin: [number, number, number],
    indexPath: number[]
  ): void {
    for (const instance of expandInsertInstances(insert)) {
      const instancePath = insert.type === "MINSERT"
        ? [...indexPath, instance.rowIndex, instance.columnIndex]
        : indexPath;
      addInsertNode(
        parent,
        insert,
        depth,
        stack,
        inheritedColor,
        inheritedLayer,
        parentBlockOrigin,
        instancePath,
        instance.position,
        instance.rowIndex,
        instance.columnIndex
      );
    }
  }

  parsedDxf.entities.inserts.forEach((insert, index) => {
    addInsertSource(root, insert, 1, [], undefined, undefined, [0, 0, 0], [index]);
  });

  const entityTriangles = extractAllTriangles(parsedDxf.entities.supported);
  if (entityTriangles.length > 0) {
    const { groups } = optimizeMesh(entityTriangles);
    const mesh = buildMeshFromGroups("ungrouped", groups);
    if (mesh) {
      root.addChild(
        doc.createNode("ungrouped").setMesh(mesh).setExtras({ sourceFormat: "dxf", entityType: "ungrouped" })
      );
      nodeCount++;
      totalTriangleCount += groups.reduce((sum, group) => sum + group.triangleCount, 0);
    }
  }

  const glbBytes = await new NodeIO().writeBinary(doc);
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
    traversal,
    blockReuse,
  };
}
