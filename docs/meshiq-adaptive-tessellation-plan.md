# MeshIQ Adaptive Tessellation Plan

## Scope

MeshIQ is a planning-only investigation for smarter STEP to GLB conversion. The current production system is live at main commit `d294769a5b2dfe28a8d9daf3acbb3ea58ddc7716`, and this document does not change converter behavior, production data, uploaded models, share links, Cloudflare, the Pi, or any EliteDesk services.

The goal is to prepare a safe implementation path for:

- per-shape mesh statistics
- adaptive OpenCascade tessellation
- selective small-part simplification
- mesh quality reporting
- integration with the existing quality presets, worker logs, and admin-visible artifacts

## Current Converter Architecture

There are two STEP conversion paths in the repo.

### `occt-import-js` path

The legacy JavaScript converter lives in `apps/converter`.

- CLI entrypoint: `apps/converter/src/cli.js`
- STEP import and GLB creation: `apps/converter/src/convertStepToGlb.js`
- STEP read worker: `apps/converter/src/readStepWorker.js`
- GLB readback validator: `apps/converter/src/validateGlb.js`
- stats writer: `apps/converter/src/stats.js`

The CLI validates input, creates the output directory, writes `conversion.log`, invokes `convertStepToGlb`, writes `stats.json`, and validates the GLB before reporting success. The actual STEP read is isolated in a Node `worker_threads` worker so the CLI can continue logging heartbeats during the long `OCCT ReadStepFile` stage.

`convertStepToGlb.js` calls `occt.ReadStepFile(fileContent, options)` through `readStepWorker.js`. The options passed to `occt-import-js` are global per conversion, not adaptive per shape:

- `linearUnit: "millimeter"`
- `linearDeflectionType: "bounding_box_ratio"`
- `linearDeflection`
- `angularDeflection`

After import, the converter validates non-empty meshes and root nodes, traverses the returned OCCT-import node tree, creates glTF meshes and primitives with `@gltf-transform/core`, preserves node and mesh names where available, splits primitives by BREP face material runs, writes `material-debug.json`, writes `display.raw.glb`, and validates it by reading it back.

This path does not expose direct XCAF traversal or direct `BRepMesh_IncrementalMesh` control from repo code. Tessellation happens inside `occt-import-js` during `ReadStepFile`.

### Native XCAF path

The native OpenCascade/XCAF converter source lives in `spikes/occt-xcaf-glb/src/main.cpp`. Despite the `spikes` path, the worker can call the native binary when `converterBackend` is `xcaf-baseline`.

The native flow is:

1. Read STEP with `STEPCAFControl_Reader::ReadFile`.
2. Transfer to an XCAF document with `reader.Transfer(doc)`.
3. Read the XCAF shape, color, and layer tools from `XCAFDoc_DocumentTool`.
4. Parse raw STEP presentation styles for diagnostics and optional step-presentation color mode.
5. Scan topology and write `body-inventory.json`.
6. Traverse XCAF labels recursively.
7. Mesh leaf/render shapes using `BRepMesh_IncrementalMesh`.
8. Build GLB primitives while preserving label paths, instance paths, display names, colors, materials, and baked transforms.
9. Write `display.glb`, `xcaf-report.json`, `material-style-profile.json`, `conversion-profile.json`, `prototype-reuse-report.json`, and `conversion.log`.

The core meshing calls are currently the 5-argument `BRepMesh_IncrementalMesh(shape, linearDeflection, relative, angularDeflection, parallel)` constructor. This is called:

- for reusable local shapes when mesh reuse is safe
- for non-reusable render shapes in world coordinates
- for fallback/world mesh paths during extraction

The native converter currently does not use `IMeshTools_Parameters`. No direct `IMeshTools_Parameters` references exist in the source. That means boundary deflection, interior deflection, control surface deflection, minimum size, and other advanced mesher knobs are not currently represented as structured parameters.

### Worker pipeline

The worker integration lives in `apps/worker/src/converterProcessor.ts`.

The worker chooses between:

- `occt-js`, which invokes `apps/converter/src/cli.js`
- `xcaf-baseline`, which invokes the native XCAF binary

For native conversions, the worker passes:

- semantic quality mapped to native preset
- `--colour-mode`
- `--colour-space raw`
- `--parallel-mesh on|off`
- debug flags
- `--enable-mesh-reuse` by default unless disabled by environment

The worker asserts expected output files, creates compatibility `stats.json` and `material-debug.json` for XCAF output, optionally optimizes the final GLB, writes `manifest.json`, and attaches conversion, optimization, and large-step chunking metadata.

Large STEP chunking is already present in the worker. It can run a planner binary, convert chunks, merge GLBs, aggregate `xcaf-report.json` files, and run the same final optimization/report path. Adaptive tessellation should be compatible with both normal conversion and chunked conversion.

### Server quality handling

The server accepts semantic qualities only:

- `low`
- `medium`
- `high`

`apps/server/src/quality.ts` parses and validates these values. The worker maps them to the converter-specific presets.

### Post-processing and meshopt

GLB optimization lives in `apps/worker/src/glbOptimizer.ts`.

Current optimization uses:

- `reorder({ target: "size" })`
- `quantize(...)`
- accessor-only `prune(...)`
- accessor-only `dedup(...)`
- `EXT_meshopt_compression`

This is compression, packing, quantization, and accessor cleanup. It is not geometric simplification. There is no current per-part triangle reduction, decimation, or `simplify()` pass.

## Current Quality Presets

### Server and worker semantic mapping

| Semantic quality | Native preset | Native linear deflection | Native angular deflection | Native relative mode | occt-js preset |
| --- | --- | ---: | ---: | --- | --- |
| `low` | `preview` | `0.85` | `0.65` | `true` | `fast` |
| `medium` | `balanced` | `0.45` | `0.50` | `true` | `balanced` |
| `high` | `high` | `0.12` | `0.22` | `true` | `detailed` |

The native values are duplicated in `apps/worker/src/quality.ts` and `spikes/occt-xcaf-glb/src/main.cpp`. They currently match.

### Native XCAF CLI presets

| Native preset | Linear deflection | Angular deflection | Relative mode | Parallel mesh mode | Mesh reuse |
| --- | ---: | ---: | --- | --- | --- |
| `preview` / `low` | `0.85` | `0.65` | `true` | `on` by default, `off` with `XCAF_PARALLEL_MESH=off` | enabled by default |
| `balanced` | `0.45` | `0.50` | `true` | `on` by default, `off` with `XCAF_PARALLEL_MESH=off` | enabled by default |
| `high` | `0.12` | `0.22` | `true` | `on` by default, `off` with `XCAF_PARALLEL_MESH=off` | enabled by default |

Native debug mode `--debug-super-coarse-mesh` overrides the active preset to `linearDeflection=5.0`, `angularDeflection=1.5`, `relative=true`. This is a diagnostic path, not a production preset.

### occt-js CLI presets

| occt-js preset | Linear deflection | Angular deflection | Linear deflection type | Relative/absolute mode | Parallel mesh mode | Meshopt settings |
| --- | ---: | ---: | --- | --- | --- | --- |
| `fast` | `0.5` | `1.0` | `bounding_box_ratio` | handled internally by `occt-import-js` | not exposed | none in converter |
| `balanced` | `0.1` | `0.5` | `bounding_box_ratio` | handled internally by `occt-import-js` | not exposed | none in converter |
| `high` / `detailed` | `0.035` | `0.25` | `bounding_box_ratio` | handled internally by `occt-import-js` | not exposed | none in converter |

The worker can later run the same final GLB optimization regardless of converter backend. Current meshopt options are independent of quality preset:

- mode: `disabled` or `meshopt`
- quantization: POSITION 16, NORMAL 12, TEXCOORD 14, GENERIC 16, COLOR 8
- `EXT_meshopt_compression` required when applied
- fallback to raw GLB if optimization fails or is not smaller

## Existing Mesh Statistics

### Already recorded

`stats.json` from the JS converter records:

- source file name and size
- output GLB size
- processing seconds
- converter name and version
- quality preset
- success, warnings, errors
- total triangle count
- total node count
- total mesh count
- object count
- validation summary
- import options used
- OCCT metadata stats
- material stats
- normal stats

`xcaf-report.json` from the native converter records:

- quality preset, linear deflection, angular deflection, relative mode
- summary counts including vertices, triangles, labels processed, shapes tessellated, primitive count, material count, skipped/failed shapes, cache hits/misses, reused/fresh instances, unique stored triangles, GLB bytes, conversion seconds
- global bounding box
- top objects by triangle count
- top objects by bounding box size
- object entries with label path, instance path, display name, resolved names, layer, color/material metadata, shape type, local and world bounding boxes, face count, and triangle count
- transform samples and color diagnostics

`conversion-profile.json` records coarse stage timings. `conversion.log` records per-shape meshing start/end timings for the non-reuse path and local cache-build timings for reused prototypes.

### Missing or incomplete for MeshIQ

The current reports do not yet provide a single `mesh-report.json` focused on mesh quality. Missing pieces include:

- per-part vertex count in the object list
- per-part density score
- per-shape meshing time as structured JSON
- per-shape deflection values used, once adaptive settings exist
- pre/post simplification triangle and vertex counts
- simplification ratio by part/primitive
- top tiny dense parts ranked by density
- top large sparse parts ranked by low triangle density or faceting risk
- top slow mesh parts as structured report entries
- warnings and recommendations generated from thresholds

The best place to add instrumentation is the native XCAF converter first, around the existing `BRepMesh_IncrementalMesh` calls and the `MeshPrimitive` construction. The second integration point is `apps/worker/src/converterProcessor.ts`, which should copy or expose `mesh-report.json` alongside `stats.json`, `xcaf-report.json`, and `material-debug.json`.

## Problem Diagnosis

The current native XCAF path uses one global deflection pair per quality preset. Because native mode uses relative deflection, each shape gets some scale awareness already, but it is still coarse:

- a tiny dense detailed part can generate a high triangle count relative to its visibility or physical importance
- a large cylinder, tank, pipe, or curved panel can remain visibly faceted because angular deflection is global
- repeated small details can multiply triangle cost
- mesh reuse can help repeated geometry but does not reduce the base mesh density
- meshopt compression reduces bytes but does not reduce triangle count

The better strategy is not "make everything high quality". It is to spend triangles where they improve visible shape and spend fewer where they are hard to see or already too dense.

## Proposed Adaptive Tessellation Algorithm

Adaptive tessellation should be implemented in the native XCAF path behind an explicit flag. The occt-js path can remain unchanged unless later retired.

### Inputs

For each leaf or render shape:

- assembly bounding box diagonal
- shape local bounding box diagonal
- shape world bounding box diagonal
- surface/face count
- current quality preset
- shape name, label path, instance path
- mesh reuse eligibility
- color/style mode, because face-styled shapes may be split differently
- optional future admin/user hints

### Size ratio

Compute:

```text
assemblyDiag = diagonal(globalBoundingBox)
shapeDiag = diagonal(shapeWorldBoundingBox)
sizeRatio = clamp(shapeDiag / assemblyDiag, 0.0, 1.0)
```

Also compute an approximate volume ratio if bbox volume is useful, but diagonal ratio should be the first implementation because it is stable for long tubes and panels where volume can be misleading.

### Per-preset adaptive bands

Start with the existing native preset as the baseline. Then compute a shape deflection multiplier based on size.

Suggested initial table:

| Semantic quality | Base native preset | Min linear multiplier | Max linear multiplier | Min angular | Max angular |
| --- | --- | ---: | ---: | ---: | ---: |
| `low` | `preview` | `0.75` | `2.50` | `0.50` | `0.90` |
| `medium` | `balanced` | `0.50` | `2.25` | `0.32` | `0.75` |
| `high` | `high` | `0.40` | `1.80` | `0.16` | `0.50` |

Interpretation:

- large visible shapes can get smaller linear deflection and tighter angular deflection
- medium shapes stay near current behavior
- tiny parts get coarser linear deflection and looser angular deflection
- all values remain clamped so quality does not become extreme

Example multiplier curve:

```text
if sizeRatio >= 0.20: linearMultiplier = minLinearMultiplier
if sizeRatio <= 0.01: linearMultiplier = maxLinearMultiplier
otherwise interpolate smoothly between max and min
```

Angular deflection should tighten for large curved shapes and relax for tiny shapes:

```text
angular = lerp(maxAngular, minAngular, smoothstep(0.01, 0.20, sizeRatio))
```

### Linear deflection clamp

Use:

```text
candidateLinear = baseLinear * linearMultiplier
linear = clamp(candidateLinear, presetMinLinear, presetMaxLinear)
```

Initial native clamps:

| Quality | Min linear | Max linear |
| --- | ---: | ---: |
| `low` | `0.50` | `2.00` |
| `medium` | `0.18` | `1.20` |
| `high` | `0.06` | `0.50` |

These are intentionally conservative. Final values should be tuned from benchmark reports, not guessed into defaults.

### Min-size handling

For shapes below a very small threshold, such as `shapeDiag < assemblyDiag * 0.002` or `shapeDiag < 1 mm`, avoid spending triangles aggressively:

- force `linear` toward the preset max clamp
- cap angular tightness
- flag the part as `small_part_coarsened` in `mesh-report.json`
- never delete the part in tessellation phase

Deletion or visibility pruning should be a separate feature and should not be part of MeshIQ phase 2.

### Boundary versus interior deflection

The current native converter does not use `IMeshTools_Parameters`. A later implementation should evaluate switching from the constructor overload to explicit parameters if this OpenCascade version exposes the needed fields.

Potential parameter goals:

- keep boundary deflection conservative to preserve silhouettes and mating edges
- allow looser interior/surface deflection for tiny internal details if supported safely
- use control surface deflection only after benchmark proof, because it can increase work substantially
- keep `InParallel` equivalent to current `--parallel-mesh`

The first adaptive implementation can keep the current constructor and vary only `linearDeflection`, `relative`, `angularDeflection`, and `parallel`. `IMeshTools_Parameters` should be a follow-up when instrumentation shows exactly what the constructor cannot express.

### Relative mode

Native XCAF currently uses `relative=true` for all normal presets. Keep relative mode enabled initially. The adaptive layer should tune relative deflection values, not switch to absolute mode, because the current behavior and reports already assume relative deflection.

Absolute mode can be evaluated later for pathological models, but it should not be the default MeshIQ path.

### Mesh reuse interaction

The reuse key already includes linear deflection, angular deflection, relative mode, material signature, and safety. Adaptive deflection must preserve that property:

- compute the adaptive deflection before building the `ReuseKey`
- include all adaptive values in the reuse key
- ensure repeated geometry with the same size context and material signature reuses the same cached tessellation
- if the same prototype appears at drastically different scales, do not assume one mesh is good for both unless transform-scale handling has been proven

### Part names and materials

Adaptive tessellation must not change:

- label path
- instance path
- display name and resolved object names
- material/color resolution order
- primitive grouping rules
- face/subshape color handling

This means adaptive work should happen before triangles are extracted, while metadata and material logic remain downstream and unchanged.

## Selective Simplification Strategy

Current meshopt work is not simplification. MeshIQ simplification should be a new, explicit phase behind a flag after mesh-report instrumentation and adaptive tessellation are proven.

### Where simplification should happen

Preferred insertion point:

1. Native XCAF converter writes raw per-part/primitive GLB plus `mesh-report.json`.
2. Worker reads `mesh-report.json`.
3. Worker runs a per-primitive simplification pass before final meshopt compression.
4. Worker validates the simplified GLB against structure, material count, node/mesh/primitive naming, and triangle budget expectations.

This keeps native tessellation focused on faithful CAD extraction and lets simplification use JavaScript tooling where glTF primitives are already easy to inspect. If a C++ simplifier is later chosen, it should still operate per `MeshPrimitive`, not globally.

### Rules

Simplify conservatively at first:

- only simplify parts that are small and dense
- never merge primitives from different label paths, instance paths, names, materials, or colors
- preserve large visible parts
- preserve all node names, mesh names, material assignments, and object metadata
- simplify per primitive or per part, not as a global whole-model operation
- report before/after triangle and vertex counts
- validate output after simplification and again after meshopt compression

Suggested initial thresholds:

- candidate if `sizeRatio < 0.02` and `triangles > 1000`
- stronger candidate if `sizeRatio < 0.005` and `triangles > 500`
- skip if part is among top large bbox objects
- skip if material or primitive boundaries are ambiguous
- initial reduction target no more than 20 percent for medium quality, 10 percent for high, 35 percent for low

### Tools to investigate

The current glTF-Transform stack includes meshoptimizer, but repo code does not currently call a simplification transform. Options to investigate:

- glTF-Transform `simplify()` if compatible with the installed version and preservation requirements
- direct `meshoptimizer` simplification APIs if exposed in Node
- a C++ simplification library only if JS tooling cannot preserve glTF metadata safely

The first implementation should produce `display.simplified.glb.tmp`, validate it, then publish only if all gates pass.

## `mesh-report.json` Design

Write `mesh-report.json` alongside `xcaf-report.json` and `stats.json`.

Suggested schema:

```json
{
  "schemaVersion": 1,
  "converterBackend": "xcaf-baseline",
  "sourceFileName": "model.step",
  "quality": {
    "semantic": "medium",
    "nativePreset": "balanced",
    "adaptiveEnabled": false,
    "baseLinearDeflection": 0.45,
    "baseAngularDeflection": 0.5,
    "relative": true,
    "parallelMesh": true
  },
  "assemblyBoundingBox": {
    "min": [0, 0, 0],
    "max": [1000, 1000, 1000],
    "diagonal": 1732.05
  },
  "totals": {
    "trianglesBeforeSimplification": 0,
    "trianglesAfterSimplification": 0,
    "verticesBeforeSimplification": 0,
    "verticesAfterSimplification": 0,
    "primitiveCount": 0,
    "partCount": 0,
    "meshingTimeMs": 0,
    "simplificationTimeMs": 0
  },
  "parts": [
    {
      "stableObjectId": "string",
      "labelPath": "0:1:2:3",
      "instancePath": "string",
      "displayName": "string",
      "materialSource": "face",
      "colourSource": "xcaf",
      "boundingBox": {
        "min": [0, 0, 0],
        "max": [1, 1, 1],
        "diagonal": 1.732
      },
      "sizeRatio": 0.001,
      "faceCount": 12,
      "primitiveCount": 1,
      "trianglesBeforeSimplification": 1200,
      "trianglesAfterSimplification": 960,
      "verticesBeforeSimplification": 3600,
      "verticesAfterSimplification": 2880,
      "densityScore": 692.8,
      "meshingTimeMs": 12.3,
      "simplificationRatio": 0.2,
      "deflection": {
        "linear": 0.9,
        "angular": 0.65,
        "relative": true,
        "reason": "small_part_coarsened"
      },
      "warnings": []
    }
  ],
  "rankings": {
    "topTinyDenseParts": [],
    "topLargeSparseParts": [],
    "topSlowMeshParts": []
  },
  "warnings": [],
  "recommendations": []
}
```

Density score should start simple:

```text
densityScore = triangles / max(worldBoundingBoxDiagonal, epsilon)
```

Add alternatives only after benchmark data proves they help.

## Reporting Thresholds

Initial report warnings:

- `tiny_dense_part`: small size ratio with high triangle count
- `large_sparse_part`: large size ratio with low triangle density and high angular deflection
- `slow_mesh_part`: meshing time above percentile or fixed threshold
- `simplification_candidate`: candidate under current rules
- `adaptive_clamped_min`: deflection was clamped to preserve quality
- `adaptive_clamped_max`: deflection was clamped to prevent excess coarsening
- `reuse_disabled_face_style`: face styling prevented reuse

The report should be generated before changing defaults. It will let us tune thresholds from real project models.

## Test Model Strategy

Use existing known project models, but do not copy or commit production files.

Recommended benchmark set:

- U843 PCW skid / U843 Non-Haz Panel: large real assembly with known prior validation and many repeated/details components
- U826 Steric large model: stress test for large assemblies and chunking decisions
- small tube/cylinder model: targeted proof for angular deflection and cylinder smoothness
- large cylinder/tank/panel model if available: targeted proof for large visible curved surfaces
- safe existing production model only by reference on the host, not copied into git
- bundled `occt-import-js` sample `dm1-id-214.stp` for quick JS converter smoke coverage

Benchmark outputs should be local ignored artifacts. Reports to compare:

- `stats.json`
- `xcaf-report.json`
- `mesh-report.json`
- `conversion-profile.json`
- `conversion.log`
- GLB validation summary
- file size before/after optimization

For each model and quality:

- baseline native conversion
- adaptive instrumentation-only report
- adaptive enabled behind flag
- simplification enabled behind separate flag
- visual inspection for large cylinders and small dense details

## Implementation Phases

### Phase 1: Mesh-report instrumentation only

- Add `mesh-report.json` to native XCAF converter.
- Record current global deflection values per part.
- Add per-part vertex count, bbox, triangle count, density score, structured meshing time, and rankings.
- Thread/copy the report through the worker.
- Add tests for schema shape and existence.
- Do not change tessellation behavior.

#### Phase 1 implementation

The native XCAF converter now writes `mesh-report.json` beside `display.glb`, `xcaf-report.json`, `conversion-profile.json`, and `conversion.log`. The report is schema-versioned with `schemaVersion: 1` and `converterBackend: "xcaf-baseline"`.

The Phase 1 quality block records the current baseline preset only:

- semantic quality inferred from the native preset
- native preset name
- `adaptiveEnabled: false`
- `simplificationEnabled: false`
- base linear and angular deflection
- relative deflection mode
- parallel mesh mode

Per-part entries are generated from the same `MeshPrimitive` objects already used to write `display.glb`; no extra expensive geometry scan is introduced. Each part includes stable object id, label path, instance path, display name, material source, colour source, world bounding box, size ratio against the assembly diagonal, face count, primitive count, triangles and vertices before/after simplification, density score, optional meshing time, simplification ratio `0`, baseline deflection details, and warnings.

The report produces three diagnostic rankings capped at 20 entries each:

- `topTinyDenseParts`: candidates with small size ratio and high triangle/density score
- `topLargeSparseParts`: candidates with large size ratio and low density relative to their bounds
- `topSlowMeshParts`: highest structured meshing times where timing can be attributed

Structured meshing time is recorded for fresh render-shape meshing. For reused prototype/cache instances, per-part `meshingTimeMs` is `null` because the cache build time cannot be attributed reliably to every reused instance.

The worker treats `mesh-report.json` as an optional native artifact. It is returned from the processor, listed in `manifest.json` under `artifacts.meshReport` when present, uploaded by the worker client, received by the server worker completion route, and exposed through:

- `/model-files/:slug/mesh-report.json`
- `/admin/models/:slug/mesh-report.json`

Older native outputs and the `occt-js` path still succeed when `mesh-report.json` is absent.

For chunked conversion, chunk-level `mesh-report.json` files are preserved under `chunk-mesh-reports/` before chunk cleanup. When chunk reports exist, the worker also writes an aggregate top-level `mesh-report.json` by summing totals, concatenating parts, recomputing assembly bounds, and rebuilding the three rankings. The aggregate is diagnostic only; it does not alter merged GLB generation.

Deferred work remains unchanged: adaptive tessellation, direct `IMeshTools_Parameters` use, simplification, admin visual summaries, benchmark tuning, and production rollout are Phase 2+ tasks.

#### Phase 1B native validation

Phase 1B was validated on the EliteDesk in an isolated worktree:

- worktree: `/home/claudio/projects/3d-model-web-viewer-worktrees/meshiq-phase1-runtime`
- commit: `4a7f41c6423553b33bd357575e192087050e203d`
- native image: `meshiq-phase1-xcaf:validation`, built from `spikes/occt-xcaf-glb` in the isolated worktree
- output root: `.tmp/meshiq-runtime-validation/`

Production stayed on `main` at `d294769a5b2dfe28a8d9daf3acbb3ea58ddc7716`; no production deploy, migration, database write, uploaded STEP mutation, generated GLB mutation, public-link change, QR-link change, or service restart was performed.

Validated models were read by reference from existing EliteDesk storage and written only to isolated temporary output folders:

| Model | Input size | Qualities | Output artifacts |
| --- | ---: | --- | --- |
| `test1` tube sample | 63,673 bytes | `balanced`, `high` | `display.glb`, `xcaf-report.json`, `mesh-report.json`, `conversion-profile.json`, `conversion.log` |
| `screw` small fastener | 83,057 bytes | `balanced`, `high` | `display.glb`, `xcaf-report.json`, `mesh-report.json`, `conversion-profile.json`, `conversion.log` |
| `u843_cda_panel` small assembly | 3,598,666 bytes | `balanced`, `high` | `display.glb`, `xcaf-report.json`, `mesh-report.json`, `conversion-profile.json`, `conversion.log` |

Baseline totals:

| Model | Quality | Triangles | Vertices | Parts | Primitives | Assembly bbox diagonal | Mesh time |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `test1` | `balanced` | 628 | 1,884 | 2 | 2 | 858.859 | 16.675 ms |
| `test1` | `high` | 1,700 | 5,100 | 2 | 2 | 859.042 | 26.883 ms |
| `screw` | `balanced` | 794 | 2,382 | 1 | 1 | 57.746 | 15.171 ms |
| `screw` | `high` | 2,582 | 7,746 | 1 | 1 | 57.756 | 23.082 ms |
| `u843_cda_panel` | `balanced` | 36,630 | 109,890 | 35 | 35 | 341.638 | 1,027.185 ms |
| `u843_cda_panel` | `high` | 96,534 | 289,602 | 35 | 35 | 341.638 | 1,235.097 ms |

`mesh-report.json` parsed successfully for every run. `display.glb` was present and non-empty for every run. `mesh-report.json` matched `xcaf-report.json` for triangles, vertices, primitive count, and global/assembly bounding box in every run. The only practical count difference is expected: `xcaf-report.json` also records `shapesTessellated`, while `mesh-report.json` reports emitted part/primitive rows after material/subshape splitting.

The report rankings are useful on the 35-part U843 CDA panel. At `balanced`, the highest tiny-dense candidates were the Festo regulator subshapes and 3D printed brackets. At `high`, the 3D printed brackets rose to the top tiny-dense positions at 4,096 triangles each with size ratio around `0.132`, while Festo regulator subshapes remained heavy. The largest sparse candidates were the large unnamed panel/body, the two-regulator SS bracket, and larger bracket bodies; these are plausible candidates for tighter large-shape angular control rather than simplification. The slowest mesh candidates were the Festo regulator subshapes, especially the two regulator instances, with structured per-shape timings around `125-182 ms`.

The simple one-part and two-part samples are useful for smoke validation but noisy for ranking logic because every part necessarily appears in every ranking. The `test1` tube sample shows names and paths are identifiable enough (`COPPER TUBE - 1/2"` and `COPPER TUBE - 3"`). The screw sample proves the report works on a one-part model but is not useful for threshold tuning by itself.

Limitations observed:

- Reused or split primitives can share the same meshing time attribution, so slow rankings should be treated as shape-level diagnostics, not exact per-material primitive timings.
- `topLargeSparseParts` needs a minimum size-ratio gate in Phase 2 tuning; otherwise small smoke models naturally classify their only part as both tiny-dense and large-sparse.
- No simplification was enabled, so before/after triangle and vertex counts intentionally match and simplification ratio remains `0`.
- No adaptive meshing was enabled, so all deflection reasons remain `baseline_global_preset`.

Phase 2 threshold guidance from the validation set:

- For `medium`/`balanced`, start adaptive tightening for large sparse parts at `sizeRatio >= 0.40`, with a watch band from `0.25` to `0.40`. The U843 large unnamed body (`sizeRatio 0.934`, 556 triangles) and SS bracket (`sizeRatio 0.444`, 772 triangles) are good proof cases.
- Treat tiny-dense candidates as simplification or coarsening candidates only when `sizeRatio <= 0.16` and `triangles >= 1,200` for medium. This catches Festo regulator subshapes and printed brackets while avoiding trivial tube/screw smoke noise.
- For `high`, raise the tiny-dense triangle threshold to about `3,000` and keep the size-ratio cutoff near `0.16`. This catches 4,096-triangle printed brackets and 3,712-triangle regulator subshapes without overreacting to ordinary small hardware.
- Treat slow-mesh warnings as useful above about `100 ms` per structured meshing event on this hardware. The Festo regulator entries are clear outliers; most other parts were below `50 ms`.
- Keep adaptive and simplification flags off until the same report comparison is repeated on a larger U843 PCW skid or U843 Non-Haz Panel and at least one large curved cylinder/tube model.

#### Phase 1C larger-model and curved-surface validation

Phase 1C was validated on the EliteDesk in the same isolated worktree, without changing production conversion behavior:

- worktree: `/home/claudio/projects/3d-model-web-viewer-worktrees/meshiq-phase1-runtime`
- commit: `a6ee3528051c5ee4dd9efdf10092d88d1c3506b1`
- native image: `meshiq-phase1c-xcaf:validation`, built from the isolated worktree and labelled with the same commit revision
- output root: `.tmp/meshiq-runtime-validation-phase1c/`

Production remained on `main` at `d294769a5b2dfe28a8d9daf3acbb3ea58ddc7716`. No production deploy, migration, database write, uploaded STEP mutation, generated GLB mutation, public-link change, QR-link change, service restart, Pi change, Cloudflare change, or unrelated EliteDesk service change was performed.

Validated inputs:

| Model | Source | Input size | Qualities | Output artifacts |
| --- | --- | ---: | --- | --- |
| `u843-non-haz-panel` | Existing EliteDesk production upload, read-only bind mount; full path redacted | 53,241,156 bytes | `balanced`, `high` | `display.glb`, `xcaf-report.json`, `mesh-report.json`, `conversion-profile.json`, `conversion.log` |
| `large-curved-tank` | Synthetic non-sensitive STEP generated under the isolated `.tmp` output tree with OpenCascade primitives: one large horizontal tank, long pipes, vertical nozzles, and support blocks | 62,986 bytes | `balanced`, `high` | `display.glb`, `xcaf-report.json`, `mesh-report.json`, `conversion-profile.json`, `conversion.log` |

Baseline totals:

| Model | Quality | Triangles | Vertices | Parts | Primitives | Assembly bbox diagonal | GLB size | Conversion time | Mesh time |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `u843-non-haz-panel` | `balanced` | 378,952 | 1,136,856 | 202 | 202 | 1,108.913 | 32,423,364 bytes | 69.214 s | 8,532.354 ms |
| `u843-non-haz-panel` | `high` | 1,011,048 | 3,033,144 | 202 | 202 | 1,108.913 | 85,519,972 bytes | 71.192 s | 11,064.101 ms |
| `large-curved-tank` | `balanced` | 524 | 1,572 | 7 | 7 | 6,847.025 | 65,868 bytes | 0.071 s | 15.052 ms |
| `large-curved-tank` | `high` | 1,164 | 3,492 | 7 | 7 | 6,847.792 | 119,632 bytes | 0.075 s | 20.167 ms |

`display.glb` was present and non-empty for every run, and every `mesh-report.json` parsed successfully. `mesh-report.json` agreed with `xcaf-report.json` for triangle count, vertex count, primitive count, and GLB byte count in all four runs.

Tiny-dense findings:

- On `u843-non-haz-panel`, the rankings are useful and stable. The top tiny-dense entries are gas sticks and diaphragm valves rather than random small hardware. In `balanced`, the largest outlier was `GTC UHP MINI GAS STICK, MGS-02-30 + 1/4" MALE VCR X 1/4" FEMALE VCR` at `sizeRatio 0.176`, `47,970` triangles, and density `245.911`. In `high`, the same part rose to `126,928` triangles and density `650.677`.
- Other repeated U843 valve candidates include `GTC K30 DIAPHRAGM VALVE` variants around `sizeRatio 0.113-0.145`, with `18,068-25,140` triangles in `balanced` and `45,792-64,472` triangles in `high`.
- On `large-curved-tank`, tiny-dense rankings are mostly noise because the model has only seven large primitive solids and no real small detail. This confirms Phase 2 needs minimum part-count and triangle gates before displaying or acting on tiny-dense lists.

Large-sparse findings:

- On `u843-non-haz-panel`, large sparse rankings clearly found the most faceting-prone geometry: long `316L SS TUBE` runs and a large unnamed body. In `balanced`, one tube subshape had `sizeRatio 0.504`, only `100` triangles, and density `0.179`; another had `sizeRatio 0.375`, `100` triangles, and density `0.241`. The large unnamed object had `sizeRatio 0.970`, `556` triangles, and density `0.517`.
- In `high`, those same U843 tube/body candidates remained sparse relative to their size: the `sizeRatio 0.504` tube rose only to `228` triangles, and the large unnamed object rose to `1,196` triangles. This suggests the current global `high` preset still does not spend many triangles on some large curved or elongated parts.
- On `large-curved-tank`, the top large-sparse entries are exactly the large tank and long pipes. In `balanced`, the main tank-like primitive had `sizeRatio 0.845`, `100` triangles, and density `0.017`; in `high`, it had `228` triangles and density `0.039`. This is a strong curved-surface faceting signal.

Slow-mesh findings:

- On `u843-non-haz-panel`, slow mesh rankings are useful. The top slow entries are the same complex gas sticks and valve bodies highlighted by tiny-dense rankings. `balanced` outliers were about `1,342 ms`, `1,209 ms`, `1,186 ms`, `498 ms`, and `494 ms`; `high` outliers were about `1,655 ms`, `1,494 ms`, `1,244 ms`, `676 ms`, and `626 ms`.
- On `large-curved-tank`, slow rankings are not meaningful because the model is tiny from a topology perspective. The slowest structured mesh event was only `4.544 ms`.

Part identity and report usefulness:

- U843 part names and paths are sufficient for diagnosis. The report exposes recognizable display names such as `GTC UHP MINI GAS STICK`, `GTC K30 DIAPHRAGM VALVE`, and `316L SS TUBE`, plus label paths and instance paths.
- Synthetic tank part names are not sufficient because OpenCascade wrote generic names such as `Open CASCADE STEP translator 7.6 1.1`. The label paths still identify rows, but a future synthetic benchmark should use XCAF naming if we need human-readable synthetic part labels.
- The U843 rankings are useful; the synthetic tank rankings are useful only for large-sparse curved-surface detection, not for tiny-dense or slow-mesh tuning.

Curved-surface findings:

- The synthetic large tank confirms that baseline global presets can leave large cylinders very sparse: `balanced` produced only `100` triangles for each major cylinder and `high` produced only `228`.
- The U843 Non-Haz report independently shows large `316L SS TUBE` entries with low triangle density even at `high`.
- These results support tightening angular deflection for large sparse curved parts first, before implementing any simplification.

Refined Phase 2 threshold guidance:

- Medium/balanced large-shape tightening should start at `sizeRatio >= 0.35`, with a watch band from `0.20` to `0.35`. The previous `0.40` start was slightly too conservative because the U843 `316L SS TUBE` at `sizeRatio 0.375` is already a clear large-sparse candidate. Proposed `balanced` angular range: `0.28-0.50`, tightening toward `0.28` for large sparse curved parts. Proposed linear multiplier range: `0.50-1.80`, keeping the existing baseline around the middle and avoiding broad coarsening in Phase 2.
- High-quality large-shape tightening should start at `sizeRatio >= 0.30`. Proposed angular range: `0.14-0.22`, tightening toward `0.14` for large sparse curved parts. Proposed linear multiplier range: `0.50-1.20`, because `high` should mostly preserve or improve quality rather than coarsen.
- Medium tiny-dense coarsening candidates should require `sizeRatio <= 0.18` and `triangles >= 8,000`. The earlier `1,200` threshold is too low for this larger model and would over-flag ordinary detail.
- High tiny-dense coarsening candidates should require `sizeRatio <= 0.18` and `triangles >= 25,000`. This catches the U843 valve/gas-stick outliers without reacting to modest parts.
- Slow mesh warnings should use `>= 250 ms` as the fixed initial warning and `>= 1,000 ms` as a severe warning on this hardware. The previous `100 ms` threshold is useful for investigation but too chatty for a larger assembly.
- Minimum gates to stop smoke-model noise: require at least `10` parts or `10,000` total triangles before showing tiny-dense rankings as actionable; require candidate `triangles >= 500` for tiny-dense rows; require candidate `sizeRatio >= 0.25` and `triangles <= 2,000` for large-sparse rows; require `meshingTimeMs >= 100` for slow rows.
- Phase 2 should initially target large sparse smoothing only. Tiny-dense coarsening should remain report-only until visual review proves it will not damage small functional CAD details.
- Phase 2 should use constructor-level adaptive `linearDeflection` and `angularDeflection` first, leaving `IMeshTools_Parameters` deferred. The Phase 1C evidence points to angular/linear preset tuning being enough for the next safe experiment.

Phase 2 is now ready to implement behind a default-off flag for large sparse smoothing only. Remaining risks are visual: tighter angular deflection may increase triangles on long tubes and tanks, repeated large curved parts may reduce mesh reuse if adaptive values diverge, and tiny-dense coarsening still needs visual proof before it becomes active.

### Phase 2: Adaptive OCCT tessellation behind a flag

- Add CLI flag such as `--adaptive-mesh on|off`.
- Add worker env/config flag.
- Compute assembly bbox and per-shape bbox before meshing.
- Compute adaptive linear/angular values with conservative clamps.
- Preserve relative mode and parallel mode.
- Include adaptive values in reuse keys.
- Write deflection reasons and clamp decisions into `mesh-report.json`.
- Keep default off until benchmarks are reviewed.

#### Phase 2A implementation notes

Phase 2A implements large-sparse adaptive smoothing only, behind disabled-by-default flags:

- native CLI flag: `--adaptive-mesh on|off`
- native default: `off`
- worker environment flag: `MESHIQ_ADAPTIVE_MESH=off|on`
- worker default: `off`
- adaptive mode name in reports: `large_sparse_smoothing`

When adaptive meshing is off, the native presets remain unchanged:

| Native preset | Linear deflection | Angular deflection | Relative mode |
| --- | ---: | ---: | --- |
| `preview` / `low` | `0.85` | `0.65` | `true` |
| `balanced` | `0.45` | `0.50` | `true` |
| `high` | `0.12` | `0.22` | `true` |

When adaptive meshing is on, the converter computes the full assembly bounding-box diagonal once before XCAF traversal, then computes each render shape's world bounding-box diagonal before meshing. The size ratio is:

```text
sizeRatio = clamp(shapeWorldBboxDiagonal / assemblyBboxDiagonal, 0.0, 1.0)
```

If bounds are missing, zero, NaN, or infinite, the converter keeps baseline values and reports `adaptive_invalid_bounds_fallback`. The implementation still uses the existing `BRepMesh_IncrementalMesh(shape, linearDeflection, relative, angularDeflection, parallel)` constructor. It does not use `IMeshTools_Parameters`, does not switch to absolute deflection, and keeps current parallel mesh behavior.

Phase 2A thresholds:

| Native preset | Large-shape gate | Watch band | Linear multiplier | Angular target |
| --- | ---: | ---: | ---: | ---: |
| `preview` / `low` | `sizeRatio >= 0.45` | `0.30-0.45` | `0.85` | `0.55` |
| `balanced` | `sizeRatio >= 0.35` | `0.20-0.35` | `0.50` | `0.28` |
| `high` | `sizeRatio >= 0.30` | `0.20-0.30` | `0.50` | `0.14` |

Clamp ranges:

| Native preset | Linear clamp |
| --- | --- |
| `preview` / `low` | `base * 0.75` to `base * 1.10` |
| `balanced` | `base * 0.50` to `base * 1.80` |
| `high` | `base * 0.50` to `base * 1.20` |

Tiny-dense handling remains report-only. The Phase 2A warning gates are:

- `balanced` / medium: `sizeRatio <= 0.18` and triangles `>= 8000`
- `high`: `sizeRatio <= 0.18` and triangles `>= 25000`

No tiny-dense coarsening, part deletion, or simplification is implemented in Phase 2A.

Mesh reuse remains keyed by the actual linear deflection, angular deflection, relative mode, material signature, and safety state. Because adaptive deflection is computed before building `ReuseKey`, adaptive-on and adaptive-off cached geometry cannot be mixed. Repeated geometry with the same adaptive context can still reuse safely. If a future transform-scale case makes reuse ambiguous, the safe path is to disable reuse for that case rather than sharing a mismatched tessellation.

`mesh-report.json` additions:

- `quality.adaptiveEnabled`
- `quality.adaptiveMode`
- per-part `deflection.linear`
- per-part `deflection.angular`
- per-part `deflection.relative`
- per-part `deflection.reason`
- per-part warnings: `large_sparse_smoothed`, `adaptive_clamped_min`, `adaptive_clamped_max`, `tiny_dense_report_only`

`xcaf-report.json` also records `quality.adaptiveEnabled` and `quality.adaptiveMode`.

Runtime validation for Phase 2A should use only the isolated EliteDesk worktree:

- worktree: `/home/claudio/projects/3d-model-web-viewer-worktrees/meshiq-phase1-runtime`
- image: `meshiq-phase2a-xcaf:validation`
- output root: `.tmp/meshiq-runtime-validation-phase2a/`

Required validation models:

- `u843-non-haz-panel`
- `large-curved-tank`
- optionally `u843_cda_panel` if quick

For each model, compare `balanced` off/on and `high` off/on for triangles, vertices, GLB bytes, conversion time, mesh time, large-sparse smoothing counts, and report-only tiny-dense warnings. Phase 2A artifacts must not be uploaded to production or committed.

Phase 2A isolated validation was run on the EliteDesk worktree above with image `meshiq-phase2a-xcaf:validation`. Inputs were mounted read-only and outputs were written under `.tmp/meshiq-runtime-validation-phase2a/`. The production worktree, production database, uploaded STEP files, generated production GLBs, public links, QR links, and services were not modified.

Validation totals:

| Model | Quality | Adaptive | Triangles | Vertices | GLB bytes | Conversion time | Mesh time | Smoothed parts | Tiny dense warnings |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `large-curved-tank` | `balanced` | off | 524 | 1,572 | 66,812 | 0.089 s | 0.000 ms | 0 | 0 |
| `large-curved-tank` | `balanced` | on | 752 | 2,256 | 85,968 | 0.088 s | 0.000 ms | 3 | 0 |
| `large-curved-tank` | `high` | off | 1,164 | 3,492 | 120,576 | 0.083 s | 0.000 ms | 0 | 0 |
| `large-curved-tank` | `high` | on | 1,548 | 4,644 | 152,860 | 0.090 s | 0.000 ms | 3 | 0 |
| `u843-non-haz-panel` | `balanced` | off | 378,952 | 1,136,856 | 28,923,772 | 69.846 s | 7,454.048 ms | 0 | 0 |
| `u843-non-haz-panel` | `balanced` | on | 381,564 | 1,144,692 | 29,143,184 | 70.935 s | 7,603.872 ms | 26 | 5 |
| `u843-non-haz-panel` | `high` | off | 1,011,054 | 3,033,162 | 77,932,768 | 71.969 s | 9,478.878 ms | 0 | 0 |
| `u843-non-haz-panel` | `high` | on | 1,016,882 | 3,050,646 | 78,422,440 | 72.127 s | 10,111.852 ms | 26 | 5 |

Large curved tank results:

- `balanced` adaptive-on increased the three major cylinders from 100 triangles each to 176 triangles each.
- `high` adaptive-on increased the main large cylinder from 228 triangles to 356 triangles.
- Visual inspection of the balanced off/on GLBs showed finer cylinder faceting with adaptive-on; the model still remains visibly faceted enough that Phase 2B tuning may consider a tighter angular target if file-size and time budgets allow.

U843 Non-Haz results:

- `balanced` adaptive-on smoothed 26 large sparse parts. Representative `316L SS TUBE` rows increased from 100 triangles to 180 triangles, and the large unnamed body increased from 556 to 956 triangles.
- `high` adaptive-on smoothed the same 26 large sparse parts. A representative `316L SS TUBE` increased from 228 triangles to 356 triangles, and the large unnamed body increased from 1,196 to 1,836 triangles.
- Tiny-dense candidates stayed report-only. The top gas-stick and diaphragm-valve parts retained their triangle counts between adaptive off and on; the five warnings were diagnostic only.

Remaining Phase 2A risks:

- Large-sparse smoothing is currently size-ratio based because triangle count is unavailable before meshing; some large flat or blocky parts may be tightened even if visual benefit is small.
- The synthetic tank improved but is still not perfectly smooth, so default-on rollout should wait for a reviewed visual threshold.
- Adaptive-on modestly increases U843 GLB size and mesh time; the increase was small in this validation but should be rechecked on larger production-like assemblies before changing defaults.

Recommended Phase 2B path:

- Keep `MESHIQ_ADAPTIVE_MESH=off` in production.
- Review the adaptive-on tank and U843 screenshots/GLBs from the isolated output folder.
- Tune the balanced angular target if the tank still looks too faceted.
- Add a report UI summary before exposing any admin control.
- Keep tiny-dense coarsening and simplification separate behind their own later flags.

#### Phase 2B adaptive profile tuning

Phase 2B adds tunable adaptive smoothing profiles while preserving all production and adaptive-off defaults:

- native CLI flag: `--adaptive-mesh-profile conservative|standard|strong`
- native default profile: `standard`
- worker environment variable: `MESHIQ_ADAPTIVE_MESH_PROFILE=conservative|standard|strong`
- worker default profile: `standard`
- profile is only passed by the worker when `MESHIQ_ADAPTIVE_MESH=on`
- adaptive mode remains default-off in native CLI and worker config
- no tiny-dense coarsening and no simplification are implemented

The `standard` profile preserves Phase 2A adaptive-on behavior. The `conservative` profile backs off the large-sparse gate and smoothing strength. The `strong` profile tightens linear and angular values for large sparse curved geometry such as tanks and tubes.

Profile thresholds:

| Native preset | Profile | Large-shape gate | Watch band | Linear multiplier | Angular target |
| --- | --- | ---: | ---: | ---: | ---: |
| `preview` / `low` | `conservative` | `0.50` | `0.25-0.50` | `0.90` | `0.60` |
| `preview` / `low` | `standard` | `0.45` | `0.30-0.45` | `0.85` | `0.55` |
| `preview` / `low` | `strong` | `0.35` | `0.20-0.35` | `0.65` | `0.45` |
| `balanced` | `conservative` | `0.45` | `0.25-0.45` | `0.65` | `0.34` |
| `balanced` | `standard` | `0.35` | `0.20-0.35` | `0.50` | `0.28` |
| `balanced` | `strong` | `0.25` | `0.12-0.25` | `0.35` | `0.18` |
| `high` | `conservative` | `0.40` | `0.25-0.40` | `0.65` | `0.17` |
| `high` | `standard` | `0.30` | `0.20-0.30` | `0.50` | `0.14` |
| `high` | `strong` | `0.30` | `0.20-0.30` | `0.35` | `0.09` |

The implementation continues to use the existing `BRepMesh_IncrementalMesh(shape, linearDeflection, relative, angularDeflection, parallel)` constructor. It keeps `relative=true`, does not use `IMeshTools_Parameters`, does not use pre-mesh triangle counts for tessellation decisions, and does not coarsen tiny dense parts. The `high` + `strong` gate intentionally matches `standard` after validation showed the looser `0.22` gate pulled dense regulator and gas-stick assemblies into smoothing and exceeded the U843 hard stop.

`mesh-report.json` and `xcaf-report.json` record `adaptiveProfile`. Per-part deflection entries record the actual linear value, actual angular value, relative mode, reason, profile, and warning codes. Profile-specific warning codes are:

- `adaptive_profile_strong`
- `adaptive_profile_conservative`
- `large_sparse_smoothed`
- `tiny_dense_report_only`
- existing clamp/fallback warnings

Mesh reuse keys include actual linear deflection, angular deflection, relative mode, material signature, safety state, and adaptive profile, so adaptive-off, standard, conservative, and strong outputs cannot mix unsafe cached tessellations.

Phase 2B isolated validation should use only the EliteDesk worktree:

- worktree: `/home/claudio/projects/3d-model-web-viewer-worktrees/meshiq-phase1-runtime`
- image: `meshiq-phase2b-xcaf:validation`
- output root: `.tmp/meshiq-runtime-validation-phase2b/`
- models: `large-curved-tank` and `u843-non-haz-panel`

Required comparison matrix:

| Model | Quality | Adaptive off | Adaptive standard | Adaptive strong |
| --- | --- | --- | --- | --- |
| `large-curved-tank` | `balanced` | required | required | required |
| `large-curved-tank` | `high` | required | required | required |
| `u843-non-haz-panel` | `balanced` | required | required | required |
| `u843-non-haz-panel` | `high` | required | required | required |

Validation should capture triangles, vertices, GLB bytes, conversion time, mesh time, smoothed part count, top large-sparse candidates, top tiny-dense warnings, and per-part deflection profile/reason values. Strong is acceptable only if the U843 triangle increase stays below the 10 percent hard stop and ideally below the 5 percent target for both balanced and high. The expected rollout posture after Phase 2B is that `standard` remains the safer candidate for future rollout unless visual validation proves `strong` is materially better without exceeding the U843 budget.

#### Phase 2B validation results

Phase 2B was validated on the EliteDesk in the same isolated worktree using direct binary invocation (not the full application pipeline):

- worktree: `/home/claudio/projects/3d-model-web-viewer-worktrees/meshiq-phase1-runtime`
- image: `meshiq-phase2b-xcaf:validation`
- output root: `.tmp/meshiq-runtime-validation-phase2b/`
- models: `large-curved-tank` and `u843-non-haz-panel`

Production remained unchanged. No production deploy, migration, database write, uploaded STEP mutation, generated GLB mutation, public-link change, QR-link change, service restart, Pi change, Cloudflare change, or unrelated EliteDesk service change was performed.

Validation totals:

| Model | Quality | Adaptive | Profile | Triangles | GLB bytes | Smoothed parts |
| --- | --- | --- | --- | ---: | ---: | ---: |
| `large-curved-tank` | `balanced` | off | standard | 524 | 66,812 | 0 |
| `large-curved-tank` | `balanced` | on | standard | 752 | 85,968 | 3 |
| `large-curved-tank` | `balanced` | on | strong | 1,052 | 111,168 | 3 |
| `large-curved-tank` | `high` | off | standard | 1,164 | 120,576 | 0 |
| `large-curved-tank` | `high` | on | standard | 1,548 | 152,860 | 3 |
| `large-curved-tank` | `high` | on | strong | 2,148 | 203,264 | 3 |
| `u843-non-haz-panel` | `balanced` | off | standard | 378,952 | 28,923,768 | 0 |
| `u843-non-haz-panel` | `balanced` | on | standard | 381,564 | 29,143,180 | 26 |
| `u843-non-haz-panel` | `balanced` | on | strong | 386,340 | 29,544,368 | 26 |
| `u843-non-haz-panel` | `high` | off | standard | 1,011,054 | 77,932,772 | 0 |
| `u843-non-haz-panel` | `high` | on | standard | 1,016,882 | 78,422,444 | 26 |
| `u843-non-haz-panel` | `high` | on | strong | 1,027,628 | 79,325,112 | 26 |

U843 budget assessment:

- `balanced` off to strong: (386,340 - 378,952) / 378,952 = +1.95%. Within the 5 percent target and 10 percent hard stop.
- `high` off to strong: (1,027,628 - 1,011,054) / 1,011,054 = +1.64%. Within budget.

Both `standard` and `strong` pass the U843 hard stop. The `strong` profile produces meaningfully more triangles on large curved-tank geometry (balanced +100.8 percent, high +84.5 percent) while leaving U843 well within budget. This confirms `strong` provides more value on large sparse curved geometry without over-inflating complex assemblies.

Remaining Phase 2B limitations observed:

- Large-curved-tank results are still not perfectly smooth at `balanced`; cylinder faceting improved but remains visible.
- Phase 2B used direct binary invocation, not the real upload/worker application pipeline. The full pipeline path (HTTP upload, job queue, worker env, XCAF flags, artifact upload, manifest, admin routes) was not tested until Phase 2C.

#### Phase 2C isolated real pipeline validation

Phase 2C validated the full application pipeline end-to-end in an isolated Docker Compose environment with `MESHIQ_ADAPTIVE_MESH=on` and `MESHIQ_ADAPTIVE_MESH_PROFILE=strong`.

Isolation details:

- worktree: `/home/claudio/projects/3d-model-web-viewer-worktrees/meshiq-phase1-runtime`
- branch: `feature/meshiq-adaptive-tessellation` at HEAD `7d3e4a34f8ca2c58b88015b4ec301e50d2a682a6`
- Docker Compose project name: `meshiq-phase2c`
- compose file: `deploy/docker-compose.phase2c.yml` (standalone, not an override)
- port: `127.0.0.1:3019:3019` (production uses 3009)
- data volume: `../data-phase2c:/app/data`
- key environment variables:
  - `MESHIQ_ADAPTIVE_MESH=on`
  - `MESHIQ_ADAPTIVE_MESH_PROFILE=strong`
  - `CONVERTER_BACKEND=xcaf-baseline`
  - `GLB_OPTIMIZATION_MODE=meshopt`
  - `CONVERTER_QUALITY=high`

Production remained unchanged: production main worktree at `/home/claudio/projects/3d-model-web-viewer` on `main` at `d294769a5b2dfe28a8d9daf3acbb3ea58ddc7716`. No production deploy, migration, database write, uploaded STEP mutation, generated GLB mutation, public-link change, QR-link change, service restart, Pi change, Cloudflare change, or unrelated EliteDesk service change was performed.

Pipeline path validated:

1. `POST /api/models` ? HTTP upload accepted, job created, slug assigned
2. Worker polling ? worker picked up the job, constructed XCAF CLI with `--adaptive-mesh on --adaptive-mesh-profile strong`
3. Native XCAF conversion ? binary ran with `strong` profile, wrote `display.glb`, `mesh-report.json`, `xcaf-report.json`, `stats.json`, `material-debug.json`
4. Artifact upload ? worker uploaded all artifacts to the server
5. `GET /model-files/:slug/mesh-report.json` ? artifact served from storage
6. `GET /admin/models/:slug/mesh-report.json` ? admin route served the report (requires `Authorization: Basic` against `ADMIN_PASSWORD`)
7. `GET /3dviewer/:slug` ? viewer route responded and GLB loaded
8. Manifest adaptive metadata ? both models showed `adaptiveMesh: {enabled: true, mode: "large_sparse_smoothing", profile: "strong"}`

Phase 2C validation totals:

| Model | Input bytes | Quality | Adaptive | Profile | Triangles | Vertices | Parts | Primitives | Smoothed | Raw GLB bytes | Optimized GLB bytes | Meshopt reduction | Conv. time |
| --- | ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `large-curved-tank` | 62,986 | `medium` (balanced) | on | strong | 1,052 | 3,156 | 7 | 7 | 3 | 110,168 | 38,284 | 65.25% | 0.28 s |
| `u843-non-haz-panel` | 53,241,156 | `medium` (balanced) | on | strong | 386,340 | 1,159,020 | 497 | 497 | 26 | 34,229,764 | 8,404,860 | 75.45% | 70.09 s |

Comparison against Phase 2B direct invocation:

- Triangle counts match exactly for both models: 1,052 and 386,340.
- Smoothed part counts match exactly: 3 and 26.
- The real upload/worker pipeline constructs the same XCAF command as Phase 2B direct runs, confirming env-to-CLI flag mapping is correct.

U843 primitive count difference: Phase 2B used a 53,242,141-byte source file, Phase 2C used a 53,241,156-byte source file (985 bytes different, different version). Phase 2B had 202 primitives and Phase 2C had 497. Triangle counts are identical at 386,340, confirming identical geometric quality across the different primitive-split groupings.

Test isolation fix (code change):

Two tests in `apps/worker/src/chunking.test.ts` assumed `MESHIQ_ADAPTIVE_MESH` was unset in the process environment. With `MESHIQ_ADAPTIVE_MESH=on` in the container env, both failed:

- `"config parsing and defaults"`: `assert.equal(config.meshiqAdaptiveMesh, "off")` failed because the env var was inherited.
- `"disabled mode does not run planner/chunks"`: the spawn mock check expected no `--adaptive-mesh` flag in the command.

Fix: added `process.env` save/restore using try/finally around both tests so they explicitly control the env var regardless of what is set in the container. All 40 worker tests pass after the fix.

Checks completed inside the isolated containers (all against the `meshiq-phase2c` project, not production):

| Check | Result |
| --- | --- |
| Worker typecheck | pass (no errors) |
| Worker build | pass (no errors) |
| Worker tests | 40/40 pass |
| Server typecheck | pass (no errors) |
| Server build | pass (no errors) |
| Server tests | 15/17 pass (2 pre-existing failures in `assetLibrary.test.ts` and `revisionControllers.test.ts` ? confirmed same in production container) |
| Converter tests | 0 tests (no test suite for converter binary) |

`strong` profile rollout assessment:

- The `strong` profile is validated through the real upload/worker/XCAF/artifact pipeline.
- U843 triangle budget impact is 1.95 percent above baseline at `balanced` and 1.64 percent at `high`, both well within the 5 percent target.
- Large sparse curved parts (tank, long tubes) show meaningful triangle improvement under `strong` versus `standard` without triggering assembly budget concerns.
- `standard` remains the safer default rollout candidate because it was validated first and has a lighter impact on large assemblies.
- `strong` is the preferred option for models where large sparse curved geometry (tanks, long pipes, panels) is the dominant visual element and file-size headroom exists.
- Recommended Phase 2D path: visual inspection of `strong` versus `standard` GLBs in the 3D viewer for both models, followed by a decision on whether to set `strong` as the default or keep `standard` as the conservative rollout default.

Remaining risks after Phase 2C:

- Visual quality comparison between `standard` and `strong` has not been performed in the viewer; GLB numerical correctness was confirmed but visual rendering was not reviewed.
- Meshopt compression validates structure and reduces size, but visual rendering of the optimized GLB in a real device has not been tested.
- U843 tessellation cache hits were 0 in Phase 2C due to different source version; cache behaviour under the strong profile on repeated runs was not tested.
- Tiny-dense coarsening remains unimplemented and report-only; gas-stick and diaphragm-valve density outliers are still present.



﻿
#### Phase 2D visual inspection and rollout-readiness review

Phase 2D performed visual inspection of the `strong` profile outputs in the isolated viewer and compiled a full numeric comparison across all variants using Phase 2B direct-invocation data and Phase 2C pipeline data.

Isolation details:

- worktree: `/home/claudio/projects/3d-model-web-viewer-worktrees/meshiq-phase1-runtime`
- branch: `feature/meshiq-adaptive-tessellation`
- Docker Compose project name: `meshiq-phase2c` (Phase 2C containers reused)
- port: `127.0.0.1:3019:3019` (production uses `0.0.0.0:3009`)
- data volume: `../data-phase2c:/app/data`
- visual inspection: Windows host via SSH tunnel and transparent auth proxy on port 3020
- models inspected: `large-curved-tank` and `original` (u843 non-hazardous panel)

Production remained unchanged. No production deploy, migration, database write, uploaded STEP mutation, generated GLB mutation, public-link change, QR-link change, service restart, Pi change, Cloudflare change, or unrelated EliteDesk service change was performed.

Commit SHA note: the task context referenced `a283949` as the Phase 2C HEAD (Fix chunking test isolation for MESHIQ env vars; document Phase 2B/2C results). The EliteDesk isolated worktree HEAD is `df25382bb4d9c79ac0bcad4cc16cc1b580659a29` with the identical commit message, indicating a divergent history between the local Windows checkout and the EliteDesk worktree. `a283949` is not found in the EliteDesk git history. Phase 2D documentation is committed to the local branch and pushed to GitHub.

Route checks (isolated server, `strong` profile, balanced/medium quality):

| Route | Model | HTTP status |
| --- | --- | --- |
| `GET /health` | ??? | 200 |
| `GET /3dviewer/:slug` | large-curved-tank | 200 |
| `GET /3dviewer/:slug` | u843 (original) | 200 |
| `GET /model-files/:slug/display.glb` | large-curved-tank | 200 |
| `GET /model-files/:slug/display.glb` | u843 (original) | 200 |
| `GET /model-files/:slug/mesh-report.json` | large-curved-tank | 200 |
| `GET /model-files/:slug/mesh-report.json` | u843 (original) | 200 |
| `GET /model-files/:slug/manifest.json` | large-curved-tank | 200 ??? adaptive metadata present |
| `GET /model-files/:slug/manifest.json` | u843 (original) | 200 ??? adaptive metadata present |

Manifest adaptive metadata confirmed for both models: `adaptiveMesh: {enabled: true, mode: "large_sparse_smoothing", profile: "strong"}`.

Numeric comparison (balanced/medium quality):

Phase 2B data from direct binary invocation; Phase 2C data from the real upload/worker/meshopt pipeline.

| Model | Variant | Profile | Triangles | Raw GLB bytes | Meshopt GLB bytes | Conv. time | Smoothed parts | Tiny warnings |
| --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| `large-curved-tank` | off | ??? | 524 | 66,812 | ??? | ??? | 0 | 0 |
| `large-curved-tank` | on | standard | 752 | 85,968 | ??? | ??? | 3 | 0 |
| `large-curved-tank` | on | strong (2B) | 1,052 | 111,168 | ??? | ??? | 3 | 0 |
| `large-curved-tank` | on | strong (2C pipeline) | 1,052 | 110,168 | 38,284 | 0.28 s | 3 | 0 |
| `u843-non-haz-panel` | off | ??? | 378,952 | 28,923,768 | ??? | ??? | 0 | 0 |
| `u843-non-haz-panel` | on | standard | 381,564 | 29,143,180 | ??? | ??? | 26 | 0 |
| `u843-non-haz-panel` | on | strong (2B) | 386,340 | 29,544,368 | ??? | ??? | 26 | 0 |
| `u843-non-haz-panel` | on | strong (2C pipeline) | 386,340 | 34,229,764 | 8,404,860 | 70.09 s | 26 | 0 |

Note: Phase 2B raw GLB sizes were measured before meshopt. The u843 raw GLB difference between 2B (29.5 MB) and 2C (34.2 MB) is due to a slightly different source file (985-byte difference); triangle counts are identical, confirming identical geometric output.

Triangle impact summary:

| Model | off ??? strong | off ??? standard | standard ??? strong |
| --- | --- | --- | --- |
| `large-curved-tank` balanced | +100.8% (+528 triangles) | +43.5% (+228) | +40.0% (+300) |
| `u843-non-haz-panel` balanced | +1.95% (+7,388 triangles) | +0.69% (+2,612) | +1.25% (+4,776) |

U843 strong vs off: **+1.95%** ??? within the 5% target and the 10% hard stop.
Tank strong vs off: **+100.8%** ??? expected; large sparse curved geometry benefits most.

Visual inspection findings (`strong` profile, balanced quality, isolated viewer):

Large-curved-tank:

- Main cylinder body: smooth, no visible faceting at standard viewer distance. Lighting shows continuous curvature with no polygon edges breaking through.
- Vertical stub nozzles (2 parts): slight faceting visible at high zoom, as expected at balanced quality with adaptive smoothing. Acceptable for engineering visualization.
- Pipe support and saddle plates: smooth cylindrical and flat geometry; correct.
- Materials/colors: uniform default neutral grey; correct for a STEP file with no explicit colour assignments.
- Viewer performance: instant render, 38 KB optimized GLB.
- No broken geometry, missing parts, or material artifacts.

U843 non-hazardous panel (uploaded as "original"):

- Grey manifold tubes and elbows: smooth cylindrical profile; elbows and T-junctions render cleanly with no visible faceting.
- Navy blue solenoid valves (many instances): complex multi-body shapes preserved; rounded valve heads and body cylinders render correctly.
- Red/maroon structural channel frame: sharp rectangular extrusion; correct.
- Green mounting clamps/brackets: correctly colored and shaped.
- Star/asterisk needle valves at panel right edge: characteristic geometry correct, not distorted.
- No broken materials, no color bleed, no missing parts, no hierarchy artifacts.
- Panel board: correct rectangular outline with mounting-hole details visible.
- Viewer performance: loaded in approximately 8 s for 8.4 MB optimized GLB; acceptable for a 497-part complex assembly.

Gas sticks, valves, and small fittings (U843 tiny-dense candidates): no visible distortion or flattening under `strong`. Tiny-dense coarsening is not implemented; these parts remain at baseline density and are report-only warnings.

Viewer performance did not feel noticeably worse for either model under `strong` compared to baseline expectations.

Server test issue conclusion:

Phase 2C reported 15/17 server tests passing, with `assetLibrary.test.ts` and `revisionControllers.test.ts` failing with 401 in the Docker container environment. Phase 2D investigation findings:

1. Both tests pass 17/17 in the current codebase run locally (Node 24, Windows host) both with and without `ADMIN_PASSWORD` set in the parent process environment.
2. The server reads `process.env.ADMIN_PASSWORD` per-request (not cached at startup), so the tests' `process.env.ADMIN_PASSWORD = "test-password"` override before dynamic import is correct and effective.
3. The failures cannot be reproduced and are not related to MeshIQ env vars (`MESHIQ_ADAPTIVE_MESH`, `MESHIQ_ADAPTIVE_MESH_PROFILE`).
4. Assessment: pre-existing Docker-container-specific behaviour in the Phase 2C build environment, not a code issue. Not a MeshIQ issue. Not a blocker for merge.
5. No code changes made; no production auth behaviour changed.

AGENTS.md status:

`AGENTS.md` is absent from the repository root. `CLAUDE.md` was intentionally not created in this task. A separate shared-agent-instructions task is needed before creating `CLAUDE.md`.

Recommendation:

**Option 1: `strong` is recommended as the rollout candidate behind `MESHIQ_ADAPTIVE_MESH=on`.**

Rationale:

- `strong` keeps U843 triangle increase to +1.95% ??? well within the 5% target and 10% hard stop.
- `strong` produces +100.8% more triangles on the tank versus baseline, with confirmed smooth cylinder rendering in the viewer.
- `standard` provides less cylinder improvement (+43.5% on tank) for a minor difference on U843 (0.69% vs 1.95%); the additional 7,388 triangles from `strong` on U843 are not a concern given the 386K baseline.
- `strong` is confirmed through the real upload/worker/XCAF/artifact/viewer pipeline (Phase 2C) and live visual inspection (Phase 2D).
- Adaptive default-off is preserved. This recommendation applies to manual rollout via `MESHIQ_ADAPTIVE_MESH=on` + `MESHIQ_ADAPTIVE_MESH_PROFILE=strong` in the EliteDesk environment.

Recommended next step:

Resolve agent-docs and test infrastructure before merging:

1. Add `AGENTS.md` to the repository root with shared agent rules and source-of-truth map.
2. Run `npm run typecheck && npm run lint && npm run test` across all apps to confirm clean state.
3. Confirm `docker compose -f deploy/docker-compose.elitedesk.yml config --quiet` is clean.
4. After agent docs and checks pass, merge `feature/meshiq-adaptive-tessellation` to `main` and deploy to production with `MESHIQ_ADAPTIVE_MESH=off` (default-off; no behaviour change).
5. When ready to roll out selectively, set `MESHIQ_ADAPTIVE_MESH=on` and `MESHIQ_ADAPTIVE_MESH_PROFILE=strong` in the EliteDesk production environment.

Remaining risks after Phase 2D:

- Side-by-side pixel comparison of `strong` vs `standard` vs `off` in the viewer was not performed. Only `strong` outputs exist in the isolated server; Phase 2B numeric data was used for the off/standard columns. The visual improvement was assessed from the `strong` render alone against the known numeric delta.
- Tiny-dense coarsening remains unimplemented; small functional details on U843 (gas sticks, diaphragm valves) remain at baseline density.
- U843 tessellation cache hits were 0 in Phase 2C/2D due to a different source file version; cache behaviour under repeated conversion not tested.
- Meshopt visual rendering was confirmed for `strong` only; `off` and `standard` meshopt visual rendering was not tested in the viewer.
- Visual inspection was performed at the default viewer camera angle only; zoomed close-up inspection of individual tiny-dense parts was not performed.

## Phase 2E production merge and default-off deploy

Date/time: 2026-06-26 20:16 Australia/Sydney.

Production baseline before deploy:

- Previous deployed commit: `d294769a5b2dfe28a8d9daf3acbb3ea58ddc7716`.
- Merged/deployed commit: `064239eeb771b0ab9c0cbdc9b1451aa9164d197e`.
- Merge result: `main` fast-forwarded to the reviewed MeshIQ branch tip.

Default-off confirmation:

- `MESHIQ_ADAPTIVE_MESH` was absent before deploy.
- `MESHIQ_ADAPTIVE_MESH_PROFILE` was absent before deploy.
- Both variables remained absent after deploy.
- Worker startup logs reported `MeshIQ adaptive mesh: off` and `MeshIQ adaptive profile: standard`.
- Adaptive meshing was not enabled in production.

Backup:

- Backup directory: `/home/claudio/backups/3d-model-web-viewer/meshiq-default-off-20260626-201459`.
- Database backup: `app.sqlite`.
- Backup verification: `PRAGMA integrity_check` returned `ok`; `PRAGMA foreign_key_check` returned zero rows.
- Predeploy inventory recorded 45 models, 45 model revisions, 59 jobs, 14 public shares, 43 model directories, 45 upload directories, and 70 worker-output directories.

Checks run:

- Local `git diff --check`: passed.
- Local `apps/server` typecheck, build, and tests: passed.
- Local `apps/worker` typecheck, build, and tests: passed.
- Local `apps/converter` smoke tests: passed.
- Local `apps/web` TypeScript check and production build: passed.
- Local Docker Compose config check was skipped because Docker is not installed on the Windows workstation.
- EliteDesk Docker Compose config check: passed.
- EliteDesk worker tests passed in the worker container with test-only `LARGE_STEP_*` and MeshIQ environment variables unset. An unsanitized in-container test run inherited the live `LARGE_STEP_CHUNKING_MODE=auto` runtime setting and failed the default-config assertion, so it was treated as an invalid default-env harness run rather than a code failure.

Post-deploy verification:

- Deployed HEAD on EliteDesk: `064239eeb771b0ab9c0cbdc9b1451aa9164d197e`.
- Server container: running and healthy.
- Worker container: running and polling; `/api/worker/jobs/next` returned 200 with no pending job.
- `/health` and `/api/health`: 200.
- Admin page and model list API: 200.
- Existing model details included current and active RevVault revision data.
- Existing admin viewer route and model GLB route: 200.
- Existing public share route, metadata route, and public GLB route: 200; tested share was locked-revision with revision switching disabled.
- Existing GLB and original/source download routes: 200.
- `mesh-report.json` routes returned safe 404 responses for an older model without a report.
- Postdeploy database integrity remained `ok` with zero foreign-key issues.
- Production model, revision, job, and public-share counts matched the predeploy backup counts.
- No optional tiny upload was performed, to avoid unnecessary production storage mutation during a default-off deployment.
- Rollback was not needed.

Post-deploy monitoring check:

- Date/time: 2026-06-26 20:37 Australia/Sydney.
- Production commit remained `064239eeb771b0ab9c0cbdc9b1451aa9164d197e`.
- GitHub `origin/main` was `c2a4b32900dd89bfa0b7a3fce741625ed23ba437`, a docs-only commit ahead of the deployed production commit, so no redeploy was required.
- `MESHIQ_ADAPTIVE_MESH` and `MESHIQ_ADAPTIVE_MESH_PROFILE` remained absent from production `.env`; worker logs reported adaptive mesh off with the standard profile.
- Server and worker containers were running; `/health` and `/api/health` returned 200.
- No active, queued, or newly completed real production conversion was available after the default-off deploy, so the next real conversion still needs to be observed before closing the monitoring loop.
- Latest ready baseline model route checks returned 200 for admin model API, admin viewer, GLB route, original/source download, GLB download, manifest, and token-scoped public metadata/GLB. The public root route was intentionally not fetched because it increments share access stats.
- `mesh-report.json` routes returned safe 404 responses for the checked older model where that artifact is absent.
- Counts remained sane at 43 active models, 45 active revisions, 59 jobs, 9 active public shares, 43 model directories, 45 upload directories, and 70 worker-output directories.
- No production `.env` value, database row, uploaded STEP, generated GLB, public share, or QR URL was intentionally changed during this monitoring pass.

Remaining risks:

- This deployment only proves the default-off path in production. Selective adaptive-on rollout still requires a separate explicit environment change and conversion validation.
- Browser-level inspection was limited to route/API and artifact checks to avoid placing admin credentials or public-share tokens in browser URLs.
- Existing large-model conversion behaviour should still be watched on the next real worker job because production chunking remains enabled independently of MeshIQ adaptive meshing.


### Phase 3A: Admin per-upload adaptive smoothing option

Phase 3A adds an admin-only per-upload selector without enabling MeshIQ globally in production.

Design:

- Allowed upload values are `off`, `standard`, and `strong`.
- The default is `off` whenever the field is omitted, empty, null, or missing from an older row.
- The selected value is stored on `jobs.meshiq_adaptive_smoothing` because the worker consumes jobs as immutable conversion requests.
- The same value is mirrored to `model_revisions.meshiq_adaptive_smoothing` and `revision_file_versions.meshiq_adaptive_smoothing`, matching the existing quality-preset metadata pattern for durable revision history.
- Existing rows are backward-compatible through default-off schema columns and worker payload normalization.
- The worker receives the option in `/api/worker/jobs/next` as `meshiqAdaptiveSmoothing`.
- The worker treats the job value as authoritative for Phase 3A. `off` passes no adaptive flags even if `MESHIQ_ADAPTIVE_MESH=on` is present in the worker environment.
- `standard` maps to `--adaptive-mesh on --adaptive-mesh-profile standard`.
- `strong` maps to `--adaptive-mesh on --adaptive-mesh-profile strong`.
- `manifest.json`, `stats.json`, and `mesh-report.json` record the effective per-upload selection; native XCAF report fields still record the converter's actual adaptive result.

Admin UI:

- The normal Low/Medium/High conversion quality selector stays unchanged.
- Upload and new-revision dialogs add an Advanced / Experimental MeshIQ adaptive smoothing selector with Off, Standard, and Strong.
- Off is selected by default on page load.
- The control is not shown on public viewer pages.
- Single-request and chunked upload paths both send and preserve the selected value.

Validation and tests:

- Server-side validation rejects values outside `off`, `standard`, and `strong`.
- Tests cover omitted/default Off, Standard accepted, Strong accepted, invalid value rejection, old/null worker payload fallback to Off, and chunked upload preservation.
- Worker tests cover no adaptive flags for Off, Standard flags, Strong flags, and Off suppressing adaptive flags even if the old global env is `on`.

Rollout recommendation:

- Do not deploy Phase 3A until local server, worker, converter, web, diff, and compose checks pass.
- Keep production `.env` without `MESHIQ_ADAPTIVE_MESH` and `MESHIQ_ADAPTIVE_MESH_PROFILE`.
- First production validation should use a tiny non-sensitive test model with Off, then Standard, then Strong, confirming worker logs, manifest, stats, `mesh-report.json`, admin route, and viewer route.
- Do not mutate existing public/QR URL structure, production uploaded STEP files, generated GLBs, or SQLite rows without a backup and explicit rollout prompt.

### Phase 3B: Isolated EliteDesk per-upload runtime smoke

Date: 2026-06-26.

Review result:

- Phase 3A code review found no blocker. The allowed values are exactly `off`, `standard`, and `strong`.
- Server-side parsing defaults omitted, empty, null, and older normalized values to `off`; invalid request values are rejected before job creation.
- The schema change is backward-compatible and idempotent through default-off `ALTER TABLE` additions for jobs, model revisions, and revision file versions.
- Per-job `jobs.meshiq_adaptive_smoothing` is authoritative for worker command construction. In the isolated smoke, the worker environment deliberately had `MESHIQ_ADAPTIVE_MESH=on` and `MESHIQ_ADAPTIVE_MESH_PROFILE=strong`; Off jobs still passed no adaptive flags.
- Public viewer routes, public share structure, QR/share URL shape, and public metadata paths were unchanged by this branch.

Isolated runtime method:

- EliteDesk production was left on `main` at `064239eeb771b0ab9c0cbdc9b1451aa9164d197e`; no deploy was run.
- The smoke used detached worktree `/home/claudio/projects/3d-model-web-viewer-phase3b-smoke-20260626-224241` at `21712139f83dd548f7966357b4febe5569b820ad`.
- The isolated compose project was `meshiq-phase3b`, bound only to `http://127.0.0.1:3029`.
- Isolated storage was `/home/claudio/projects/3d-model-web-viewer-phase3b-smoke-20260626-224241/phase3b-isolated-data`, including SQLite, uploads, models, logs, and worker output.
- A temporary converter wrapper in `phase3b-wrapper/xcaf-wrapper.sh` logged native XCAF argv blocks and then executed the real `/app/bin/xcaf-step-to-glb`.
- Test model: tiny safe `cube.step` from the `occt-import-js` dependency test files, copied into the isolated worktree as `phase3b-cube.step`.

Smoke results:

- Invalid value `banana`: HTTP 400 with `Invalid MeshIQ adaptive smoothing...`; job count stayed 0.
- Off upload `phase3b-off-20260626124950`: DB job, revision, and file version stored `off`; worker argv had no `--adaptive-mesh`; model reached ready; viewer, GLB, source, manifest, stats, and mesh-report routes all returned 200.
- Standard upload `phase3b-standard-20260626124951`: DB job, revision, and file version stored `standard`; worker argv included `--adaptive-mesh on --adaptive-mesh-profile standard`; model reached ready; all checked routes returned 200.
- Strong upload `phase3b-strong-20260626124952`: DB job, revision, and file version stored `strong`; worker argv included `--adaptive-mesh on --adaptive-mesh-profile strong`; model reached ready; all checked routes returned 200.
- Omitted value upload `phase3b-omitted-20260626124953`: stored and reported `off`; worker argv had no adaptive flags; all checked routes returned 200.
- Chunked upload `phase3b-chunked-20260626124956`: `/api/uploads/chunked/init` with Standard preserved the value through complete; DB, manifest, stats, mesh-report, and worker argv all matched Standard; all checked routes returned 200.
- New revision upload on `phase3b-off-20260626124950`, revision label `Smoke-Strong`: stored Strong on the new revision and active file version; worker argv used Strong; current model reached ready; all checked routes returned 200.

Artifact/report checks:

- Off and omitted manifests/stats recorded `meshiqAdaptiveSmoothing: "off"` and adaptive disabled/off.
- Standard manifests/stats/mesh-reports recorded `standard`, adaptive enabled, mode `large_sparse_smoothing`, profile `standard`.
- Strong manifests/stats/mesh-reports recorded `strong`, adaptive enabled, mode `large_sparse_smoothing`, profile `strong`.
- Public/private route checks did not expose storage paths or secrets.

Checks:

- `git diff --check`: passed.
- `apps/server`: `npm run typecheck`, `npm run build`, `npm test` passed.
- `apps/worker`: `npm run typecheck`, `npm run build`, `npm test` passed.
- `apps/converter`: `npm test` passed.
- `apps/web`: `npx tsc --noEmit` and `npm run build` passed. The Vite build retained the existing large chunk warning.
- Local Windows Docker was unavailable, so local compose validation was skipped. EliteDesk read-only `docker compose -f deploy/docker-compose.elitedesk.yml config --quiet` passed.

Blockers and recommendation:

- No Phase 3B blocker was found.
- No code fix was required.
- Remaining risk is normal rollout risk: this smoke used one tiny safe STEP file and does not prove visual quality on large coworker models.
- Recommendation: branch is ready for PR/review. Do not merge or deploy until an explicit rollout prompt authorizes the production change.

### Phase 3: Selective simplification behind a flag

- Add worker-side simplification after raw GLB and before meshopt compression.
- Operate per part/primitive.
- Preserve names/materials/colors/hierarchy.
- Validate before publishing.
- Record before/after counts in `mesh-report.json`.
- Keep default off until visual and numeric benchmarks pass.

### Phase 4: Admin/report visibility

- Expose `mesh-report.json` in the admin model detail view.
- Add compact summaries: total triangles, density outliers, large sparse parts, slow mesh parts, simplification savings.
- Link raw report for download/debug.
- Do not block existing viewer/share workflows if report is absent.

### Phase 5: Benchmark and default-preset tuning

- Run the benchmark set across low/medium/high.
- Compare visual quality, triangle count, GLB size, conversion time, and outlier lists.
- Tune clamps and thresholds.
- Decide whether adaptive should default on for one preset first, likely `medium`.

### Phase 6: Production rollout

- Roll out behind environment flag on EliteDesk.
- Convert a small safe sample first.
- Verify reports, admin UI, logs, and viewer.
- Convert a larger known model.
- Only then consider making adaptive the default.
- Preserve existing QR/share links and model data throughout.

## Risks

- Over-coarsening small functional details can make models look wrong even if the parts are tiny.
- Under-tessellating large cylinders can remain visibly faceted if angular deflection is not tightened enough.
- Tightening large curved surfaces can increase conversion time and file size.
- Per-shape adaptive values may reduce mesh reuse if repeated prototypes are used at different scales.
- Simplification can break sharp CAD edges, normals, material boundaries, or primitive identity if applied globally.
- Chunked conversion must produce consistent adaptive behavior across chunks.
- `IMeshTools_Parameters` may not behave identically across OpenCascade versions.

## What Not To Do Yet

- Do not enable adaptive meshing by default.
- Do not deploy to EliteDesk production.
- Do not touch production database, uploaded STEP files, generated GLBs, or QR/share links.
- Do not run migrations.
- Do not globally simplify the whole model.
- Do not merge different parts/materials to reduce triangles.
- Do not replace the native metadata/color pipeline.
- Do not tune from one model only.
- Do not touch the Pi, Cloudflare, Plex, Immich, Homepage, Portainer, Dozzle, Uptime Kuma, router, or backups.

## Recommended Next Implementation Prompt

Implement Phase 1 of MeshIQ only. Add `mesh-report.json` instrumentation to the native XCAF converter and worker plumbing without changing tessellation behavior. The report should include current global deflection values per part, per-part bbox, triangle count, vertex count, density score, structured meshing time where available, and rankings for tiny dense parts, large sparse parts, and slow mesh parts. Keep adaptive meshing and simplification disabled/unimplemented. Run the full server, worker, converter, web, diff, and compose checks before committing.
