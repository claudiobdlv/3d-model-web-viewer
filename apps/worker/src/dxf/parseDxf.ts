// FormatIQ DXF — production-quality ASCII DXF parser (TypeScript)
// Supports: 3DFACE, POLYFACE_MESH, POLYMESH, level-0 MESH,
//           INSERT/MINSERT, BLOCK/ENDBLK, LAYER table
// Detects and rejects: 3DSOLID, BODY, REGION (ACIS)
import fs from "node:fs";
import type {
  DxfToken, DxfLayer, DxfBlock, DxfInsert, DxfAcisEntity,
  DxfSupportedEntity, Dxf3DFace, DxfPolyfaceMesh, DxfMeshEntity,
  ParsedDxf, DxfFaceRecord, DxfEntityDiagnostics,
} from "./types.js";
import { resolveColor } from "./colors.js";
import { defaultExtrusion, isDefaultExtrusion, ocsToWcs } from "./ocs.js";

// ─── Tokenizer ────────────────────────────────────────────────────────────────

function tokenize(text: string): DxfToken[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const tokens: DxfToken[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i]!.trim(), 10);
    if (!isNaN(code)) {
      tokens.push({ code, value: lines[i + 1]!.trimEnd() });
    }
  }
  return tokens;
}

// ─── Section Splitter ─────────────────────────────────────────────────────────

function splitSections(tokens: DxfToken[]): Record<string, DxfToken[]> {
  const sections: Record<string, DxfToken[]> = {};
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i]!.code === 0 && tokens[i]!.value === "SECTION") {
      i++;
      if (i < tokens.length && tokens[i]!.code === 2) {
        const name = tokens[i]!.value;
        i++;
        const start = i;
        while (i < tokens.length && !(tokens[i]!.code === 0 && tokens[i]!.value === "ENDSEC")) i++;
        sections[name] = tokens.slice(start, i);
        i++; // skip ENDSEC
        continue;
      }
    }
    i++;
  }
  return sections;
}

const curveOrWireTypes = new Set([
  "ARC", "CIRCLE", "ELLIPSE", "HELIX", "LINE", "LWPOLYLINE", "POLYLINE_2D", "RAY", "SPLINE", "XLINE",
]);
const surfaceTypes = new Set([
  "EXTRUDEDSURFACE", "LOFTEDSURFACE", "NURBSURFACE", "PLANESURFACE", "REVOLVEDSURFACE", "SURFACE", "SWEPTSURFACE",
]);
const structuralEntityTypes = new Set(["3DFACE", "3DSOLID", "BODY", "INSERT", "MESH", "REGION", "SEQEND", "VERTEX"]);

type RawEntityInspection = {
  entityTypeCounts: Record<string, number>;
  unsupportedEntitySummary: Record<string, number>;
  unsupportedEntitiesWithCoordinates: Record<string, number>;
  unsupportedEntitiesWithNonZeroZ: Record<string, number>;
  polylineFlagDistribution: Record<string, number>;
  vertexFlagDistribution: Record<string, number>;
  curveOrWireEntityCount: number;
  surfaceEntityCount: number;
  proxyEntityCount: number;
  otherEntityCount: number;
};

function increment(summary: Record<string, number>, key: string): void {
  summary[key] = (summary[key] ?? 0) + 1;
}

function mergeSummaries(...summaries: Record<string, number>[]): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const summary of summaries) {
    for (const [key, count] of Object.entries(summary)) merged[key] = (merged[key] ?? 0) + count;
  }
  return merged;
}

function inspectRawEntities(tokens: DxfToken[], blockSection: boolean): RawEntityInspection {
  const result: RawEntityInspection = {
    entityTypeCounts: {}, unsupportedEntitySummary: {}, unsupportedEntitiesWithCoordinates: {},
    unsupportedEntitiesWithNonZeroZ: {}, polylineFlagDistribution: {}, vertexFlagDistribution: {},
    curveOrWireEntityCount: 0, surfaceEntityCount: 0, proxyEntityCount: 0, otherEntityCount: 0,
  };
  let insideBlock = !blockSection;

  for (let i = 0; i < tokens.length;) {
    if (tokens[i]!.code !== 0) { i++; continue; }
    const rawType = tokens[i]!.value;
    if (blockSection && rawType === "BLOCK") { insideBlock = true; i++; continue; }
    if (blockSection && rawType === "ENDBLK") { insideBlock = false; i++; continue; }
    if (!insideBlock || rawType === "ENDSEC" || rawType === "EOF") { i++; continue; }

    let j = i + 1;
    let flags = 0;
    let hasCoordinates = false;
    let hasNonZeroZ = false;
    while (j < tokens.length && tokens[j]!.code !== 0) {
      const { code, value } = tokens[j]!;
      if (code === 70) flags = Number.parseInt(value, 10) || 0;
      if ((code >= 10 && code <= 18) || (code >= 20 && code <= 28)) hasCoordinates = true;
      if (code >= 30 && code <= 38 && Math.abs(Number.parseFloat(value) || 0) > 1e-12) hasNonZeroZ = true;
      j++;
    }

    if (rawType !== "SEQEND") increment(result.entityTypeCounts, rawType);
    if (rawType === "POLYLINE") increment(result.polylineFlagDistribution, String(flags));
    if (rawType === "VERTEX") increment(result.vertexFlagDistribution, String(flags));

    const diagnosticType = rawType === "POLYLINE" && !(flags & 16) && !(flags & 64) ? "POLYLINE_2D" : rawType;
    const isProxy = diagnosticType.includes("PROXY");
    const isUnsupported = !structuralEntityTypes.has(rawType) && !(rawType === "POLYLINE" && ((flags & 16) || (flags & 64)));
    if (isUnsupported) {
      increment(result.unsupportedEntitySummary, diagnosticType);
      if (hasCoordinates) increment(result.unsupportedEntitiesWithCoordinates, diagnosticType);
      if (hasNonZeroZ) increment(result.unsupportedEntitiesWithNonZeroZ, diagnosticType);
      if (curveOrWireTypes.has(diagnosticType)) result.curveOrWireEntityCount++;
      else if (surfaceTypes.has(diagnosticType)) result.surfaceEntityCount++;
      else if (isProxy) result.proxyEntityCount++;
      else result.otherEntityCount++;
    }
    i = j;
  }
  return result;
}

function buildEntityDiagnostics(sections: Record<string, DxfToken[]>): DxfEntityDiagnostics {
  const top = inspectRawEntities(sections["ENTITIES"] ?? [], false);
  const block = inspectRawEntities(sections["BLOCKS"] ?? [], true);
  const unsupportedEntitySummary = mergeSummaries(top.unsupportedEntitySummary, block.unsupportedEntitySummary);
  const topLevelEntityCount = Object.values(top.unsupportedEntitySummary).reduce((sum, count) => sum + count, 0);
  const blockEntityCount = Object.values(block.unsupportedEntitySummary).reduce((sum, count) => sum + count, 0);
  const nonZeroZ = mergeSummaries(top.unsupportedEntitiesWithNonZeroZ, block.unsupportedEntitiesWithNonZeroZ);
  return {
    topLevelEntityTypeCounts: top.entityTypeCounts,
    blockEntityTypeCounts: block.entityTypeCounts,
    topLevelSkippedEntitySummary: top.unsupportedEntitySummary,
    blockSkippedEntitySummary: block.unsupportedEntitySummary,
    unsupportedEntitySummary,
    unsupportedEntitiesWithCoordinates: mergeSummaries(top.unsupportedEntitiesWithCoordinates, block.unsupportedEntitiesWithCoordinates),
    unsupportedEntitiesWithNonZeroZ: nonZeroZ,
    polylineFlagDistribution: mergeSummaries(top.polylineFlagDistribution, block.polylineFlagDistribution),
    vertexFlagDistribution: mergeSummaries(top.vertexFlagDistribution, block.vertexFlagDistribution),
    unsupportedGeometry: {
      curveOrWireEntityCount: top.curveOrWireEntityCount + block.curveOrWireEntityCount,
      surfaceEntityCount: top.surfaceEntityCount + block.surfaceEntityCount,
      proxyEntityCount: top.proxyEntityCount + block.proxyEntityCount,
      otherEntityCount: top.otherEntityCount + block.otherEntityCount,
      hasNonZeroZ: Object.keys(nonZeroZ).length > 0,
      topLevelEntityCount,
      blockEntityCount,
      onlyInsideBlocks: topLevelEntityCount === 0 && blockEntityCount > 0,
    },
  };
}

// ─── HEADER ───────────────────────────────────────────────────────────────────

function parseHeader(tokens: DxfToken[]): { acadver: string | null } {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i]!.code === 9 && tokens[i]!.value === "$ACADVER") {
      return { acadver: tokens[i + 1]?.value ?? null };
    }
  }
  return { acadver: null };
}

// ─── TABLES → Layers ──────────────────────────────────────────────────────────

function parseLayers(tableTokens: DxfToken[]): Record<string, DxfLayer> {
  const layers: Record<string, DxfLayer> = {
    "0": { name: "0", colorIndex: 7, trueColor: null, frozen: false },
  };
  let i = 0;

  while (i < tableTokens.length) {
    if (tableTokens[i]!.code === 0 && tableTokens[i]!.value === "TABLE") {
      i++;
      const isLayerTable =
        i < tableTokens.length &&
        tableTokens[i]!.code === 2 &&
        tableTokens[i]!.value === "LAYER";
      if (!isLayerTable) {
        while (i < tableTokens.length && !(tableTokens[i]!.code === 0 && tableTokens[i]!.value === "ENDTAB")) i++;
        i++;
        continue;
      }
      i++;
      while (i < tableTokens.length && !(tableTokens[i]!.code === 0 && tableTokens[i]!.value === "ENDTAB")) {
        if (tableTokens[i]!.code === 0 && tableTokens[i]!.value === "LAYER") {
          i++;
          const layer: DxfLayer = { name: "0", colorIndex: 7, trueColor: null, frozen: false };
          while (i < tableTokens.length && tableTokens[i]!.code !== 0) {
            const { code, value } = tableTokens[i]!;
            if (code === 2) layer.name = value;
            else if (code === 62) {
              const ci = parseInt(value, 10);
              layer.colorIndex = Math.abs(ci);
              layer.frozen = ci < 0;
            } else if (code === 420) layer.trueColor = parseInt(value, 10);
            i++;
          }
          layers[layer.name] = layer;
        } else {
          i++;
        }
      }
      i++; // skip ENDTAB
    } else {
      i++;
    }
  }
  return layers;
}

// ─── Entity Parsers ───────────────────────────────────────────────────────────

function parse3DFace(
  tokens: DxfToken[],
  i: number,
  layers: Record<string, DxfLayer>
): { entity: Dxf3DFace; nextIndex: number } {
  const face: Dxf3DFace = {
    type: "3DFACE",
    handle: null,
    layer: "0",
    colorIndex: null,
    trueColor: null,
    extrusion: defaultExtrusion(),
    hasExplicitExtrusion: false,
    ocsApplied: false,
    color: { source: "default", rgb: [200, 200, 200], hex: "#c8c8c8" },
    v0: [0, 0, 0],
    v1: [0, 0, 0],
    v2: [0, 0, 0],
    v3: [0, 0, 0],
    isTriangle: false,
    triangleCount: 0,
  };

  while (i < tokens.length && tokens[i]!.code !== 0) {
    const { code, value } = tokens[i]!;
    switch (code) {
      case 5: face.handle = value; break;
      case 8: face.layer = value; break;
      case 62: face.colorIndex = parseInt(value, 10); break;
      case 420: face.trueColor = parseInt(value, 10); break;
      case 210: face.extrusion[0] = parseFloat(value); face.hasExplicitExtrusion = true; break;
      case 220: face.extrusion[1] = parseFloat(value); face.hasExplicitExtrusion = true; break;
      case 230: face.extrusion[2] = parseFloat(value); face.hasExplicitExtrusion = true; break;
      case 10: face.v0[0] = parseFloat(value); break;
      case 20: face.v0[1] = parseFloat(value); break;
      case 30: face.v0[2] = parseFloat(value); break;
      case 11: face.v1[0] = parseFloat(value); break;
      case 21: face.v1[1] = parseFloat(value); break;
      case 31: face.v1[2] = parseFloat(value); break;
      case 12: face.v2[0] = parseFloat(value); break;
      case 22: face.v2[1] = parseFloat(value); break;
      case 32: face.v2[2] = parseFloat(value); break;
      case 13: face.v3[0] = parseFloat(value); break;
      case 23: face.v3[1] = parseFloat(value); break;
      case 33: face.v3[2] = parseFloat(value); break;
    }
    i++;
  }

  const isTriangle =
    Math.abs(face.v2[0] - face.v3[0]) < 1e-10 &&
    Math.abs(face.v2[1] - face.v3[1]) < 1e-10 &&
    Math.abs(face.v2[2] - face.v3[2]) < 1e-10;
  face.isTriangle = isTriangle;
  face.triangleCount = isTriangle ? 1 : 2;
  face.color = resolveColor(face.colorIndex, face.trueColor, face.layer, layers);
  if (face.hasExplicitExtrusion && !isDefaultExtrusion(face.extrusion)) {
    face.v0 = ocsToWcs(face.v0, face.extrusion);
    face.v1 = ocsToWcs(face.v1, face.extrusion);
    face.v2 = ocsToWcs(face.v2, face.extrusion);
    face.v3 = ocsToWcs(face.v3, face.extrusion);
    face.ocsApplied = true;
  }

  return { entity: face, nextIndex: i };
}

function parsePolylineAsMesh(
  tokens: DxfToken[],
  i: number,
  polylineLayer: string,
  polylineColorIndex: number | null,
  polylineTrueColor: number | null,
  extrusion: [number, number, number],
  hasExplicitExtrusion: boolean,
  layers: Record<string, DxfLayer>,
  meshType: "POLYFACE_MESH" | "POLYMESH"
): { entity: DxfPolyfaceMesh; nextIndex: number } {
  const positions: [number, number, number][] = [];
  const faceRecords: DxfFaceRecord[] = [];

  while (i < tokens.length) {
    if (tokens[i]!.code === 0 && tokens[i]!.value === "SEQEND") {
      i++;
      break;
    }
    if (tokens[i]!.code === 0 && tokens[i]!.value === "VERTEX") {
      i++;
      const v = { flags: 0, x: 0, y: 0, z: 0, i71: 0, i72: 0, i73: 0, i74: 0 };
      while (i < tokens.length && tokens[i]!.code !== 0) {
        const { code, value } = tokens[i]!;
        switch (code) {
          case 70: v.flags = parseInt(value, 10); break;
          case 10: v.x = parseFloat(value); break;
          case 20: v.y = parseFloat(value); break;
          case 30: v.z = parseFloat(value); break;
          case 71: v.i71 = parseInt(value, 10); break;
          case 72: v.i72 = parseInt(value, 10); break;
          case 73: v.i73 = parseInt(value, 10); break;
          case 74: v.i74 = parseInt(value, 10); break;
        }
        i++;
      }
      // Polyface coordinate vertices may carry both the polyface-mesh (64)
      // and polyface-vertex (128) bits. A face record carries 128 without 64.
      // Check bit 64 first so combined flag 192 remains a position vertex.
      if (meshType === "POLYFACE_MESH" && (v.flags & 64)) {
        positions.push([v.x, v.y, v.z]);
      } else if (meshType === "POLYFACE_MESH" && (v.flags & 128)) {
        faceRecords.push({ flags: v.flags, i71: v.i71, i72: v.i72, i73: v.i73, i74: v.i74 });
      } else {
        positions.push([v.x, v.y, v.z]);
      }
    } else {
      i++;
    }
  }

  let triangleCount = 0;
  for (const f of faceRecords) {
    const has0 = Math.abs(f.i71) > 0;
    const has1 = Math.abs(f.i72) > 0;
    const has2 = Math.abs(f.i73) > 0;
    const has3 = Math.abs(f.i74) > 0;
    if (has0 && has1 && has2) {
      triangleCount += has3 ? 2 : 1;
    }
  }

  const color = resolveColor(polylineColorIndex, polylineTrueColor, polylineLayer, layers);
  const ocsApplied = hasExplicitExtrusion && !isDefaultExtrusion(extrusion);
  const wcsPositions = ocsApplied ? positions.map((position) => ocsToWcs(position, extrusion)) : positions;
  const entity: DxfPolyfaceMesh = {
    type: meshType,
    handle: null,
    layer: polylineLayer,
    colorIndex: polylineColorIndex,
    trueColor: polylineTrueColor,
    extrusion,
    hasExplicitExtrusion,
    ocsApplied,
    color,
    positions: wcsPositions,
    faceRecords,
    triangleCount,
  };
  return { entity, nextIndex: i };
}

function parseMeshEntity(
  tokens: DxfToken[],
  i: number,
  layers: Record<string, DxfLayer>
): { entity: DxfMeshEntity; nextIndex: number } {
  const mesh: DxfMeshEntity = {
    type: "MESH",
    handle: null,
    layer: "0",
    colorIndex: null,
    trueColor: null,
    extrusion: defaultExtrusion(),
    hasExplicitExtrusion: false,
    ocsApplied: false,
    color: { source: "default", rgb: [200, 200, 200], hex: "#c8c8c8" },
    version: 0,
    blendCrease: false,
    subdivisionLevel: 0,
    vertexCount: 0,
    faceListCount: 0,
    positions: [],
    faces: [],
    invalidFaceCount: 0,
    diagnostics: [],
    triangleCount: 0,
    note: "MESH (R2010+) level-0 face list parsed.",
  };
  const entityTokens: DxfToken[] = [];
  while (i < tokens.length && tokens[i]!.code !== 0) {
    const { code, value } = tokens[i]!;
    entityTokens.push(tokens[i]!);
    switch (code) {
      case 5: mesh.handle = value; break;
      case 8: mesh.layer = value; break;
      case 62: mesh.colorIndex = parseInt(value, 10); break;
      case 420: mesh.trueColor = parseInt(value, 10); break;
      case 210: mesh.extrusion[0] = parseFloat(value); mesh.hasExplicitExtrusion = true; break;
      case 220: mesh.extrusion[1] = parseFloat(value); mesh.hasExplicitExtrusion = true; break;
      case 230: mesh.extrusion[2] = parseFloat(value); mesh.hasExplicitExtrusion = true; break;
      case 71: mesh.version = parseInt(value, 10); break;
      case 72: mesh.blendCrease = parseInt(value, 10) !== 0; break;
      case 91: mesh.subdivisionLevel = parseInt(value, 10); break;
      case 92: mesh.vertexCount = parseInt(value, 10); break;
      case 93: mesh.faceListCount = parseInt(value, 10); break;
    }
    i++;
  }

  const vertexCountIndex = entityTokens.findIndex((token) => token.code === 92);
  const faceListCountIndex = entityTokens.findIndex((token) => token.code === 93);
  if (vertexCountIndex >= 0 && faceListCountIndex > vertexCountIndex) {
    let current: [number, number, number] | null = null;
    for (let j = vertexCountIndex + 1; j < faceListCountIndex; j++) {
      const token = entityTokens[j]!;
      if (token.code === 10) {
        if (current) mesh.positions.push(current);
        current = [parseFloat(token.value), 0, 0];
      } else if (token.code === 20 && current) {
        current[1] = parseFloat(token.value);
      } else if (token.code === 30 && current) {
        current[2] = parseFloat(token.value);
      }
    }
    if (current) mesh.positions.push(current);
  }

  if (vertexCountIndex < 0 || mesh.vertexCount <= 0 || mesh.positions.length === 0) {
    mesh.diagnostics.push({
      code: "missing-vertex-list",
      message: "MESH is missing a usable vertex list (group 92 followed by 10/20/30 coordinates).",
    });
  } else if (mesh.vertexCount !== mesh.positions.length) {
    mesh.diagnostics.push({
      code: "vertex-count-mismatch",
      message: `MESH declares ${mesh.vertexCount} vertices but ${mesh.positions.length} complete vertices were parsed.`,
    });
  }

  const faceItems: number[] = [];
  if (faceListCountIndex >= 0) {
    for (let j = faceListCountIndex + 1; j < entityTokens.length && faceItems.length < mesh.faceListCount; j++) {
      const token = entityTokens[j]!;
      if (token.code === 94 || token.code === 95 || token.code === 140) break;
      if (token.code === 90) faceItems.push(parseInt(token.value, 10));
    }
  }

  if (faceListCountIndex < 0 || mesh.faceListCount <= 0 || faceItems.length === 0) {
    mesh.diagnostics.push({
      code: "missing-face-list",
      message: "MESH is missing a usable face list (group 93 followed by group 90 face items).",
    });
  } else if (faceItems.length !== mesh.faceListCount) {
    mesh.diagnostics.push({
      code: "face-list-count-mismatch",
      message: `MESH declares ${mesh.faceListCount} face-list items but ${faceItems.length} were parsed.`,
    });
  }

  for (let cursor = 0; cursor < faceItems.length;) {
    const count = faceItems[cursor++] ?? 0;
    if (count < 3 || cursor + count > faceItems.length) {
      mesh.invalidFaceCount++;
      mesh.diagnostics.push({
        code: "malformed-face-list",
        message: count < 3
          ? `MESH face at item ${cursor - 1} declares ${count} vertices; at least 3 are required.`
          : `MESH face at item ${cursor - 1} declares ${count} vertices but the face list ends early.`,
      });
      break;
    }
    const face = faceItems.slice(cursor, cursor + count);
    cursor += count;
    if (face.some((index) => index < 0 || index >= mesh.positions.length)) {
      mesh.invalidFaceCount++;
      mesh.diagnostics.push({
        code: "face-index-out-of-range",
        message: `MESH face references vertex index outside 0..${Math.max(0, mesh.positions.length - 1)}: [${face.join(", ")}].`,
      });
      continue;
    }
    mesh.faces.push(face);
    mesh.triangleCount += face.length - 2;
  }

  if (mesh.subdivisionLevel > 0) {
    mesh.diagnostics.push({
      code: "unsupported-subdivision-data",
      message: `MESH subdivision level ${mesh.subdivisionLevel} is not evaluated; only the level-0 control cage is imported.`,
    });
  }
  const hasCreaseData = entityTokens.some((token) =>
    token.code === 140 || ((token.code === 94 || token.code === 95) && (parseInt(token.value, 10) || 0) > 0)
  );
  if (mesh.blendCrease || hasCreaseData) {
    mesh.diagnostics.push({
      code: "unsupported-crease-data",
      message: "MESH crease/edge data is present but is not evaluated; level-0 faces are imported without crease processing.",
    });
  }
  if (mesh.hasExplicitExtrusion && !isDefaultExtrusion(mesh.extrusion)) {
    mesh.positions = mesh.positions.map((position) => ocsToWcs(position, mesh.extrusion));
    mesh.ocsApplied = true;
  }
  if (mesh.diagnostics.length > 0) {
    mesh.note = `MESH parsed with ${mesh.diagnostics.length} diagnostic warning(s).`;
  }
  mesh.color = resolveColor(mesh.colorIndex, mesh.trueColor, mesh.layer, layers);
  return { entity: mesh, nextIndex: i };
}

function parseInsert(
  tokens: DxfToken[],
  i: number
): { entity: DxfInsert; nextIndex: number } {
  const ins: DxfInsert = {
    type: "INSERT",
    handle: null,
    layer: "0",
    blockName: "",
    colorIndex: null,
    trueColor: null,
    extrusion: defaultExtrusion(),
    hasExplicitExtrusion: false,
    ocsApplied: false,
    position: [0, 0, 0],
    scale: [1, 1, 1],
    rotation: 0,
    rowCount: 1,
    columnCount: 1,
    rowSpacing: 0,
    columnSpacing: 0,
  };
  while (i < tokens.length && tokens[i]!.code !== 0) {
    const { code, value } = tokens[i]!;
    switch (code) {
      case 5: ins.handle = value; break;
      case 8: ins.layer = value; break;
      case 2: ins.blockName = value; break;
      case 62: ins.colorIndex = parseInt(value, 10); break;
      case 420: ins.trueColor = parseInt(value, 10); break;
      case 210: ins.extrusion[0] = parseFloat(value); ins.hasExplicitExtrusion = true; break;
      case 220: ins.extrusion[1] = parseFloat(value); ins.hasExplicitExtrusion = true; break;
      case 230: ins.extrusion[2] = parseFloat(value); ins.hasExplicitExtrusion = true; break;
      case 10: ins.position[0] = parseFloat(value); break;
      case 20: ins.position[1] = parseFloat(value); break;
      case 30: ins.position[2] = parseFloat(value); break;
      case 41: ins.scale[0] = parseFloat(value); break;
      case 42: ins.scale[1] = parseFloat(value); break;
      case 43: ins.scale[2] = parseFloat(value); break;
      case 50: ins.rotation = parseFloat(value); break;
      case 70: ins.columnCount = Math.max(1, parseInt(value, 10) || 1); break;
      case 71: ins.rowCount = Math.max(1, parseInt(value, 10) || 1); break;
      case 44: ins.columnSpacing = parseFloat(value) || 0; break;
      case 45: ins.rowSpacing = parseFloat(value) || 0; break;
    }
    i++;
  }
  if (ins.hasExplicitExtrusion && !isDefaultExtrusion(ins.extrusion)) {
    ins.position = ocsToWcs(ins.position, ins.extrusion);
    ins.ocsApplied = true;
  }
  if (ins.rowCount > 1 || ins.columnCount > 1) ins.type = "MINSERT";
  // Skip optional ATTRIB sub-entities and SEQEND
  while (
    i < tokens.length &&
    tokens[i]!.code === 0 &&
    (tokens[i]!.value === "ATTRIB" || tokens[i]!.value === "SEQEND")
  ) {
    i++;
    while (i < tokens.length && tokens[i]!.code !== 0) i++;
  }
  return { entity: ins, nextIndex: i };
}

function parseAcisEntity(
  tokens: DxfToken[],
  i: number,
  entityType: "3DSOLID" | "BODY" | "REGION"
): { entity: DxfAcisEntity; nextIndex: number } {
  const acis: DxfAcisEntity = { type: entityType, handle: null, layer: "0", hasAcisData: false };
  while (i < tokens.length && tokens[i]!.code !== 0) {
    const { code, value } = tokens[i]!;
    if (code === 5) acis.handle = value;
    else if (code === 8) acis.layer = value;
    else if (code === 1 || code === 3) acis.hasAcisData = true;
    i++;
  }
  return { entity: acis, nextIndex: i };
}

// ─── Generic Entity Section Parser ───────────────────────────────────────────

function parseEntitySection(
  tokens: DxfToken[],
  layers: Record<string, DxfLayer>
): { supported: DxfSupportedEntity[]; acis: DxfAcisEntity[]; inserts: DxfInsert[]; skipped: Record<string, number> } {
  const supported: DxfSupportedEntity[] = [];
  const acis: DxfAcisEntity[] = [];
  const inserts: DxfInsert[] = [];
  const skipped: Record<string, number> = {};
  let i = 0;

  while (i < tokens.length) {
    if (tokens[i]!.code !== 0) { i++; continue; }

    const entityType = tokens[i]!.value;
    i++;

    switch (entityType) {
      case "3DFACE": {
        const { entity, nextIndex } = parse3DFace(tokens, i, layers);
        supported.push(entity);
        i = nextIndex;
        break;
      }

      case "POLYLINE": {
        let flags = 0, layerName = "0", colorIndex: number | null = null, trueColor: number | null = null;
        const extrusion = defaultExtrusion();
        let hasExplicitExtrusion = false;
        let j = i;
        while (j < tokens.length && tokens[j]!.code !== 0) {
          const { code, value } = tokens[j]!;
          if (code === 70) flags = parseInt(value, 10);
          else if (code === 8) layerName = value;
          else if (code === 62) colorIndex = parseInt(value, 10);
          else if (code === 420) trueColor = parseInt(value, 10);
          else if (code === 210) { extrusion[0] = parseFloat(value); hasExplicitExtrusion = true; }
          else if (code === 220) { extrusion[1] = parseFloat(value); hasExplicitExtrusion = true; }
          else if (code === 230) { extrusion[2] = parseFloat(value); hasExplicitExtrusion = true; }
          j++;
        }
        if (flags & 64) {
          const { entity, nextIndex } = parsePolylineAsMesh(tokens, j, layerName, colorIndex, trueColor, extrusion, hasExplicitExtrusion, layers, "POLYFACE_MESH");
          supported.push(entity);
          i = nextIndex;
        } else if (flags & 16) {
          const { entity, nextIndex } = parsePolylineAsMesh(tokens, j, layerName, colorIndex, trueColor, extrusion, hasExplicitExtrusion, layers, "POLYMESH");
          supported.push(entity);
          i = nextIndex;
        } else {
          skipped["POLYLINE_2D"] = (skipped["POLYLINE_2D"] ?? 0) + 1;
          i = j;
          while (i < tokens.length && !(tokens[i]!.code === 0 && tokens[i]!.value === "SEQEND")) i++;
          if (i < tokens.length) i++;
        }
        break;
      }

      case "MESH": {
        const { entity, nextIndex } = parseMeshEntity(tokens, i, layers);
        supported.push(entity);
        i = nextIndex;
        break;
      }

      case "INSERT": {
        const { entity, nextIndex } = parseInsert(tokens, i);
        inserts.push(entity);
        i = nextIndex;
        break;
      }

      case "3DSOLID":
      case "BODY":
      case "REGION": {
        const { entity, nextIndex } = parseAcisEntity(tokens, i, entityType as "3DSOLID" | "BODY" | "REGION");
        acis.push(entity);
        i = nextIndex;
        break;
      }

      case "ENDSEC":
      case "ENDBLK":
      case "EOF":
        break;

      default: {
        if (entityType) {
          skipped[entityType] = (skipped[entityType] ?? 0) + 1;
          while (i < tokens.length && tokens[i]!.code !== 0) i++;
        }
        break;
      }
    }
  }

  return { supported, acis, inserts, skipped };
}

// ─── BLOCKS Section ───────────────────────────────────────────────────────────

function parseBlocks(
  blockTokens: DxfToken[],
  layers: Record<string, DxfLayer>
): Record<string, DxfBlock> {
  const blocks: Record<string, DxfBlock> = {};
  let i = 0;

  while (i < blockTokens.length) {
    if (!(blockTokens[i]!.code === 0 && blockTokens[i]!.value === "BLOCK")) {
      i++;
      continue;
    }
    i++;

    const block: DxfBlock = { name: "", layer: "0", origin: [0, 0, 0], flags: 0, supported: [], acis: [], inserts: [], skipped: {}, triangleCount: 0 };
    while (i < blockTokens.length && blockTokens[i]!.code !== 0) {
      const { code, value } = blockTokens[i]!;
      if (code === 2) block.name = value;
      else if (code === 8) block.layer = value;
      else if (code === 70) block.flags = parseInt(value, 10);
      else if (code === 10) block.origin[0] = parseFloat(value);
      else if (code === 20) block.origin[1] = parseFloat(value);
      else if (code === 30) block.origin[2] = parseFloat(value);
      i++;
    }

    const entityStart = i;
    while (i < blockTokens.length && !(blockTokens[i]!.code === 0 && blockTokens[i]!.value === "ENDBLK")) i++;
    const entityTokens = blockTokens.slice(entityStart, i);
    if (i < blockTokens.length) i++; // skip ENDBLK keyword
    while (i < blockTokens.length && blockTokens[i]!.code !== 0) i++; // skip ENDBLK groups

    // Only named non-model-space blocks
    if (block.name && !block.name.startsWith("*")) {
      const result = parseEntitySection(entityTokens, layers);
      block.supported = result.supported;
      block.acis = result.acis;
      block.inserts = result.inserts;
      block.skipped = result.skipped;
      block.triangleCount = result.supported.reduce((s, e) => s + (e.triangleCount ?? 0), 0);
      blocks[block.name] = block;
    }
  }

  return blocks;
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export function parseDxf(filePath: string): ParsedDxf {
  const text = fs.readFileSync(filePath, "utf8");
  const tokens = tokenize(text);
  const sections = splitSections(tokens);

  const header = sections["HEADER"] ? parseHeader(sections["HEADER"]) : { acadver: null };
  const layers = sections["TABLES"]
    ? parseLayers(sections["TABLES"])
    : { "0": { name: "0", colorIndex: 7, trueColor: null, frozen: false } };
  const blocks = sections["BLOCKS"] ? parseBlocks(sections["BLOCKS"], layers) : {};
  const entityResult = sections["ENTITIES"]
    ? parseEntitySection(sections["ENTITIES"], layers)
    : { supported: [], acis: [], inserts: [], skipped: {} };

  return {
    dxfVersion: header.acadver,
    layers,
    blocks,
    entities: entityResult,
    diagnostics: buildEntityDiagnostics(sections),
  };
}
