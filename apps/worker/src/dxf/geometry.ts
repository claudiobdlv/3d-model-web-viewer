// FormatIQ DXF — triangle extraction from parsed entities
import type { DxfSupportedEntity, Triangle, Dxf3DFace, DxfPolyfaceMesh, ResolvedColor } from "./types.js";
import { materialKey, resolveColor } from "./colors.js";

function mkTriangle(
  v0: [number, number, number],
  v1: [number, number, number],
  v2: [number, number, number],
  layer: string,
  colorHex: string,
  rgb: [number, number, number]
): Triangle {
  return {
    v: [v0, v1, v2],
    materialKey: materialKey(layer, colorHex),
    layer,
    colorHex,
    rgb,
  };
}

function effectiveColor(entity: Dxf3DFace | DxfPolyfaceMesh, inheritedByBlockColor?: ResolvedColor): ResolvedColor {
  return entity.color.source === "byblock" && inheritedByBlockColor
    ? resolveColor(0, null, entity.layer, {}, inheritedByBlockColor)
    : entity.color;
}

function extract3DFace(entity: Dxf3DFace, inheritedByBlockColor?: ResolvedColor): Triangle[] {
  const { v0, v1, v2, v3, isTriangle, layer } = entity;
  const color = effectiveColor(entity, inheritedByBlockColor);
  const { hex: colorHex, rgb } = color;
  const tris: Triangle[] = [];
  tris.push(mkTriangle(v0, v1, v2, layer, colorHex, rgb));
  if (!isTriangle) {
    // quad: split into two triangles preserving winding
    tris.push(mkTriangle(v0, v2, v3, layer, colorHex, rgb));
  }
  return tris;
}

function extractPolyface(entity: DxfPolyfaceMesh, inheritedByBlockColor?: ResolvedColor): Triangle[] {
  const { positions, faceRecords, layer } = entity;
  const color = effectiveColor(entity, inheritedByBlockColor);
  const { hex: colorHex, rgb } = color;
  const tris: Triangle[] = [];

  for (const f of faceRecords) {
    const has0 = Math.abs(f.i71) > 0;
    const has1 = Math.abs(f.i72) > 0;
    const has2 = Math.abs(f.i73) > 0;
    const has3 = Math.abs(f.i74) > 0;

    if (!has0 || !has1 || !has2) continue;

    // 1-based indices; negative = hidden edge (still valid vertex)
    const iA = Math.abs(f.i71) - 1;
    const iB = Math.abs(f.i72) - 1;
    const iC = Math.abs(f.i73) - 1;

    const pA = positions[iA];
    const pB = positions[iB];
    const pC = positions[iC];

    if (!pA || !pB || !pC) continue;

    tris.push(mkTriangle(pA, pB, pC, layer, colorHex, rgb));

    if (has3) {
      const iD = Math.abs(f.i74) - 1;
      const pD = positions[iD];
      if (pD) {
        tris.push(mkTriangle(pA, pC, pD, layer, colorHex, rgb));
      }
    }
  }

  return tris;
}

// Extract triangles from a single supported entity.
// MESH entities are detected but not triangulated — return empty.
export function extractTrianglesFromEntity(entity: DxfSupportedEntity, inheritedByBlockColor?: ResolvedColor): Triangle[] {
  switch (entity.type) {
    case "3DFACE":
      return extract3DFace(entity, inheritedByBlockColor);
    case "POLYFACE_MESH":
    case "POLYMESH":
      return extractPolyface(entity as DxfPolyfaceMesh, inheritedByBlockColor);
    case "MESH":
      // MESH (R2010+) not fully triangulated in Phase 2A — detected and reported
      return [];
    default:
      return [];
  }
}

// Extract all triangles from a list of entities.
export function extractAllTriangles(entities: DxfSupportedEntity[], inheritedByBlockColor?: ResolvedColor): Triangle[] {
  const result: Triangle[] = [];
  for (const entity of entities) {
    result.push(...extractTrianglesFromEntity(entity, inheritedByBlockColor));
  }
  return result;
}
