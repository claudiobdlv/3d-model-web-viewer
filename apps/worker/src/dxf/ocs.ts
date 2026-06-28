import type { DxfExtrusion } from "./types.js";

const DEFAULT_EXTRUSION: DxfExtrusion = [0, 0, 1];
const EPSILON = 1e-12;

export function defaultExtrusion(): DxfExtrusion {
  return [...DEFAULT_EXTRUSION];
}

export function isDefaultExtrusion(extrusion: DxfExtrusion): boolean {
  const normal = normalizeExtrusion(extrusion);
  return Math.abs(normal[0]) < EPSILON && Math.abs(normal[1]) < EPSILON && Math.abs(normal[2] - 1) < EPSILON;
}

export function normalizeExtrusion(extrusion: DxfExtrusion): DxfExtrusion {
  const length = Math.hypot(extrusion[0], extrusion[1], extrusion[2]);
  if (length < EPSILON) return [...DEFAULT_EXTRUSION];
  return [extrusion[0] / length, extrusion[1] / length, extrusion[2] / length];
}

// AutoCAD arbitrary-axis algorithm. Converts an OCS point into WCS.
export function ocsToWcs(point: [number, number, number], extrusion: DxfExtrusion): [number, number, number] {
  const [xAxis, yAxis, normal] = ocsAxes(extrusion);
  const [nx, ny, nz] = normal;
  return [
    point[0] * xAxis[0] + point[1] * yAxis[0] + point[2] * nx,
    point[0] * xAxis[1] + point[1] * yAxis[1] + point[2] * ny,
    point[0] * xAxis[2] + point[1] * yAxis[2] + point[2] * nz,
  ];
}

export function ocsAxes(extrusion: DxfExtrusion): [DxfExtrusion, DxfExtrusion, DxfExtrusion] {
  const normal = normalizeExtrusion(extrusion);
  const [nx, ny, nz] = normal;
  const xAxis: DxfExtrusion = Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64
    ? normalizeExtrusion([nz, 0, -nx])
    : normalizeExtrusion([-ny, nx, 0]);
  const yAxis: DxfExtrusion = [
    ny * xAxis[2] - nz * xAxis[1],
    nz * xAxis[0] - nx * xAxis[2],
    nx * xAxis[1] - ny * xAxis[0],
  ];
  return [xAxis, yAxis, normal];
}
