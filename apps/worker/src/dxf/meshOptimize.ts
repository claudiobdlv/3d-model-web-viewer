// FormatIQ DXF — mesh optimization pipeline
// Vertex welding, degenerate removal, flat normal generation, material grouping
import type { Triangle, MaterialGroup, OptimizationStats } from "./types.js";

type Vec3 = [number, number, number];

// ─── Vertex welding ───────────────────────────────────────────────────────────
// Snap vertices to a spatial grid and merge coincident ones.
// Only welds within the same material group to avoid corrupting colour boundaries.

class VertexWelding {
  private grid = new Map<string, number>();
  private vertices: Vec3[] = [];

  constructor(private readonly eps: number = 1e-6) {}

  add(v: Vec3): number {
    const key = this.key(v);
    const existing = this.grid.get(key);
    if (existing !== undefined) return existing;
    const idx = this.vertices.length;
    this.vertices.push(v);
    this.grid.set(key, idx);
    return idx;
  }

  getVertices(): Vec3[] {
    return this.vertices;
  }

  private key([x, y, z]: Vec3): string {
    const e = this.eps;
    return `${Math.round(x / e)},${Math.round(y / e)},${Math.round(z / e)}`;
  }
}

// ─── Normal generation ────────────────────────────────────────────────────────
// Flat normals: each triangle's 3 vertices share the face normal.

function cross(
  [ax, ay, az]: Vec3,
  [bx, by, bz]: Vec3
): Vec3 {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

function sub([ax, ay, az]: Vec3, [bx, by, bz]: Vec3): Vec3 {
  return [ax - bx, ay - by, az - bz];
}

function normalize([x, y, z]: Vec3): Vec3 {
  const len = Math.sqrt(x * x + y * y + z * z);
  if (len < 1e-12) return [0, 0, 1];
  return [x / len, y / len, z / len];
}

function faceNormal(v0: Vec3, v1: Vec3, v2: Vec3): Vec3 {
  return normalize(cross(sub(v1, v0), sub(v2, v0)));
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

type RawGroup = {
  materialKey: string;
  layer: string;
  colorHex: string;
  rgb: [number, number, number];
  triangles: [Vec3, Vec3, Vec3][];
};

export function optimizeMesh(triangles: Triangle[]): {
  groups: MaterialGroup[];
  stats: OptimizationStats;
} {
  const rawTriangleCount = triangles.length;
  const rawVertexCount = triangles.length * 3;

  // Group triangles by material key
  const groupMap = new Map<string, RawGroup>();
  for (const tri of triangles) {
    let group = groupMap.get(tri.materialKey);
    if (!group) {
      group = {
        materialKey: tri.materialKey,
        layer: tri.layer,
        colorHex: tri.colorHex,
        rgb: tri.rgb,
        triangles: [],
      };
      groupMap.set(tri.materialKey, group);
    }
    group.triangles.push(tri.v);
  }

  let degenerateTrianglesRemoved = 0;
  let duplicateVerticesWelded = 0;
  let outputTriangleCount = 0;
  let outputVertexCount = 0;

  const groups: MaterialGroup[] = [];

  for (const rawGroup of groupMap.values()) {
    const welder = new VertexWelding(1e-6);
    const positionParts: number[] = [];
    const normalParts: number[] = [];
    let groupTriangleCount = 0;

    for (const [v0, v1, v2] of rawGroup.triangles) {
      // Degenerate check: cross product magnitude < threshold
      const edge1 = sub(v1, v0);
      const edge2 = sub(v2, v0);
      const n = cross(edge1, edge2);
      const area2 = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
      if (area2 < 1e-12) {
        degenerateTrianglesRemoved++;
        continue;
      }

      const [nx, ny, nz] = faceNormal(v0, v1, v2);

      // Weld vertices (per-material group)
      const i0 = welder.add(v0);
      const i1 = welder.add(v1);
      const i2 = welder.add(v2);

      // For flat normals, we de-index: each triangle emits its own 3 vertices
      // (avoids smoothing artefacts on CAD models)
      positionParts.push(v0[0], v0[1], v0[2]);
      positionParts.push(v1[0], v1[1], v1[2]);
      positionParts.push(v2[0], v2[1], v2[2]);
      normalParts.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
      groupTriangleCount++;

      // Count unique vertices welded
      void i0; void i1; void i2;
    }

    const rawGroupVertices = rawGroup.triangles.length * 3;
    const weldedUniqueVertices = welder.getVertices().length;
    duplicateVerticesWelded += rawGroupVertices - weldedUniqueVertices;

    if (groupTriangleCount === 0) continue;

    const triCount = groupTriangleCount;
    const vtxCount = triCount * 3; // de-indexed flat normals

    outputTriangleCount += triCount;
    outputVertexCount += vtxCount;

    groups.push({
      materialKey: rawGroup.materialKey,
      layer: rawGroup.layer,
      colorHex: rawGroup.colorHex,
      rgb: rawGroup.rgb,
      positions: new Float32Array(positionParts),
      normals: new Float32Array(normalParts),
      triangleCount: triCount,
      vertexCount: vtxCount,
    });
  }

  return {
    groups,
    stats: {
      rawTriangleCount,
      rawVertexCount,
      degenerateTrianglesRemoved,
      duplicateVerticesWelded: Math.max(0, duplicateVerticesWelded),
      outputTriangleCount,
      outputVertexCount,
    },
  };
}
