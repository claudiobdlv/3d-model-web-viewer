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

### Phase 2: Adaptive OCCT tessellation behind a flag

- Add CLI flag such as `--adaptive-mesh on|off`.
- Add worker env/config flag.
- Compute assembly bbox and per-shape bbox before meshing.
- Compute adaptive linear/angular values with conservative clamps.
- Preserve relative mode and parallel mode.
- Include adaptive values in reuse keys.
- Write deflection reasons and clamp decisions into `mesh-report.json`.
- Keep default off until benchmarks are reviewed.

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
