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

If non-planar `SPLINE`, `LINE`, `ARC`, `CIRCLE`, surface, or proxy records are present without faces, report the file as unsupported surface/curve/wire/proxy geometry rather than as merely 2D. These records may carry useful 3D coordinates, but they do not define polygon faces and must not be triangulated by guesswork.

> "Rhino users: mesh the model first, then export DXF as mesh/polygon mesh. NURBS surfaces, curves, wires, and solids are not supported by the free DXF importer."

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

### Phase 2A — Core DXF Worker Backend (DONE — `feature/formatiq-dxf-worker-backend`)

**Branch:** `feature/formatiq-dxf-worker-backend`
**Starting commit:** `edb8822`
**Date:** 2026-06-28

#### Module structure (`apps/worker/src/dxf/`)

| File | Purpose |
|------|---------|
| `types.ts` | All shared types: DxfLayer, DxfBlock, Dxf3DFace, DxfPolyfaceMesh, DxfMeshEntity, DxfInsert, DxfAcisEntity, Triangle, MaterialGroup, OptimizationStats, DxfFormatReport, DxfOptimizationReport |
| `colors.ts` | Full 256-entry ACI colour table (generated from hue-wheel formula), resolveColor(), rgbToHex(), materialKey() |
| `parseDxf.ts` | Production TypeScript DXF parser: tokenize, splitSections, parseLayers, parse3DFace, parsePolylineAsMesh, parseMeshEntity, parseInsert, parseAcisEntity, parseEntitySection, parseBlocks, parseDxf() |
| `geometry.ts` | extractTrianglesFromEntity(), extractAllTriangles() — handles 3DFACE, POLYFACE_MESH, POLYMESH, skips MESH |
| `meshOptimize.ts` | optimizeMesh(): vertex welding (spatial grid, 1e-6 tolerance), degenerate triangle removal (area threshold 1e-12), flat normal generation, material grouping |
| `blocks.ts` | hashBlockGeometry() (SHA-256 for future dedup), insertRotationQuaternion() (Z-axis rotation to quaternion) |
| `buildGlb.ts` | buildGlb(): @gltf-transform Document builder — shared Mesh per block def, instance Nodes per INSERT, material cache, POSITION + NORMAL accessors, extras on nodes |
| `reports.ts` | buildFormatReport(), buildOptimizationReport(), buildStats(), buildManifest() |
| `convertDxfToGlb.ts` | Top-level orchestrator: parse → format-report → validate → optimize → GLB → all artifact files |
| `fixtures/` | Test DXF fixtures (copied from spike) |

#### Supported entities (Phase 2A)
- [x] `3DFACE` — triangle and quad (split to 2 triangles)
- [x] `POLYFACE_MESH` (POLYLINE bit 64) — face record triangulation
- [x] `POLYMESH` (POLYLINE bit 16) — face record triangulation
- [x] `INSERT` — block instance with translation/scale/Z-rotation
- [x] `BLOCK`/`ENDBLK` — block definitions
- [x] `LAYER` table — name, ACI colour, true colour, frozen flag
- [x] ACI colour (full 256-entry table with hue-wheel formula)
- [x] True colour (group 420, 24-bit packed RGB)
- [x] BYLAYER colour resolution
- [x] BYBLOCK colour resolution (sentinel, grey fallback in Phase 2A)
- [x] Layer names, block names, entity handles in GLB extras

#### Detected and reported (not converted)
- [x] `3DSOLID` → `acis-only-hard-error` or `partial-with-warnings`
- [x] `BODY` → same
- [x] `REGION` → same
- [x] `MESH` (R2010+) → detected, triangleCount=0, warning in format-report
- [x] 2D POLYLINE → counted as skipped
- [x] Unknown entities → counted in skippedEntitySummary

#### GLB generation
- Shared Mesh per block definition (block reuse via INSERT nodes)
- One Node per INSERT with T/R/S transform from DXF INSERT attributes
- Ungrouped 3DFACE/POLYFACE_MESH entities as a single Mesh with multiple primitives per material
- Materials from (layer, colour) pairs: `baseColorFactor`, `metallicFactor=0`, `roughnessFactor=0.8`
- Node `extras`: `stableObjectId`, `displayName`, `layer`, `blockName`, `sourceFormat`, `entityType`, `entityHandle`, `insertName`

#### Block/instance reuse
- Block definitions built as GLB Mesh objects once each
- Multiple INSERT Nodes reference the same Mesh (GLB block instancing)
- `hashBlockGeometry()` computes SHA-256 for future geometry-hash dedup (Phase 2B)

#### Mesh optimization
- Vertex welding: spatial grid at 1e-6 tolerance per material group
- Degenerate triangle removal: cross-product area < 1e-12
- Flat normal generation (correct for CAD models)
- Material grouping: one primitive per (layer, colourHex) pair
- Stats: rawTriangleCount, degenerateTrianglesRemoved, outputTriangleCount, duplicateVerticesWelded

#### Artifact files written
- `display.glb` — valid GLTF binary
- `format-report.json` — DXF entity/layer/block/insert/ACIS counts, status, warnings, Revit export advice
- `dxf-optimization-report.json` — geometry stats, block stats, material stats, timing
- `manifest.json` — converterBackend=dxf-js, sourceFormat=dxf, artifact list
- `stats.json` — triangleCount, nodeCount, materialCount, blockCount, instanceCount
- `material-debug.json` — placeholder
- `conversion.log` — structured log lines

#### Test fixtures (in `apps/worker/src/dxf/fixtures/`)
- `test-3dface.dxf` — 1 triangle (3DFACE), ACI green
- `test-polyface.dxf` — 4-triangle tetrahedron (POLYFACE_MESH)
- `test-block-insert.dxf` — block TRIANGLE + 3 INSERTs
- `test-layer-color.dxf` — 3 faces on 3 layers, BYLAYER + entity trueColor
- `test-acis-only.dxf` — 2 ACIS entities (3DSOLID + BODY), no mesh

#### Tests (59 total, all pass — `apps/worker/src/dxf.test.ts`)
- 5 parseDxf unit tests
- 5 resolveColor unit tests
- 3 extractAllTriangles unit tests
- 5 convertDxfToGlb integration tests (one per fixture)

#### Local development CLI
- `apps/worker/scripts/convert-dxf-fixture.ts` — accepts DXF path, writes artifacts to temp dir, prints log

#### What remained unwired after Phase 2A
- `.dxf` NOT in production `allowedExtensions`
- DXF NOT in production worker job dispatch
- No production deploy
- No UI changes

#### Phase 2A risks addressed or carried into Phase 2B
- OCS extrusion: simple supported entities and INSERTs now use the arbitrary-axis transform; broader real-file coverage remains a risk.
- `MESH` entity (R2010+): level-0 vertex/face-list triangulation was completed in Phase 2C; subdivision evaluation and property overrides remain out of scope.
- BYBLOCK colour: recursive INSERT-chain inheritance was completed in Phase 2C.
- Meshopt: integrated with semantic validation and raw fallback.
- Circular/nested block references: recursive rendering with cycle and depth guards was completed in Phase 2C.

#### Phase 2B status
Completed internally; see the Phase 2B implementation notes at the end of this document.

---

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
| Revit DXF version variation (R12 vs R2000 vs R2010) | Medium | Parser detects `$ACADVER`; R2010+ level-0 MESH face lists are covered by a hand-authored fixture, while advanced subdivision/property data remains a risk |
| Coordinate system differences (OCS vs WCS) | Medium | Arbitrary-axis conversion is implemented for faces, polyfaces, MESH vertices, and INSERT translation/orientation; representative face and INSERT bounds are tested |
| Large DXF files with many unique blocks | Low-Medium | Block caching and parallel processing mitigate; add file-size warning at 200 MB |
| Colour fidelity (ACI palette approximations) | Low | ACI 1-9 are exact; higher indices approximate. True colour (group 420) is always exact |
| POLYLINE with both bits 16 and 64 | Low | First matching branch (bit 64 = POLYFACE_MESH) wins; this is the correct priority |
| Advanced `MESH` data (subdivision, creases, property overrides) | Medium | Level-0 vertex and face lists triangulate; advanced data stays explicitly out of the current support claim |
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

---

## Phase 2B — Internal Worker Wiring and Geometry Correctness (DONE)

**Branch:** `feature/formatiq-dxf-worker-backend`

**Starting commit:** `e0b294d`
**Date:** 2026-06-28

### Backend wiring result

- `ConverterProcessorInput.converterBackend` accepts `"dxf-js"` for direct internal calls.
- `convertStepJob()` dispatches that backend to `convertDxfToGlb()` before STEP chunking or native converter logic.
- The environment-backed production worker configuration remains restricted to `occt-js` and `xcaf-baseline`, preventing DXF jobs from being selected by the polling worker.
- Server/admin allow-lists remain `.step`, `.stp`, `.glb`, and `.gltf`; `.dxf` is still hidden from users.
- STEP and GLB paths are unchanged.

### Generated artifacts

Successful internal DXF jobs write `display.glb`, `manifest.json`, `stats.json`, `format-report.json`, `dxf-optimization-report.json`, `material-debug.json`, and `conversion.log`. `display.raw.glb` is retained as optimizer input, matching the existing generated-GLB worker convention.

### Meshopt result

- DXF output now runs through the existing `optimizeDisplayGlb()` path when `glbOptimizationMode` is `meshopt`.
- The semantic validator guards hierarchy counts, names, extras and selection IDs, material assignments and PBR colours, triangle counts, and quantized bounds.
- A validated candidate that is not smaller falls back to raw GLB with `skipped-not-smaller`. Optimization or validation failure falls back with `failed` and an explicit message.
- `stats.json` and `dxf-optimization-report.json` record mode, outcome, raw/display byte counts, reduction, validation, fallback, and timing.

### OCS/extrusion handling

- Group codes 210/220/230 are parsed for `3DFACE`, mesh `POLYLINE`, `MESH`, and `INSERT`.
- Non-default extrusion vectors on supported faces/polyfaces are transformed from OCS to WCS with the arbitrary-axis algorithm.
- INSERT translation and orientation use the same OCS basis.
- `format-report.json` records explicit, transformed, and unsupported extrusion counts.
- OCS data on detect-only `MESH` entities is reported but cannot affect geometry because `MESH` is not triangulated.

### Colour inheritance

- Entity true colour remains highest priority, followed by explicit entity ACI and BYLAYER lookup.
- A BYBLOCK entity in a simple block inherits the resolved colour of its INSERT. Block mesh caching is keyed by inherited colour only when the block contains BYBLOCK geometry.
- Nested block INSERTs are detected and warned about. Recursive nested geometry and recursive BYBLOCK inheritance remain deferred rather than represented incorrectly.

### MESH and ACIS handling

- R2010+ `MESH` remains detected/skipped; no fake triangulation was added.
- MESH counts and warnings appear in `format-report.json`. MESH-only/2D-only input returns `no-usable-3d-geometry`.
- ACIS-only input still fails with re-export guidance. Supported mesh plus ACIS succeeds as `partial-with-warnings` and reports skipped solids.
- DWG and ACIS conversion remain out of scope.

### Internal CLI

The CLI uses the same `converterProcessor` dispatch as tests and does not access the app database or production storage:

```sh
cd apps/worker
npm run dxf:convert -- path/to/model.dxf path/to/output-folder
```

The output folder receives a slug subdirectory. Omitting it uses a temporary directory.

### Tests added

- Internal `converterProcessor` dispatch and seven-artifact contract.
- Non-empty GLB and meshopt/fallback reporting.
- Non-default OCS transform and report counts.
- BYLAYER, true-colour override, and simple BYBLOCK INSERT inheritance.
- ACIS-only rejection and mesh-plus-ACIS partial warning.
- MESH-only detection, warning, and `no-usable-3d-geometry` rejection.
- Existing STEP/chunking, optimizer, merge, quality, and worker-pool tests remain in the full worker suite.

### Remaining risks and recommended Phase 2C

- Nested block geometry and recursive BYBLOCK/BYLAYER context are not rendered yet.
- Real-world OCS combinations need larger Revit/AutoCAD fixtures; current coverage proves one non-default arbitrary-axis path.
- R2010+ `MESH` triangulation needs a fixture proving vertex/face-list semantics before implementation.
- Large real DXF performance and material cardinality have not been benchmarked.
- Upload/server job selection, worker artifact upload fields, and UI warnings remain intentionally unwired.

> Recommended Phase 2C prompt: Implement recursive nested BLOCK/INSERT traversal with a depth limit and cycle detection, complete nested BYBLOCK/BYLAYER context inheritance, and add larger representative OCS and R2010+ MESH fixtures. Implement MESH triangulation only if face-list tests prove correctness. Keep `.dxf` out of server/admin upload allow-lists, do not deploy, and preserve existing STEP/GLB paths.

---

## Phase 2C — Recursive Blocks, OCS Fixtures, and Level-0 MESH (DONE)

**Branch:** `feature/formatiq-dxf-worker-backend`
**Starting commit:** `c3a36a4100acb40b2a7ec8f57ee70f4e189e4dfa`
**Date:** 2026-06-28

### Nested BLOCK/INSERT traversal

- `blockTraversal.ts` analyzes reachable top-level and nested INSERT chains before GLB construction.
- GLB construction recursively emits a selection node for every reachable INSERT and composes translation, scale, rotation, block base-point offset, and the existing OCS orientation through the node hierarchy.
- The default maximum rendered block depth is 10. A deeper branch is skipped with an explicit path warning.
- The active block-name stack detects circular references. Only the circular branch is skipped; conversion continues with any usable geometry already reached.
- Node names and extras preserve block names, INSERT handles, nesting depth, parent block, and full block path.

### Nested colour inheritance

- Entity true colour remains authoritative, followed by explicit entity ACI.
- BYLAYER entities continue to resolve from their own DXF layer table entry.
- BYBLOCK geometry inherits the immediate INSERT colour context.
- A BYBLOCK INSERT inherits its parent INSERT context recursively, so a concrete colour can flow through multiple nested blocks. If no concrete ancestor exists, the existing default colour is used.
- Tests prove simple and nested BYBLOCK, nested BYLAYER, and nested true-colour override behavior.

### Block and mesh reuse

- INSERT hierarchy nodes are created per instance, while direct block geometry stays shared.
- The mesh cache key uses the block geometry hash, block origin, and inherited colour only when BYBLOCK geometry makes colour instance-dependent.
- Identical direct block geometry can therefore share one GLB Mesh across repeated or differently named definitions when safe.
- `dxf-optimization-report.json` records total and nested instances, unique rendered meshes, mesh reuse count, and duplicated triangles avoided.

### OCS fixture coverage

- `test-ocs-face-transform.dxf` is a non-default-extrusion quad with stable WCS bounds `[-2, 0, 0]` to `[0, 0, 3]`.
- `test-ocs-insert-transform.dxf` combines non-default extrusion, 90-degree rotation, non-uniform scale, and translation; its GLB world bounds are `[-4, 6, 5]` to `[-1, 6, 7]`.
- Reports and logs record explicit extrusion entities, transformed entities, and unsupported non-default extrusion warnings. Both representative fixtures report zero unsupported transforms.

### R2010+ MESH decision

Real level-0 triangulation is implemented. Autodesk's MESH DXF structure provides:

- group 71: MESH version;
- group 72: blend-crease flag;
- group 91: subdivision level;
- group 92 followed by repeated 10/20/30: level-0 vertex count and coordinates;
- group 93 followed by group 90 integers: face-list size and face-list items;
- each face-list record begins with its vertex count, followed by zero-based vertex indices.

The parser validates declared counts and indices, then fan-triangulates each valid polygon. Invalid or incomplete face-list items are skipped and reported; subdivision evaluation, crease processing, edges, and per-subentity property overrides are not claimed. The hand-authored AC1024 `test-mesh-only.dxf` fixture contains one quad face and proves exactly two output triangles. Structure reference: [Autodesk MESH DXF group codes](https://help.autodesk.com/cloudhelp/2015/ENU/AutoCAD-DXF/files/GUID-4B9ADA67-87C8-4673-A579-6E4C76FF7025.htm).

### Reports and logs

`format-report.json` now includes:

- `nestedInsertCount`, `maxBlockNestingDepth`, `blockCycleWarningCount`, and `blockDepthLimitWarningCount`;
- `mesh.triangulationStatus`, entity/triangle counts, and invalid-face count;
- the OCS explicit/transformed/unsupported summary and unsupported warning count.

`dxf-optimization-report.json` now includes recursive instance counts, unique rendered mesh count, reuse count, and measurable triangle duplication avoided. `conversion.log` has concise nested traversal, cycle/depth warning, MESH outcome, OCS summary, and mesh-reuse lines.

### Fixtures and tests

Phase 2C adds or strengthens:

- `test-nested-blocks.dxf` — three levels, repeated top instances, cumulative transforms, nested BYBLOCK, BYLAYER, and true colour;
- `test-block-cycle.dxf` — `A -> B -> A` branch protection with valid retained geometry;
- `test-block-depth-limit.dxf` — depth 11 chain proving the default limit of 10;
- `test-ocs-face-transform.dxf` and `test-ocs-insert-transform.dxf` — objective transformed bounds;
- `test-mesh-only.dxf` — valid AC1024 level-0 MESH quad proving two triangles.

The full worker suite passes 75 tests, including existing STEP chunking, MeshIQ configuration, GLB optimizer/validation, GLB merge, quality mapping, and worker-pool coverage.

### Scope and rollout state

- `.dxf` is still absent from server and admin upload allow-lists.
- Production polling cannot select `dxf-js` from environment configuration.
- DWG parsing and ACIS solid conversion were not added.
- No production deployment, migration, database/storage mutation, or public/QR URL change is part of Phase 2C.

### Remaining risks

- Real Revit and AutoCAD export corpora are still needed to validate vendor/version variation, large-file performance, and material cardinality.
- MINSERT row/column arrays, advanced MESH subdivision/crease/property records, malformed face-list recovery beyond branch skipping, and XREF resolution remain unsupported.
- Block layer-0 inheritance and unusual nested non-uniform-scale/rotation combinations need representative real-export fixtures beyond the current deterministic cases.
- DXF upload, server job selection, UI guidance, and production rollout remain intentionally unwired.

> Recommended Phase 2D prompt: Build a sanitized real-export compatibility corpus for Revit and AutoCAD DXF, add MINSERT row/column expansion and explicit block layer-0 inheritance tests, harden malformed MESH diagnostics and large-file limits, and benchmark recursive block/material cardinality. Keep DXF uploads hidden and do not deploy until the corpus and rollout plan are reviewed.

---

## Phase 2D — Real-Export Compatibility Hardening (DONE)

**Branch:** `feature/formatiq-dxf-worker-backend`
**Starting commit:** `6e8e18887c9d250f9d5bdda32104b12483300cf5`
**Date:** 2026-06-28

### Fixture and private-sample policy

- `docs/formatiq-dxf-fixture-policy.md` defines the commit boundary: tiny hand-authored fixtures, synthetic geometry, and properly licensed public samples are allowed; coworker/customer exports, production models, and confidential geometry are forbidden.
- Private samples belong in ignored `.tmp/formatiq-private-samples/`; results belong in `.tmp/formatiq-compatibility-results/`.
- `npm run dxf:compat` processes every private `.dxf` locally and produces a console/JSON compatibility table without contacting the database, upload API, or production storage.

### MINSERT

- INSERT group codes `70`/`71` and `44`/`45` are parsed as column/row counts and spacing. An INSERT with more than one row or column is represented as source type `MINSERT`.
- Arrays expand to lightweight GLB nodes. Block definitions and heavy Mesh objects remain shared through the existing geometry cache.
- Array offsets follow rotated local row/column axes and are transformed through OCS when a non-default extrusion is present. INSERT scale remains on the shared block geometry transform.
- Node extras preserve `sourceEntityType`, block name, original handle, display name, row/column index and counts, effective/source layer, and stable per-cell identity.

### Layer 0 inheritance

- Block geometry on layer `0` inherits the effective layer of its INSERT. The rule composes through nested layer-0 INSERTs.
- Geometry on a nonzero block layer remains on that layer.
- Colour is resolved at render time using the effective layer: true colour and explicit ACI remain authoritative, BYBLOCK uses INSERT colour context, and BYLAYER on layer `0` uses the inherited INSERT layer.
- Mesh cache keys include the inherited layer only when a block contains layer-0 geometry, preserving reuse without cross-layer material leakage.

### MESH diagnostics

- Valid level-0 MESH fan triangulation remains unchanged.
- Structured diagnostic codes cover missing vertices, declared-count mismatches, missing/malformed face lists, out-of-range indices, unsupported subdivision, and unsupported crease data.
- A malformed MESH is skipped without crashing. Supported sibling geometry still converts with `partial-with-warnings`; malformed-MESH-only input reports `no-usable-3d-geometry` before the converter returns an error.
- Subdivision/crease files may import the valid level-0 control cage, but reports explicitly state that subdivision and crease evaluation were not performed.

### Reports and logs

- `format-report.json` adds raw MINSERT count, expanded MINSERT instance count, inherited layer-0 occurrence count/summary, malformed MESH warning count, and structured MESH diagnostics.
- `dxf-optimization-report.json` adds expanded MINSERT instances, traversal timing, material-cardinality warning above 256 materials, and retains reuse/avoided-duplication measurements.
- `conversion.log` includes concise MINSERT expansion, layer-0 inheritance, and individual malformed-MESH diagnostic lines. Benchmark mode appends a synthetic benchmark summary to its ignored local report/log copy.

### Synthetic benchmark tooling

`npm run dxf:benchmark` manually generates and converts five safe cases under `.tmp/formatiq-benchmarks/`: repeated INSERTs, six-level nested blocks, an MINSERT grid, many layers/materials, and a curved level-0 MESH. `-- --quick` runs reduced cases for tooling verification. The summary records parse, traversal, mesh optimization, GLB build, meshopt, total time, sampled heap/RSS change, triangles, materials, and output size. Benchmark output is never part of the normal test suite or Git.

Rough development-machine guardrails (not production SLAs):

- quick suite completes in under 30 seconds;
- default suite completes in under 2 minutes without an out-of-memory failure;
- the 6,400-cell default MINSERT case retains one shared direct block mesh where colour/layer context permits;
- parse plus traversal should not dominate total time for repeated-instance cases;
- more than 256 generated materials produces an explicit cardinality warning for corpus review.

### Fixtures and tests

- `test-minsert-layer0.dxf` covers a 2×3 transformed MINSERT, nested layer-0 inheritance, BYLAYER colour through `PIPES`, nonzero `FIXED` layer preservation, per-cell metadata, and mesh reuse.
- Missing-vertex, malformed-face-list, out-of-range-index, and subdivision/crease MESH fixtures cover actionable recovery and hard-error behavior.
- Existing Phase 2A/2B/2C tests remain in the full worker suite, along with existing STEP/GLB paths.

### Rollout state and remaining risks

- DXF upload, server job selection, and admin/public accepted extensions remain intentionally unwired.
- DWG and ACIS conversion remain out of scope; ACIS is still detected and rejected/reported only.
- No private Revit/AutoCAD corpus was committed. Real exporter/version coverage still depends on running the local harness against authorized private samples and reproducing findings synthetically.
- Advanced MESH subdivision, crease, edge, per-subentity property overrides, binary DXF, XREF resolution, and hostile-input resource limits remain unsupported.
- Sampled memory deltas are coarse process observations, not a true peak-memory profiler. Very large (hundreds of MB) private exports still require controlled local benchmarking before rollout.

> Recommended Phase 2E prompt: Run the local compatibility harness against an authorized set of real Revit and AutoCAD ASCII DXF exports, record only anonymized aggregate results, reproduce any failures as minimal synthetic fixtures, add parser resource ceilings/fuzz cases, and produce a reviewed upload/rollback plan behind a disabled feature flag. Keep DXF uploads hidden and do not deploy until the corpus, limits, and migration-free rollout plan are explicitly approved.

---

## Rhino wire-export hardening and optional converter sidecars

The native free path remains first and authoritative: TypeScript `dxf-js` parsing of explicit polygon mesh records. A 3D DXF containing only curves, wires, NURBS surfaces, or proxies is not a hidden mesh; without face topology, the importer cannot produce a trustworthy model. The local `npm run dxf:inspect -- <input.dxf>` command records anonymized entity, block, flag, coordinate, and zero-triangle diagnostics under ignored `.tmp/` storage without touching the app database or production storage.

Rhino or AutoCAD conversion may be evaluated later as an optional manual/commercial sidecar fallback, never as a dependency of the native Linux worker. A sidecar should run on a separate Windows machine or VM, consume a separate queue, enforce a strict timeout, and initially process one job at a time. Private inputs and outputs must remain outside Git. The sidecar must not expose Cloudflare or router ports and must not mutate the production database except through the worker's normal artifact-completion contract.

- Rhino.Compute is a plausible server-style geometry path, but it is Windows-based and requires Rhino licensing; it is not a free Linux EliteDesk-native solution.
- AutoCAD automation may provide stronger DWG/DXF fidelity, but its licensing and unattended-automation constraints require a separate evaluation before implementation.
- BricsCAD, ODA, and ARES are later evaluation candidates only.

No sidecar dependency, DWG support, ACIS conversion, or proprietary SDK is added in this phase.
