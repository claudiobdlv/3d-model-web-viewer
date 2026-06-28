/**
 * FormatIQ DXF Mesh Import Spike Parser
 *
 * Standalone Node.js ESM script — zero npm dependencies.
 * Parses DXF ASCII files and produces a JSON entity/colour/structure summary.
 *
 * Supported entities: 3DFACE, POLYFACE_MESH (POLYLINE+bit64), POLYMESH (POLYLINE+bit16),
 *                     MESH, INSERT, BLOCK/ENDBLK, LAYER table
 * Detected but rejected: 3DSOLID, BODY, REGION (ACIS)
 *
 * Usage:
 *   node src/dxfSpikeParser.mjs fixtures/test-3dface.dxf [more.dxf ...]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── ACI Colour Table ────────────────────────────────────────────────────────
// AutoCAD Color Index (ACI) → [R, G, B].  Standard indices 1-9 are exact;
// higher indices are approximate (sufficient for spike-level colour reporting).

const ACI_RGB = new Map([
  [1,  [255, 0,   0  ]], // red
  [2,  [255, 255, 0  ]], // yellow
  [3,  [0,   255, 0  ]], // green
  [4,  [0,   255, 255]], // cyan
  [5,  [0,   0,   255]], // blue
  [6,  [255, 0,   255]], // magenta
  [7,  [255, 255, 255]], // white
  [8,  [65,  65,  65 ]], // dark grey
  [9,  [128, 128, 128]], // light grey
  // Row 10 — red family
  [10, [255, 0,   0  ]], [11, [255, 127, 127]], [12, [165, 0,   0  ]],
  [13, [165, 82,  82 ]], [14, [127, 0,   0  ]], [15, [127, 63,  63 ]],
  // Approximate mid-spectrum
  [20, [255, 63,  0  ]], [30, [255, 127, 0  ]], [40, [255, 191, 0  ]],
  [50, [255, 255, 0  ]], [60, [191, 255, 0  ]], [70, [127, 255, 0  ]],
  [80, [63,  255, 0  ]], [90, [0,   255, 0  ]],
  [100,[0,   255, 63 ]], [110,[0,   255, 127]], [120,[0,   255, 191]],
  [130,[0,   255, 255]], [140,[0,   191, 255]], [150,[0,   127, 255]],
  [160,[0,   63,  255]], [170,[0,   0,   255]], [180,[63,  0,   255]],
  [190,[127, 0,   255]], [200,[191, 0,   255]], [210,[255, 0,   255]],
  [220,[255, 0,   191]], [230,[255, 0,   127]], [240,[255, 0,   63 ]],
  // Greyscale ramp
  [250,[51,  51,  51 ]], [251,[80,  80,  80 ]], [252,[105, 105, 105]],
  [253,[130, 130, 130]], [254,[190, 190, 190]], [255,[255, 255, 255]],
]);

function aciToRgb(index) {
  const abs = Math.abs(index);
  if (ACI_RGB.has(abs)) return ACI_RGB.get(abs);
  // Approximate unknown indices with a neutral grey
  return [200, 200, 200];
}

function trueColorToRgb(value) {
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function rgbToHex([r, g, b]) {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// ─── Tokenizer ───────────────────────────────────────────────────────────────
// DXF ASCII: alternating lines of group-code and value.

function tokenize(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const tokens = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (!isNaN(code)) {
      tokens.push({ code, value: lines[i + 1].trimEnd() });
    }
  }
  return tokens;
}

// ─── Section Splitter ────────────────────────────────────────────────────────

function splitSections(tokens) {
  const sections = {};
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].code === 0 && tokens[i].value === 'SECTION') {
      i++;
      if (i < tokens.length && tokens[i].code === 2) {
        const name = tokens[i].value;
        i++;
        const start = i;
        while (i < tokens.length && !(tokens[i].code === 0 && tokens[i].value === 'ENDSEC')) i++;
        sections[name] = tokens.slice(start, i);
        i++; // skip ENDSEC
        continue;
      }
    }
    i++;
  }
  return sections;
}

// ─── HEADER Section ──────────────────────────────────────────────────────────

function parseHeader(tokens) {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].code === 9 && tokens[i].value === '$ACADVER') {
      return { acadver: tokens[i + 1]?.value ?? null };
    }
  }
  return { acadver: null };
}

// ─── TABLES Section → Layer Table ────────────────────────────────────────────

function parseLayers(tableTokens) {
  const layers = { '0': { name: '0', colorIndex: 7, trueColor: null, frozen: false } };
  let i = 0;

  while (i < tableTokens.length) {
    // Locate TABLE LAYER block
    if (tableTokens[i].code === 0 && tableTokens[i].value === 'TABLE') {
      i++;
      const isLayerTable = i < tableTokens.length && tableTokens[i].code === 2 && tableTokens[i].value === 'LAYER';
      if (!isLayerTable) {
        // Skip to ENDTAB
        while (i < tableTokens.length && !(tableTokens[i].code === 0 && tableTokens[i].value === 'ENDTAB')) i++;
        i++;
        continue;
      }
      i++;
      // Parse LAYER entries until ENDTAB
      while (i < tableTokens.length && !(tableTokens[i].code === 0 && tableTokens[i].value === 'ENDTAB')) {
        if (tableTokens[i].code === 0 && tableTokens[i].value === 'LAYER') {
          i++;
          const layer = { name: '0', colorIndex: 7, trueColor: null, frozen: false };
          while (i < tableTokens.length && tableTokens[i].code !== 0) {
            const { code, value } = tableTokens[i];
            if (code === 2)   layer.name = value;
            else if (code === 62) {
              const ci = parseInt(value, 10);
              layer.colorIndex = Math.abs(ci);
              layer.frozen = ci < 0;
            }
            else if (code === 420) layer.trueColor = parseInt(value, 10);
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

// ─── Colour Resolver ─────────────────────────────────────────────────────────

function resolveColor(entityColorIndex, entityTrueColor, layerName, layers) {
  if (entityTrueColor !== null && entityTrueColor !== undefined) {
    const rgb = trueColorToRgb(entityTrueColor);
    return { source: 'entity-truecolor', rgb, hex: rgbToHex(rgb) };
  }
  const aci = entityColorIndex;
  if (aci === 0) {
    return { source: 'byblock', rgb: [200, 200, 200], hex: '#c8c8c8' };
  }
  if (aci === null || aci === undefined || aci === 256) {
    const layer = layers[layerName] ?? layers['0'];
    if (!layer) return { source: 'default', rgb: [200, 200, 200], hex: '#c8c8c8' };
    if (layer.trueColor !== null && layer.trueColor !== undefined) {
      const rgb = trueColorToRgb(layer.trueColor);
      return { source: 'layer-truecolor', rgb, hex: rgbToHex(rgb) };
    }
    const rgb = aciToRgb(layer.colorIndex);
    return { source: 'layer-aci', aci: layer.colorIndex, rgb, hex: rgbToHex(rgb) };
  }
  const rgb = aciToRgb(aci);
  return { source: 'entity-aci', aci, rgb, hex: rgbToHex(rgb) };
}

// ─── Entity Parsers ──────────────────────────────────────────────────────────

function parse3DFace(tokens, i, layers) {
  const face = {
    type: '3DFACE', layer: '0', colorIndex: null, trueColor: null, handle: null,
    v0: [0,0,0], v1: [0,0,0], v2: [0,0,0], v3: [0,0,0], invisibleEdges: 0,
  };
  while (i < tokens.length && tokens[i].code !== 0) {
    const { code, value } = tokens[i];
    switch (code) {
      case 5:  face.handle = value; break;
      case 8:  face.layer = value; break;
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
      case 70: face.invisibleEdges = parseInt(value, 10); break;
    }
    i++;
  }
  // Triangle if v3 === v2 (within floating point tolerance)
  const isTriangle =
    Math.abs(face.v2[0] - face.v3[0]) < 1e-10 &&
    Math.abs(face.v2[1] - face.v3[1]) < 1e-10 &&
    Math.abs(face.v2[2] - face.v3[2]) < 1e-10;
  face.isTriangle = isTriangle;
  face.triangleCount = isTriangle ? 1 : 2;
  face.color = resolveColor(face.colorIndex, face.trueColor, face.layer, layers);
  return { entity: face, nextIndex: i };
}

function parsePolylineAsMesh(tokens, i, polylineLayer, polylineColorIndex, polylineTrueColor, layers, meshType) {
  // tokens[i] is the first token after the POLYLINE header groups.
  // We have already consumed all POLYLINE header groups up to the first VERTEX/SEQEND.
  const positions = [];
  const faceRecords = [];

  while (i < tokens.length) {
    if (tokens[i].code === 0 && tokens[i].value === 'SEQEND') { i++; break; }
    if (tokens[i].code === 0 && tokens[i].value === 'VERTEX') {
      i++;
      const v = { flags: 0, x: 0, y: 0, z: 0, i71: 0, i72: 0, i73: 0, i74: 0 };
      while (i < tokens.length && tokens[i].code !== 0) {
        const { code, value } = tokens[i];
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
      // bit 128 = face record; otherwise position vertex
      if (v.flags & 128) faceRecords.push(v);
      else positions.push([v.x, v.y, v.z]);
    } else {
      i++;
    }
  }

  // Count triangles from face records (indices are 1-based, negative = hidden edge)
  let triangleCount = 0;
  for (const f of faceRecords) {
    const hasI0 = Math.abs(f.i71) > 0;
    const hasI1 = Math.abs(f.i72) > 0;
    const hasI2 = Math.abs(f.i73) > 0;
    const hasI3 = Math.abs(f.i74) > 0;
    if (hasI0 && hasI1 && hasI2) {
      triangleCount += hasI3 ? 2 : 1; // quad → 2 triangles
    }
  }

  const color = resolveColor(polylineColorIndex, polylineTrueColor, polylineLayer, layers);
  const entity = {
    type: meshType,
    layer: polylineLayer,
    colorIndex: polylineColorIndex,
    trueColor: polylineTrueColor,
    color,
    vertexCount: positions.length,
    faceCount: faceRecords.length,
    triangleCount,
  };
  return { entity, nextIndex: i };
}

function parseMeshEntity(tokens, i, layers) {
  const mesh = {
    type: 'MESH', layer: '0', handle: null,
    colorIndex: null, trueColor: null,
    subdivisionLevel: 0, vertexCount: 0, faceListCount: 0,
  };
  while (i < tokens.length && tokens[i].code !== 0) {
    const { code, value } = tokens[i];
    switch (code) {
      case 5:  mesh.handle = value; break;
      case 8:  mesh.layer = value; break;
      case 62: mesh.colorIndex = parseInt(value, 10); break;
      case 420: mesh.trueColor = parseInt(value, 10); break;
      case 71: mesh.subdivisionLevel = parseInt(value, 10); break;
      case 72: mesh.vertexCount = parseInt(value, 10); break;
      case 93: mesh.faceListCount = parseInt(value, 10); break;
    }
    i++;
  }
  mesh.color = resolveColor(mesh.colorIndex, mesh.trueColor, mesh.layer, layers);
  mesh.note = 'MESH (R2010+) detected; full triangulation not implemented in spike — requires production parser.';
  return { entity: mesh, nextIndex: i };
}

function parseInsert(tokens, i) {
  const ins = {
    type: 'INSERT', layer: '0', handle: null, blockName: '',
    position: [0,0,0], scale: [1,1,1], rotation: 0,
    colorIndex: null, trueColor: null,
  };
  while (i < tokens.length && tokens[i].code !== 0) {
    const { code, value } = tokens[i];
    switch (code) {
      case 5:  ins.handle = value; break;
      case 8:  ins.layer = value; break;
      case 2:  ins.blockName = value; break;
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
  return { entity: ins, nextIndex: i };
}

function parseAcisEntity(tokens, i, entityType) {
  const acis = { type: entityType, layer: '0', handle: null, hasAcisData: false };
  while (i < tokens.length && tokens[i].code !== 0) {
    const { code, value } = tokens[i];
    if (code === 5)  acis.handle = value;
    else if (code === 8)  acis.layer = value;
    else if (code === 1 || code === 3) acis.hasAcisData = true;
    i++;
  }
  return { entity: acis, nextIndex: i };
}

// ─── Generic Entity Section Parser ───────────────────────────────────────────

function parseEntitySection(tokens, layers) {
  const supported = [];
  const acis      = [];
  const inserts   = [];
  const skipped   = {};
  let i = 0;

  while (i < tokens.length) {
    if (tokens[i].code !== 0) { i++; continue; }

    const entityType = tokens[i].value;
    i++;

    switch (entityType) {
      case '3DFACE': {
        const { entity, nextIndex } = parse3DFace(tokens, i, layers);
        supported.push(entity);
        i = nextIndex;
        break;
      }

      case 'POLYLINE': {
        // Read POLYLINE header to determine type
        let flags = 0, layerName = '0', colorIndex = null, trueColor = null;
        let j = i;
        while (j < tokens.length && tokens[j].code !== 0) {
          const { code, value } = tokens[j];
          if (code === 70) flags = parseInt(value, 10);
          else if (code === 8) layerName = value;
          else if (code === 62) colorIndex = parseInt(value, 10);
          else if (code === 420) trueColor = parseInt(value, 10);
          j++;
        }
        if (flags & 64) {
          const { entity, nextIndex } = parsePolylineAsMesh(tokens, j, layerName, colorIndex, trueColor, layers, 'POLYFACE_MESH');
          supported.push(entity);
          i = nextIndex;
        } else if (flags & 16) {
          const { entity, nextIndex } = parsePolylineAsMesh(tokens, j, layerName, colorIndex, trueColor, layers, 'POLYMESH');
          supported.push(entity);
          i = nextIndex;
        } else {
          // 2D/3D polyline, not a mesh — skip past SEQEND
          skipped['POLYLINE_2D'] = (skipped['POLYLINE_2D'] ?? 0) + 1;
          i = j;
          while (i < tokens.length && !(tokens[i].code === 0 && tokens[i].value === 'SEQEND')) i++;
          if (i < tokens.length) i++;
        }
        break;
      }

      case 'MESH': {
        const { entity, nextIndex } = parseMeshEntity(tokens, i, layers);
        supported.push(entity);
        i = nextIndex;
        break;
      }

      case 'INSERT': {
        const { entity, nextIndex } = parseInsert(tokens, i);
        inserts.push(entity);
        // Skip ATTRIB sub-entities if present
        while (i < nextIndex && tokens[i].code !== 0) i++;
        i = nextIndex;
        // Skip any ATTRIB/SEQEND following this INSERT
        while (i < tokens.length && tokens[i].code === 0 &&
               (tokens[i].value === 'ATTRIB' || tokens[i].value === 'SEQEND')) {
          i++;
          while (i < tokens.length && tokens[i].code !== 0) i++;
        }
        break;
      }

      case '3DSOLID':
      case 'BODY':
      case 'REGION': {
        const { entity, nextIndex } = parseAcisEntity(tokens, i, entityType);
        acis.push(entity);
        i = nextIndex;
        break;
      }

      case 'ENDSEC':
      case 'ENDBLK':
      case 'EOF':
        break;

      default: {
        if (entityType) {
          skipped[entityType] = (skipped[entityType] ?? 0) + 1;
          while (i < tokens.length && tokens[i].code !== 0) i++;
        }
        break;
      }
    }
  }
  return { supported, acis, inserts, skipped };
}

// ─── BLOCKS Section ──────────────────────────────────────────────────────────

function parseBlocks(blockTokens, layers) {
  const blocks = {};
  let i = 0;

  while (i < blockTokens.length) {
    if (!(blockTokens[i].code === 0 && blockTokens[i].value === 'BLOCK')) { i++; continue; }
    i++;

    const block = { name: '', layer: '0', origin: [0,0,0], flags: 0 };
    while (i < blockTokens.length && blockTokens[i].code !== 0) {
      const { code, value } = blockTokens[i];
      if (code === 2)  block.name = value;
      else if (code === 8)  block.layer = value;
      else if (code === 70) block.flags = parseInt(value, 10);
      else if (code === 10) block.origin[0] = parseFloat(value);
      else if (code === 20) block.origin[1] = parseFloat(value);
      else if (code === 30) block.origin[2] = parseFloat(value);
      i++;
    }

    // Collect entity tokens until ENDBLK
    const entityStart = i;
    while (i < blockTokens.length && !(blockTokens[i].code === 0 && blockTokens[i].value === 'ENDBLK')) i++;
    const entityTokens = blockTokens.slice(entityStart, i);
    if (i < blockTokens.length) i++; // skip ENDBLK
    while (i < blockTokens.length && blockTokens[i].code !== 0) i++; // skip ENDBLK header groups

    // Only named, non-model-space blocks
    if (block.name && !block.name.startsWith('*')) {
      const result = parseEntitySection(entityTokens, layers);
      block.supported = result.supported;
      block.acis      = result.acis;
      block.inserts   = result.inserts;
      block.skipped   = result.skipped;
      block.triangleCount = result.supported.reduce((s, e) => s + (e.triangleCount ?? 0), 0);
      blocks[block.name] = block;
    }
  }
  return blocks;
}

// ─── Summary Builder ─────────────────────────────────────────────────────────

function buildSummary(header, layers, blocks, entityResult, sourceFile) {
  const { supported, acis, inserts, skipped } = entityResult;

  // Entity type counts
  const entityCounts = {};
  for (const e of supported) entityCounts[e.type] = (entityCounts[e.type] ?? 0) + 1;
  for (const e of acis)      entityCounts[e.type] = (entityCounts[e.type] ?? 0) + 1;

  // Triangle / vertex counts
  let triangleCount = 0;
  let vertexCount   = 0;
  for (const e of supported) {
    triangleCount += e.triangleCount ?? 0;
    vertexCount   += e.vertexCount   ?? 0;
  }

  // Layers actually referenced
  const layerSummary = {};
  const referencedLayerNames = new Set([...supported, ...acis, ...inserts].map(e => e.layer));
  referencedLayerNames.add('0');
  for (const name of referencedLayerNames) {
    const l = layers[name];
    if (!l) continue;
    const color = resolveColor(null, l.trueColor, name, layers);
    layerSummary[name] = { colorIndex: l.colorIndex, hex: color.hex, frozen: l.frozen };
  }

  // Block summary
  const blockSummary = {};
  for (const [name, b] of Object.entries(blocks)) {
    blockSummary[name] = {
      entityCount:   b.supported.length + b.inserts.length,
      acisCount:     b.acis.length,
      triangleCount: b.triangleCount,
    };
  }

  // Insert summary (by block name)
  const insertsByBlock = {};
  for (const ins of inserts) {
    insertsByBlock[ins.blockName] = (insertsByBlock[ins.blockName] ?? 0) + 1;
  }

  // Determine overall status and messaging
  const hasSupportedGeometry = supported.length > 0;
  const hasInserts            = inserts.length > 0;
  const hasAcis               = acis.length > 0;
  const hasAny3d              = hasSupportedGeometry || hasInserts;
  const skippedTotal          = Object.values(skipped).reduce((a, b) => a + b, 0);

  let status;
  const warnings = [];
  let exportAdvice = null;

  if (!hasAny3d && hasAcis) {
    status = 'acis-only-hard-error';
    warnings.push(
      'This DXF contains ACIS solids (3DSOLID/BODY/REGION) with no supported mesh geometry. ' +
      'Re-export from Revit with solids as mesh/polymesh and display colours enabled.'
    );
    exportAdvice = 'In Revit DXF export options: set "Solids (3D views)" to "Polymesh" and enable element display colours.';
  } else if (!hasAny3d && !hasAcis) {
    if (skippedTotal > 0) {
      status = 'no-3d-mesh-geometry';
      warnings.push('DXF contains only 2D or unsupported entities. No 3D mesh geometry found.');
      exportAdvice = 'Ensure you are exporting a 3D view from Revit (not a floor plan). Check that the view contains visible solids or mesh elements.';
    } else {
      status = 'empty';
      warnings.push('DXF appears to contain no geometry entities at all.');
    }
  } else if (hasAny3d && hasAcis) {
    status = 'partial-import-with-warnings';
    warnings.push(
      `${acis.length} ACIS solid(s) (3DSOLID/BODY/REGION) were detected and will be skipped. ` +
      `${supported.length} supported mesh entity/entities found. ` +
      'To include the skipped solids, re-export from Revit with "Solids (3D views)" set to "Polymesh".'
    );
  } else {
    status = 'ok';
  }

  return {
    sourceFile:  path.basename(sourceFile),
    dxfVersion:  header.acadver,
    summary: {
      status,
      supportedEntityCount:   supported.length,
      unsupportedAcisCount:   acis.length,
      insertCount:            inserts.length,
      triangleCount,
      warnings,
      exportAdvice,
    },
    entityCounts: {
      '3DFACE':       entityCounts['3DFACE']       ?? 0,
      'POLYFACE_MESH':entityCounts['POLYFACE_MESH'] ?? 0,
      'POLYMESH':     entityCounts['POLYMESH']      ?? 0,
      'MESH':         entityCounts['MESH']          ?? 0,
      'INSERT':       inserts.length,
      '3DSOLID':      entityCounts['3DSOLID']       ?? 0,
      'BODY':         entityCounts['BODY']          ?? 0,
      'REGION':       entityCounts['REGION']        ?? 0,
      skipped,
    },
    layers:  layerSummary,
    blocks:  blockSummary,
    inserts: insertsByBlock,
    details: {
      supported: supported.map(e => ({
        type:          e.type,
        layer:         e.layer,
        color:         e.color,
        triangleCount: e.triangleCount ?? null,
        vertexCount:   e.vertexCount   ?? null,
        note:          e.note          ?? undefined,
      })),
      acis: acis.map(e => ({
        type:        e.type,
        layer:       e.layer,
        hasAcisData: e.hasAcisData,
      })),
      inserts: inserts.map(e => ({
        blockName: e.blockName,
        layer:     e.layer,
        position:  e.position,
        scale:     e.scale,
        rotation:  e.rotation,
      })),
    },
  };
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export function parseDxf(filePath) {
  const text     = fs.readFileSync(filePath, 'utf8');
  const tokens   = tokenize(text);
  const sections = splitSections(tokens);

  const header      = sections['HEADER']   ? parseHeader(sections['HEADER'])       : { acadver: null };
  const layers      = sections['TABLES']   ? parseLayers(sections['TABLES'])       : { '0': { name: '0', colorIndex: 7, trueColor: null, frozen: false } };
  const blocks      = sections['BLOCKS']   ? parseBlocks(sections['BLOCKS'], layers) : {};
  const entityResult = sections['ENTITIES'] ? parseEntitySection(sections['ENTITIES'], layers) : { supported: [], acis: [], inserts: [], skipped: {} };

  return buildSummary(header, layers, blocks, entityResult, filePath);
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Usage: node src/dxfSpikeParser.mjs <file.dxf> [file2.dxf ...]');
    process.exit(1);
  }
  let anyError = false;
  for (const file of files) {
    const abs = path.resolve(file);
    process.stdout.write(`\n=== ${path.basename(file)} ===\n`);
    try {
      const result = parseDxf(abs);
      console.log(JSON.stringify(result, null, 2));
      const s = result.summary;
      process.stdout.write(`\nStatus: ${s.status} | Entities: ${s.supportedEntityCount} supported, ${s.unsupportedAcisCount} ACIS, ${s.insertCount} inserts | Triangles: ${s.triangleCount}\n`);
      if (s.warnings.length) {
        for (const w of s.warnings) process.stdout.write(`WARNING: ${w}\n`);
      }
    } catch (err) {
      process.stderr.write(`ERROR parsing ${file}: ${err.message}\n`);
      anyError = true;
    }
  }
  process.exit(anyError ? 1 : 0);
}
