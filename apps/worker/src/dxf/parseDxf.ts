// FormatIQ DXF — production-quality ASCII DXF parser (TypeScript)
// Supports: 3DFACE, POLYFACE_MESH, POLYMESH, MESH (detect-only),
//           INSERT, BLOCK/ENDBLK, LAYER table
// Detects and rejects: 3DSOLID, BODY, REGION (ACIS)
import fs from "node:fs";
import type {
  DxfToken, DxfLayer, DxfBlock, DxfInsert, DxfAcisEntity,
  DxfSupportedEntity, Dxf3DFace, DxfPolyfaceMesh, DxfMeshEntity,
  ParsedDxf, DxfFaceRecord,
} from "./types.js";
import { resolveColor } from "./colors.js";

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

  return { entity: face, nextIndex: i };
}

function parsePolylineAsMesh(
  tokens: DxfToken[],
  i: number,
  polylineLayer: string,
  polylineColorIndex: number | null,
  polylineTrueColor: number | null,
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
      if (v.flags & 128) {
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
  const entity: DxfPolyfaceMesh = {
    type: meshType,
    handle: null,
    layer: polylineLayer,
    colorIndex: polylineColorIndex,
    trueColor: polylineTrueColor,
    color,
    positions,
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
    color: { source: "default", rgb: [200, 200, 200], hex: "#c8c8c8" },
    subdivisionLevel: 0,
    vertexCount: 0,
    faceListCount: 0,
    triangleCount: 0,
    note: "MESH (R2010+) detected — full triangulation not yet implemented.",
  };
  while (i < tokens.length && tokens[i]!.code !== 0) {
    const { code, value } = tokens[i]!;
    switch (code) {
      case 5: mesh.handle = value; break;
      case 8: mesh.layer = value; break;
      case 62: mesh.colorIndex = parseInt(value, 10); break;
      case 420: mesh.trueColor = parseInt(value, 10); break;
      case 71: mesh.subdivisionLevel = parseInt(value, 10); break;
      case 72: mesh.vertexCount = parseInt(value, 10); break;
      case 93: mesh.faceListCount = parseInt(value, 10); break;
    }
    i++;
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
    position: [0, 0, 0],
    scale: [1, 1, 1],
    rotation: 0,
  };
  while (i < tokens.length && tokens[i]!.code !== 0) {
    const { code, value } = tokens[i]!;
    switch (code) {
      case 5: ins.handle = value; break;
      case 8: ins.layer = value; break;
      case 2: ins.blockName = value; break;
      case 62: ins.colorIndex = parseInt(value, 10); break;
      case 420: ins.trueColor = parseInt(value, 10); break;
      case 10: ins.position[0] = parseFloat(value); break;
      case 20: ins.position[1] = parseFloat(value); break;
      case 30: ins.position[2] = parseFloat(value); break;
      case 41: ins.scale[0] = parseFloat(value); break;
      case 42: ins.scale[1] = parseFloat(value); break;
      case 43: ins.scale[2] = parseFloat(value); break;
      case 50: ins.rotation = parseFloat(value); break;
    }
    i++;
  }
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
        let j = i;
        while (j < tokens.length && tokens[j]!.code !== 0) {
          const { code, value } = tokens[j]!;
          if (code === 70) flags = parseInt(value, 10);
          else if (code === 8) layerName = value;
          else if (code === 62) colorIndex = parseInt(value, 10);
          else if (code === 420) trueColor = parseInt(value, 10);
          j++;
        }
        if (flags & 64) {
          const { entity, nextIndex } = parsePolylineAsMesh(tokens, j, layerName, colorIndex, trueColor, layers, "POLYFACE_MESH");
          supported.push(entity);
          i = nextIndex;
        } else if (flags & 16) {
          const { entity, nextIndex } = parsePolylineAsMesh(tokens, j, layerName, colorIndex, trueColor, layers, "POLYMESH");
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
  };
}
