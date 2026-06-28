# FormatIQ — DXF Mesh Import Plan

**Branch:** `feature/formatiq-dxf-mesh-spike`
**Phase:** Planning / Spike — not yet in production.
**Date:** 2026-06-28

---

## 1. User Problem

Revit users need to share coloured 3D models via the app, but:
- **STEP** does not reliably preserve Revit display/view colours.
- **IFC** colour support varies and requires extra processing.
- **DXF** exported from Revit with "export solids as polymesh + display colours" does preserve colours faithfully.

DXF mesh import bridges the gap: Revit users export DXF once using a documented recipe, upload it, and get a coloured, selectable GLB that their coworkers can view and inspect via QR link.

---

## 2. Scope

**In scope (this phase):**
- DXF ASCII format, mesh entities only.
- Revit-recommended export recipe (see section 5).
- Supported entities: `3DFACE`, `POLYFACE_MESH`, `POLYMESH`, `MESH`, `INSERT`, `BLOCK`/`ENDBLK`, `LAYER` table.
- Colour chains: indexed ACI, true colour (RGB), BYLAYER, BYBLOCK.
- Block/insert hierarchy and instance reuse in GLB.
- ACIS solid detection and clear actionable errors.

**Out of scope:**
- DWG format — intentionally excluded. DWG is proprietary; parsing requires a commercial SDK (e.g. ODA Teigha) or reverse-engineered library. We avoid that dependency in this phase.
- DXF binary format.
- ACIS solid conversion — no ACIS kernel is available; we detect and reject these, guiding users to re-export.
- 2D DXF entities (LINE, ARC, LWPOLYLINE, HATCH, TEXT, etc.).
- DXF XREF (external reference) resolution.

---

## 3. Target Revit Export Workflow

### 3.1 User Steps

1. Open Revit. Create a **dedicated 3D export view** (e.g. "3D Export – Colours"). Never use the default `{3D}` view.
2. In the 3D view, hide any elements you do not want to export. Use Visibility/Graphics (VG) overrides to set display colours exactly as desired.
3. Go to **File → Export → CAD Formats → DXF**.
4. In the DXF export options dialog:
   - **Export range**: Current view only (not the entire project).
   - **Layers and properties**: By element (preserves per-element colours).
   - **Solids (3D views)**: **Polymesh** — not "ACIS solids."
   - **Colours**: **By element** (uses Revit display/override colour, not object styles).
5. Export and upload the resulting `.dxf` file to the app.

### 3.2 Why Polymesh, Not ACIS

Revit can export 3D solids as either:
- **ACIS solids** (`3DSOLID`/`BODY`): embedded SAT/SAB binary data. Cannot be triangulated without an ACIS kernel.
- **Polymesh** (`POLYLINE` flag 64 = `POLYFACE_MESH`): tessellated triangle/quad soup. Can be imported directly.

The app only supports the polymesh path. ACIS exports are detected and produce a clear error with re-export instructions.

---

## 4. Supported DXF Entity Subset

### 4.1 Supported Entities

| Entity | Encoding | Notes |
|--------|----------|-------|
| `3DFACE` | Group 0 = `3DFACE` | Triangle or quad; v3=v2 → triangle |
| `POLYFACE_MESH` | `POLYLINE` with group 70 bit 64 | Vertices (bit 64) + face records (bit 128) + `SEQEND` |
| `POLYMESH` | `POLYLINE` with group 70 bit 16 | M×N vertex grid; can be triangulated |
| `MESH` | Group 0 = `MESH` | DXF R2010+; subdivision mesh with vertex/face lists |
| `INSERT` | Group 0 = `INSERT` | Block reference: name, position, scale, rotation |
| `BLOCK` / `ENDBLK` | Block definition section | Named entity collections |
| `LAYER` table | `TABLES` section | Layer name, ACI colour, true colour, frozen flag |

### 4.2 Colour Attributes

| Source | Group Code | Priority |
|--------|-----------|----------|
| Entity true colour | 420 | Highest |
| Entity ACI (not 0, not 256) | 62 | Second |
| BYBLOCK (ACI = 0) | 62 = 0 | Inherit from INSERT context; default grey in standalone |
| BYLAYER (ACI = 256 or absent) | 62 = 256 or missing | Look up layer table |
| Layer true colour | TABLE LAYER group 420 | Third |
| Layer ACI | TABLE LAYER group 62 | Fourth |
| Default | — | `#c8c8c8` (neutral grey) |

### 4.3 Transforms

- `INSERT`: group 10/20/30 = position, 41/42/43 = scale X/Y/Z, 50 = rotation angle (degrees), 210/220/230 = extrusion direction (OCS normal). Produce a 4×4 transform matrix for each insert node in GLB.
- `BLOCK` origin: group 10/20/30 is the block's local origin (subtracted when placing block content).
- OCS (Object Coordinate System) extrusion: for production, apply the arbitrary axis algorithm to convert from entity OCS to WCS.

### 4.4 Unsupported / ACIS Entities

| Entity | Behaviour |
|--------|-----------|
| `3DSOLID` | Detected → counted in `acisEntityCount` |
| `BODY` | Detected → counted in `acisEntityCount` |
| `REGION` | Detected → counted in `acisEntityCount` |
| Proxy / custom entities | Skip, count in `skippedEntitySummary` |
| ACIS data (group 1/3 in 3DSOLID) | No attempt to parse |

---

## 5. Architecture — Where DXF Fits

### 5.1 Existing Flow

```
Upload (uploads.ts)
  ↓  allowedExtensions validates extension
  ↓  registerModelAndJob → DB record (source_ext stored)
Worker polls (worker.ts)
  ↓  getValidStepJob — currently .step/.stp only
  ↓  downloadSource, convertStepJob (converterProcessor.ts)
  ↓  XCAF binary (xcaf-baseline) or OCCT.js (occt-js)
  ↓  → display.glb, manifest.json, stats.json, xcaf-report.json, mesh-report.json
Server receives complete → marks job ready
```

### 5.2 DXF Integration Plan

**Upload validation (`apps/server/src/routes/uploads.ts`):**
- Add `.dxf` to `allowedExtensions`.
- Add DXF-specific size limit check (500 MB, same as STEP).
- Add `isGlb` / `isStep` → add `isDxf` branch for limit logic.

**Worker job validation (`apps/server/src/routes/worker.ts`):**
- Rename `getValidStepJob` → `getValidConversionJob`.
- Expand source_ext filter from `[".step", ".stp"]` to `[".step", ".stp", ".dxf"]`.
- The `complete` route already accepts any artifact — no change needed there.

**Converter dispatch (`apps/worker/src/converterProcessor.ts`):**
- Add a new `converterBackend` value: `"dxf-js"`.
- In `convertStepJob` (rename to `convertJob`), detect `input.converterBackend === "dxf-js"` and call new `convertDxfJob()` function.
- `convertDxfJob` runs the DXF→GLB pipeline (new module), then runs the existing meshopt optimizer and manifest writer.

**DXF converter module (`apps/worker/src/dxf/`):**
- `dxfParser.ts` — tokenizer + section/entity/block/layer parser (production version of the spike parser).
- `dxfColorResolver.ts` — full ACI 256-entry table + BYLAYER/BYBLOCK chain.
- `dxfToGltf.ts` — build `@gltf-transform` Document from parsed DXF scene.
- `dxfOptimizer.ts` — weld, degenerate removal, normal generation, material grouping.
- `dxfBlockCache.ts` — hash-based block definition deduplication.
- `dxfReporter.ts` — `format-report.json` and `dxf-optimization-report.json` writers.

**Worker config (`apps/worker/src/config.ts`):**
- Add `converterBackend: "dxf-js"` as valid option when source is DXF.
- Auto-detect: if `source_ext === ".dxf"` → always use `"dxf-js"`.

**DB / schema:**
- `source_ext` column already exists — no migration needed.
- No new columns required for Phase 1. Phase 2 may add `format_report_path`.

### 5.3 Architecture Decision: New Module vs New Package

**Recommendation: new module within worker, not a new package.**

Rationale:
- Worker already handles progress reporting, cancellation, GLB optimization (meshopt), and upload.
- A new package would duplicate all of that plumbing.
- The DXF parser is pure JS/TS with no native binary dependencies (unlike XCAF which needs a C++ binary).
- Can always extract to `apps/dxf-converter` later if it grows too large.

---

## 6. Smart Mesh Optimization Pipeline

### 6.1 Pipeline Overview

```
DXF Parse
  ↓ scene graph: layers, blocks (with geometry), entity list, inserts
Block Deduplication
  ↓ hash each block definition's geometry → de-duplicate identical blocks
Per-Block Mesh Processing (parallelizable per block)
  ├─ Vertex Welding (merge vertices within ε tolerance)
  ├─ Degenerate Triangle Removal (area < threshold → discard)
  ├─ Normal Generation (flat or smooth based on angle threshold)
  └─ Material Grouping (one primitive per unique layer+colour)
GLB Scene Construction
  ├─ One Mesh per unique block definition (shared across instances)
  ├─ One Node per INSERT (with transform matrix, references shared Mesh)
  └─ Top-level nodes for ungrouped entities
meshopt Compression (existing glbOptimizer.ts — fully reused)
Output → display.glb, format-report.json, dxf-optimization-report.json
```

### 6.2 Vertex Welding

- Merge vertices within ε = 1e-6 mm (configurable).
- Use a spatial hash (bucket by grid cell) for O(n) average complexity.
- Do NOT weld across different materials — would corrupt colour boundaries.

### 6.3 Degenerate Triangle Removal

- Compute triangle area via cross product.
- Discard triangles with area < 1e-12 (configurable).
- Report count in `dxf-optimization-report.json`.

### 6.4 Normal Generation

- Strategy: **flat normals by default** (appropriate for architectural/structural CAD).
- Optional smooth normals: compute face normals, average across shared-vertex neighbours where dihedral angle < threshold (default 30°).
- Flat normals: each triangle vertex gets the face normal — requires de-indexed vertices (acceptable for CAD models where flat shading is standard).
- Report strategy used in the optimization report.

### 6.5 Material Grouping

- Group primitives by `(layerName, colourHex)` pair.
- Each unique `(layer, colour)` → one `Material` in GLB.
- Material name format: `"Layer:{layerName}#{colourHex}"` (e.g. `"Layer:Walls#ff0000"`).
- All triangles sharing the same material are merged into one primitive per mesh.
- This minimises draw calls and enables the viewer to filter/highlight by layer.

### 6.6 Block Definition Caching and Instance Reuse

This is the central performance and compactness win for Revit models:

```
DXF:  BLOCK "COLUMN" → 200 triangles
      INSERT "COLUMN" at (0,0,0)
      INSERT "COLUMN" at (5,0,0) × scale(1,1,1)
      INSERT "COLUMN" at (10,0,0) × scale(2,2,2)
      ... (100 times)

GLB:  Mesh "COLUMN" → 200 triangles (stored ONCE)
      Node "COLUMN_000" → uses Mesh "COLUMN", transform = translate(0,0,0)
      Node "COLUMN_001" → uses Mesh "COLUMN", transform = translate(5,0,0)
      Node "COLUMN_002" → uses Mesh "COLUMN", transform = translate(10,0,0) * scale(2,2,2)
      ... (100 nodes, 1 mesh)
```

**Hashing strategy:**
1. For each block definition, compute a geometry hash:
   - Sorted list of (vertex positions rounded to 6dp, face index triples, material key).
   - SHA-256 of the JSON-serialised sorted representation.
2. If two block definitions have the same hash → share one GLB Mesh.
3. Per-instance transforms are applied to GLB Nodes.

**Node extras for viewer selectability:**
```json
{
  "stableObjectId": "INSERT_handle_20",
  "displayName": "COLUMN",
  "blockName": "COLUMN",
  "layer": "Columns",
  "instanceIndex": 0
}
```

### 6.7 Multicore / Task Splitting

- Per-block mesh processing is embarrassingly parallel: each block definition can be processed independently.
- Use Node.js `worker_threads` for production implementation.
- Recommended: create a `BlockMeshWorker` that receives block geometry, runs weld/degenerate/normals/material-group, and returns the result.
- Top-level coordinator spawns `Math.min(blockCount, os.cpus().length)` workers.
- For the spike: single-threaded is sufficient. Add threading in Phase 2.

### 6.8 Simplification Policy

- **No aggressive simplification** (no triangle decimation by default).
- Reason: CAD models have intentional geometry; decimation can remove thin walls or small fasteners.
- Optional `simplificationRatio` config (e.g. 0.5) for user-requested quality reduction — not enabled by default.
- The existing meshopt encoder (quantization + reindexing) provides sufficient size reduction without destroying geometry.

---

## 7. Block / Instance Reuse Design

### 7.1 GLB Scene Graph

```
Scene
└─ Node "DXF Model"
   ├─ Node "Block:COLUMN" (mesh = Mesh#0)   ← block definition as GLB Mesh
   │  extras: { "formatiqBlockDefinition": true, "blockName": "COLUMN" }
   ├─ Node "instance:COLUMN:0"               ← INSERT reference
   │  mesh = Mesh#0
   │  matrix = [insert transform 1]
   │  extras: { "stableObjectId": "...", "displayName": "COLUMN", "instanceIndex": 0 }
   ├─ Node "instance:COLUMN:1"
   │  mesh = Mesh#0
   │  matrix = [insert transform 2]
   │  ...
   └─ Node "ungrouped"                        ← 3DFACE / non-block entities
      └─ Mesh primitives (one per material)
```

### 7.2 Nested Blocks

- An INSERT within a BLOCK → nested GLB Nodes.
- Depth limit: 10 levels (configurable) to prevent infinite recursion.
- Circular block references: detect via visited-set; skip with warning.

### 7.3 Viewer Selectability

The viewer uses `extras.stableObjectId` on GLB nodes to implement click-to-select.

For DXF imports:
- `stableObjectId`: entity handle (group 5 value) if present; otherwise `"dxf_{type}_{index}"`.
- `displayName`: block name for INSERT nodes; layer name for non-block entities.
- `layer`: DXF layer name (enables layer-based filtering in the viewer).

---

## 8. Colour, Name, and Hierarchy Preservation

### 8.1 GLB Material Naming

Each unique `(layerName, colourHex)` pair → one GLB `Material`:
```
name: "Layer:Walls#ff0000"
pbrMetallicRoughness:
  baseColorFactor: [1.0, 0.0, 0.0, 1.0]
  metallicFactor: 0.0
  roughnessFactor: 0.8
```

For true-colour entities, the material also records the colour source:
```
extras: { "colorSource": "entity-truecolor", "layer": "Walls" }
```

### 8.2 Layer Hierarchy

DXF layers → GLB `extras` on meshes and nodes. Not represented as separate scene graph nodes (that would create too many hierarchy levels). Instead:
- Each primitive `extras.layer = "Walls"`.
- Top-level node `extras.layers = ["Walls", "Floor", "Ceiling"]` for quick enumeration.

### 8.3 Block Hierarchy

```
INSERT "COLUMN" on layer "Structure"
  ↓
GLB Node
  name: "COLUMN"
  extras:
    stableObjectId: "INSERT_20"
    displayName: "COLUMN"
    layer: "Structure"
    blockName: "COLUMN"
    instanceIndex: 0
```

---

## 9. Report and Manifest Design

### 9.1 `format-report.json`

Written by `dxfReporter.ts` at conversion end.

```json
{
  "schemaVersion": 1,
  "sourceFormat": "dxf",
  "dxfVersion": "AC1015",
  "sourceFileName": "revit-export.dxf",
  "sourceFileSizeBytes": 12345678,
  "entityCounts": {
    "3DFACE": 4200,
    "POLYFACE_MESH": 18,
    "POLYMESH": 0,
    "MESH": 0,
    "INSERT": 340,
    "3DSOLID": 2,
    "BODY": 0,
    "REGION": 0
  },
  "skippedEntitySummary": {
    "LINE": 150,
    "TEXT": 22
  },
  "acisEntityCount": 2,
  "layerCount": 12,
  "layers": [
    { "name": "Walls", "colorIndex": 1, "trueColor": null, "hex": "#ff0000", "frozen": false },
    { "name": "Floor", "colorIndex": 3, "trueColor": null, "hex": "#00ff00", "frozen": false }
  ],
  "blockCount": 8,
  "blocks": [
    { "name": "COLUMN", "entityCount": 12, "acisCount": 0, "triangleCount": 48 }
  ],
  "insertCount": 340,
  "insertsByBlock": { "COLUMN": 34, "BEAM": 12 },
  "warnings": [
    "2 ACIS solid(s) (3DSOLID) skipped. Re-export with solids as polymesh to include them."
  ],
  "exportAdvice": "In Revit DXF export options, set Solids (3D views) to Polymesh.",
  "conversionStatus": "partial"
}
```

### 9.2 `dxf-optimization-report.json`

```json
{
  "schemaVersion": 1,
  "converterBackend": "dxf-js",
  "sourceFileName": "revit-export.dxf",
  "geometry": {
    "rawTriangleCount": 85400,
    "rawVertexCount": 256200,
    "triangleCountAfterWelding": 85200,
    "triangleCountAfterDegenerateRemoval": 84900,
    "degenerateTrianglesRemoved": 300,
    "vertexCountAfterWelding": 94300,
    "duplicateVerticesWelded": 161900
  },
  "blocks": {
    "uniqueBlockDefinitions": 8,
    "duplicateBlockDefinitionsEliminated": 2,
    "blockCacheHits": 2,
    "totalInstanceCount": 340
  },
  "materials": {
    "uniqueMaterials": 12,
    "materialsByLayer": {
      "Walls": ["#ff0000"],
      "Floor": ["#00ff00"]
    }
  },
  "normals": {
    "strategy": "flat",
    "smoothAngleThreshold": null
  },
  "glb": {
    "rawSizeBytes": 2345678,
    "displaySizeBytes": 890123,
    "reductionPercent": 62.01
  },
  "timing": {
    "parseMs": 450,
    "meshOptimizationMs": 1200,
    "glbBuildMs": 340,
    "meshoptMs": 890,
    "totalMs": 2880
  },
  "warnings": []
}
```

### 9.3 `manifest.json` Additions

Existing manifest fields are preserved; new DXF-specific fields added:
```json
{
  "converterBackend": "dxf-js",
  "sourceFormat": "dxf",
  "dxfVersion": "AC1015",
  "artifacts": {
    "displayGlb": "display.glb",
    "manifest": "manifest.json",
    "stats": "stats.json",
    "materialDebug": "material-debug.json",
    "formatReport": "format-report.json",
    "dxfOptimizationReport": "dxf-optimization-report.json",
    "conversionLog": "conversion.log",
    "xcafReport": null,
    "meshReport": null
  }
}
```

### 9.4 `stats.json` Additions

```json
{
  "converterBackend": "dxf-js",
  "sourceFormat": "dxf",
  "dxfVersion": "AC1015",
  "triangleCount": 84900,
  "nodeCount": 342,
  "materialCount": 12,
  "blockCount": 8,
  "instanceCount": 340
}
```

### 9.5 `conversion.log` Messages

Key log lines:
```
[DXF] Parsing revit-export.dxf (AC1015, 12.3 MB)
[DXF] LAYER table: 12 layers found
[DXF] BLOCKS section: 8 block definitions found
[DXF] ENTITIES section: 4200 3DFACE, 18 POLYFACE_MESH, 340 INSERT parsed
[DXF] ACIS entities detected: 2 (3DSOLID) — will be skipped
[DXF] Block cache: 2 duplicates eliminated (8 unique → 6 stored meshes)
[DXF] Mesh optimization: 300 degenerate triangles removed, 161900 duplicate vertices welded
[DXF] GLB built: 342 nodes, 12 materials, 84900 triangles
[DXF] meshopt: 2.3 MB raw → 0.9 MB display (62% reduction)
[DXF] Completed in 2.88s
```

---

## 10. Error and Warning Messages

### 10.1 ACIS Solids Only (Hard Error)

**In-app message (upload failure):**
> "This DXF contains ACIS solids. Re-export from Revit with solids as mesh/polymesh and display colours enabled."

**How to re-export:**
> In Revit's DXF export dialog, set "Solids (3D views)" to "Polymesh" (not "ACIS solids"), then re-export.

### 10.2 Mixed: Some Mesh + Some ACIS (Partial Import)

**In-app warning (shown after upload succeeds):**
> "3 ACIS solid(s) (3DSOLID/BODY) were skipped. {N} mesh entities were imported. For a complete model, re-export with solids as polymesh."

### 10.3 No 3D Mesh Geometry (Hard Error)

> "This DXF contains no 3D mesh geometry. Ensure you are exporting a 3D view from Revit, not a plan or elevation."

### 10.4 2D Only (Hard Error)

> "This DXF appears to be a 2D drawing ({count} 2D entities detected, 0 3D mesh entities). Create a dedicated 3D view in Revit before exporting."

---

## 11. In-App Revit Export Guide

*Short enough for an upload modal help tooltip or a collapsible "?" panel.*

---

**Export 3D model from Revit as DXF**

1. **Create a 3D view**: In Revit, create a new 3D view (e.g. "3D Export – Colours"). Do not use the default `{3D}`.
2. **Set colours**: Use Visibility/Graphics (VG) overrides to set element display colours as you want them to appear.
3. **Hide unwanted elements**: Use filters or VG to turn off anything you don't need in the export.
4. **Export**: File → Export → CAD Formats → DXF.
5. **In the export dialog**:
   - Export range: **Current view only**
   - Solids (3D views): **Polymesh** ← important
   - Colours: **By element**
6. **Upload** the `.dxf` file here.

> **If you see an ACIS error after upload:** re-export with "Solids" set to "Polymesh" instead of "ACIS solids."

---

## 12. Implementation Phases

### Phase 1 — Spike (this branch)
- [x] DXF spike parser (pure JS, no production wiring).
- [x] All 5 fixture DXF files (3DFACE, POLYFACE_MESH, block/insert, layer colour, ACIS detection).
- [x] This design document.

### Phase 2 — Production Parser and GLB Builder
- [ ] `apps/worker/src/dxf/dxfParser.ts` — TypeScript port of spike parser.
- [ ] Full 256-entry ACI colour table.
- [ ] `apps/worker/src/dxf/dxfToGltf.ts` — `@gltf-transform` Document builder.
- [ ] Block cache + geometry hash.
- [ ] Vertex welding + degenerate removal + flat normals.
- [ ] Material grouping.
- [ ] `apps/worker/src/dxf/dxfReporter.ts` — format-report.json + optimization-report.json.
- [ ] Wire into `converterProcessor.ts` as `converterBackend: "dxf-js"`.
- [ ] Unit tests for parser, colour resolver, ACIS detector.

### Phase 3 — Upload and Worker Integration
- [ ] Add `.dxf` to `allowedExtensions` in `uploads.ts`.
- [ ] Expand `getValidStepJob` filter to include `.dxf`.
- [ ] Auto-select `"dxf-js"` backend when `source_ext === ".dxf"`.
- [ ] Integration test: upload fixture DXF → verify GLB produced.

### Phase 4 — Frontend
- [ ] Upload modal: show DXF in accepted formats.
- [ ] Show DXF-specific help tooltip with export guide.
- [ ] Show format-report warnings in upload result UI.
- [ ] Layer-based filtering in viewer (future, uses `extras.layer` on GLB nodes).

### Phase 5 — Production Rollout
- [ ] Deploy to EliteDesk.
- [ ] Test with real Revit DXF export.
- [ ] Monitor conversion logs and reports.

---

## 13. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Revit DXF version variation (R12 vs R2000 vs R2010) | Medium | Spike tokenizer handles all ASCII DXF versions; detect `$ACADVER` and warn if R2010+ MESH entities not fully supported |
| Coordinate system differences (OCS vs WCS) | Medium | For `3DFACE`, WCS is standard. For entities with OCS extrusion (group 210/220/230), implement arbitrary axis algorithm |
| Large DXF files with many unique blocks | Low-Medium | Block caching and parallel processing mitigate; add file-size warning at 200 MB |
| Colour fidelity (ACI palette approximations) | Low | ACI 1-9 are exact; higher indices approximate. True colour (group 420) is always exact |
| POLYLINE with both bits 16 and 64 | Low | First matching branch (bit 64 = POLYFACE_MESH) wins; this is the correct priority |
| `MESH` entity (R2010+) not fully triangulated | Medium | Detected with note; full parsing requires production work; error surfaced in format-report |
| Circular block references | Low | Visited-set depth limit (10) with warning |
| DWG files uploaded by mistake | Low | `.dwg` not in allowedExtensions; upload is rejected with "not a supported format" message |

---

## 14. DWG Scope Exclusion — Rationale

DWG is intentionally excluded from this phase:
- DWG is a proprietary binary format owned by Autodesk.
- Parsing requires a commercial SDK (ODA Teigha/Open Design Alliance) or the ageing, partially-reverse-engineered `libredwg`.
- Both options add significant complexity, licensing risk, or correctness risk.
- Revit can export DXF natively from any DWG-based workflow; there is no need for DWG parsing.

---

## 15. Recommended Next Prompt

> "Implement Phase 2 of FormatIQ DXF: create `apps/worker/src/dxf/` with TypeScript modules for the DXF parser, colour resolver, `@gltf-transform` GLB builder, block cache, vertex welder, normal generator, material grouper, and FormatIQ reporters. Wire into `converterProcessor.ts` as a new `dxf-js` backend. Add unit tests for the parser and colour resolver. Do not wire into the upload route or deploy yet."

---

## Appendix A — DXF Group Codes Quick Reference

| Code | Meaning |
|------|---------|
| 0 | Entity type / section keyword |
| 1 | Primary text string / ACIS data line |
| 2 | Name (block name, table name, etc.) |
| 5 | Handle (unique entity identifier, hex string) |
| 8 | Layer name |
| 10/20/30 | X/Y/Z of first point |
| 11/21/31 | X/Y/Z of second point |
| 12/22/32 | X/Y/Z of third point |
| 13/23/33 | X/Y/Z of fourth point |
| 41/42/43 | Scale X/Y/Z (INSERT) |
| 50 | Rotation angle in degrees (INSERT) |
| 62 | Colour index (ACI); 0=BYBLOCK, 256=BYLAYER |
| 70 | Integer flags (POLYLINE type, VERTEX type, LAYER flags, etc.) |
| 71 | Mesh M count / POLYFACE face index 1 |
| 72 | Mesh N count / POLYFACE face index 2 |
| 73 | POLYFACE face index 3 |
| 74 | POLYFACE face index 4 (0 = triangle) |
| 210/220/230 | Extrusion direction (OCS normal) |
| 420 | True colour (24-bit packed: R<<16\|G<<8\|B) |

---

## Appendix B — ACI Colour Palette (1-9)

| Index | Colour | Hex |
|-------|--------|-----|
| 1 | Red | #ff0000 |
| 2 | Yellow | #ffff00 |
| 3 | Green | #00ff00 |
| 4 | Cyan | #00ffff |
| 5 | Blue | #0000ff |
| 6 | Magenta | #ff00ff |
| 7 | White (light bg) / Black (dark bg) | #ffffff |
| 8 | Dark grey | #414141 |
| 9 | Light grey | #808080 |

Full 256-entry ACI table required in production `dxfColorResolver.ts`.

---

## Appendix C — Spike Run Instructions

```sh
cd spikes/formatiq-dxf-spike
node src/dxfSpikeParser.mjs fixtures/test-3dface.dxf
node src/dxfSpikeParser.mjs fixtures/test-polyface.dxf
node src/dxfSpikeParser.mjs fixtures/test-block-insert.dxf
node src/dxfSpikeParser.mjs fixtures/test-layer-color.dxf
node src/dxfSpikeParser.mjs fixtures/test-acis-only.dxf

# All at once:
npm test
```

Expected outcomes:
- `test-3dface.dxf`: status=`ok`, 1 × `3DFACE`, 1 triangle, ACI green.
- `test-polyface.dxf`: status=`ok`, 1 × `POLYFACE_MESH`, 4 triangles.
- `test-block-insert.dxf`: status=`ok`, 0 entities in ENTITIES, 3 INSERTs, 1 block `TRIANGLE`.
- `test-layer-color.dxf`: status=`ok`, 3 × `3DFACE`; Walls → `#ff0000`, Floor → `#00ff00`, Ceiling face → `#00ff00` (entity true-colour 65280).
- `test-acis-only.dxf`: status=`acis-only-hard-error`, 2 ACIS entities, 0 supported.
