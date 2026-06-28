// FormatIQ DXF — block definition cache and instance transform helpers
import crypto from "node:crypto";
import type { DxfBlock, DxfLayer, Triangle } from "./types.js";
import { extractAllTriangles } from "./geometry.js";
import { defaultExtrusion, isDefaultExtrusion, ocsAxes } from "./ocs.js";
import type { DxfExtrusion } from "./types.js";

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
  rotationDeg: number,
  extrusion: DxfExtrusion = defaultExtrusion()
): [number, number, number, number] {
  const rad = (rotationDeg * Math.PI) / 180;
  const half = rad / 2;
  const localZ: [number, number, number, number] = [0, 0, Math.sin(half), Math.cos(half)];
  if (isDefaultExtrusion(extrusion)) return localZ;

  const [x, y, z] = ocsAxes(extrusion);
  const basis = quaternionFromRotationMatrix([
    x[0], y[0], z[0],
    x[1], y[1], z[1],
    x[2], y[2], z[2],
  ]);
  return multiplyQuaternions(basis, localZ);
}

function multiplyQuaternions(a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function quaternionFromRotationMatrix(m: number[]): [number, number, number, number] {
  const trace = m[0]! + m[4]! + m[8]!;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s; x = (m[7]! - m[5]!) / s; y = (m[2]! - m[6]!) / s; z = (m[3]! - m[1]!) / s;
  } else if (m[0]! > m[4]! && m[0]! > m[8]!) {
    const s = Math.sqrt(1 + m[0]! - m[4]! - m[8]!) * 2;
    w = (m[7]! - m[5]!) / s; x = 0.25 * s; y = (m[1]! + m[3]!) / s; z = (m[2]! + m[6]!) / s;
  } else if (m[4]! > m[8]!) {
    const s = Math.sqrt(1 + m[4]! - m[0]! - m[8]!) * 2;
    w = (m[2]! - m[6]!) / s; x = (m[1]! + m[3]!) / s; y = 0.25 * s; z = (m[5]! + m[7]!) / s;
  } else {
    const s = Math.sqrt(1 + m[8]! - m[0]! - m[4]!) * 2;
    w = (m[3]! - m[1]!) / s; x = (m[2]! + m[6]!) / s; y = (m[5]! + m[7]!) / s; z = 0.25 * s;
  }
  return [x, y, z, w];
}
