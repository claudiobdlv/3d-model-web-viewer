// FormatIQ DXF — block definition cache and instance transform helpers
import crypto from "node:crypto";
import type { DxfBlock, DxfLayer, Triangle } from "./types.js";
import { extractAllTriangles } from "./geometry.js";

// Compute a stable hash of a block definition's geometry for deduplication.
// Uses sorted triangle data so orientation-equivalent blocks may collide,
// but in practice block names serve as the primary cache key in Phase 2A.
export function hashBlockGeometry(
  block: DxfBlock,
  _layers: Record<string, DxfLayer>
): string {
  const triangles: Triangle[] = extractAllTriangles(block.supported);
  if (triangles.length === 0) return crypto.createHash("sha256").update("empty").digest("hex");

  const rows = triangles.map((t) => {
    const pts = t.v.flat().map((n) => n.toFixed(6)).join(",");
    return `${pts}|${t.materialKey}`;
  });
  rows.sort();
  return crypto.createHash("sha256").update(rows.join("\n")).digest("hex");
}

// Compute the quaternion for a Z-axis rotation (DXF INSERT rotation is in degrees).
export function insertRotationQuaternion(
  rotationDeg: number
): [number, number, number, number] {
  const rad = (rotationDeg * Math.PI) / 180;
  const half = rad / 2;
  return [0, 0, Math.sin(half), Math.cos(half)];
}
