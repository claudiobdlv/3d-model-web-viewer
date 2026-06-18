# ModelBase GLB optimization plan

## Status and decision

This is a research and implementation plan. It does not change conversion output or existing models.

ModelBase should implement **both** conversion-time tessellation control and GLB post-processing, in that order:

1. Store a per-job `low | medium | high` quality choice and map it to the native XCAF converter's existing `preview | balanced | high` tessellation presets.
2. Establish size, triangle-count, visual, metadata, picking, and load-time baselines for those presets.
3. Add only verified, identity-preserving post-processing. Prefer Meshopt compression after viewer decoder support is deployed and tested.
4. Treat simplification, welding, and joining as later experiments, not default optimizations.

Tessellation is the first and most important lever because triangles never generated do not consume conversion time, disk, network, decode, GPU memory, or raycasting time. Compression is still useful, but it does not reduce rendered triangle count by itself.

## Problem and invariants

Large STEP assemblies currently produce GLBs of hundreds of megabytes. The optimization target is lower transfer size, lower decoded memory where possible, faster loading, and usable mobile rendering while preserving:

- native XCAF colour and transform behaviour;
- material and colour boundaries;
- component and object names;
- `stableObjectId`, `selectableId`, and related picking metadata;
- a separate selectable object boundary for each component/material bucket;
- cylinders, holes, threads, flanges, fittings, and sharp mechanical edges;
- current source orientation and viewer-only display rotation;
- a path to accurate measurement. Render-mesh measurement must always disclose its preset and tolerance; exact CAD measurement should ultimately use source B-Rep data, not a compressed display mesh.

No optimization phase may mutate an uploaded source, overwrite an existing model, or replace a known-good GLB in place. Generate a candidate, validate it, and publish by atomic rename only after all gates pass.

## Current repository findings

### Native conversion and tessellation

Production uses the native XCAF path (`CONVERTER_BACKEND=xcaf-baseline`). The converter at `spikes/occt-xcaf-glb/src/main.cpp` already calls `BRepMesh_IncrementalMesh` with relative linear and angular deflection and exposes these presets:

| Native preset | Relative linear deflection | Angular deflection (radians) | Proposed UI mapping |
| --- | ---: | ---: | --- |
| `preview` | 0.85 | 0.65 | Low |
| `balanced` | 0.45 | 0.50 | Medium (default) |
| `high` | 0.12 | 0.22 | High |

These exact values are a safe first implementation because they already exist in the converter. They are not yet proven final product thresholds; the benchmark matrix below should determine whether `preview` preserves small circular features acceptably and whether `high` is unnecessarily dense on large assemblies.

The worker currently selects one global `CONVERTER_QUALITY`. It maps legacy `fast` to native `preview`, `detailed` to native `high`, and otherwise passes the configured value to the native converter. Quality is already written to worker output logs, `stats.json`, and `manifest.json`, but it is not job-specific.

### Geometry and identity

The native writer currently emits one GLB node and mesh per component/material bucket. Node and primitive extras include selection and naming metadata, including `stableObjectId`, `selectableId`, `parentObjectId`, XCAF label paths, object/component/product names, colour source, and geometry source. Assembly hierarchy is currently flattened; identity is carried by names and extras rather than parent/child GLB hierarchy.

The converter intentionally duplicates triangle vertices to preserve sharp CAD normals and face-colour identity. This makes generic welding unsafe without CAD-specific regression tests.

The React viewer and the legacy viewer both use three.js `GLTFLoader`, raycasting, and extras copied into `userData`. Neither viewer currently configures `DRACOLoader` or `MeshoptDecoder`. Compressed assets must not be produced until both active viewer paths have the required decoder and uncompressed assets remain supported.

### glTF tooling already present

The committed JS converter uses `@gltf-transform/core` to construct and validate GLBs, but has no active optimization transform. The React app has `meshoptimizer` only as a transitive dependency and does not register its decoder. An untracked root `package.json` in the current working tree mentions `@gltf-transform/functions`; it is not committed application infrastructure and should not be treated as reusable production wiring.

## Recommended quality presets

The product stores the stable semantic values `low | medium | high`. Converter-specific names remain an internal mapping so native parameters can evolve without changing historical job records.

### High

- Native XCAF preset: `high` (`linear=0.12`, `angular=0.22`, relative).
- Preserve all object/material buckets and metadata.
- Initial post-process: validation, removal of provably unused resources, exact resource deduplication only where node and primitive extras remain unchanged, and optional vertex/index reordering that does not require a compressed extension.
- No simplification, join, or weld.
- No position quantization in the first release. Trial Meshopt compression later, without changing geometry values.
- Purpose: close inspection and highest display-mesh measurement fidelity.

### Medium (default)

- Native XCAF preset: `balanced` (`linear=0.45`, `angular=0.50`, relative).
- Same identity and metadata rules as High.
- Safe cleanup and exact resource deduplication after structural comparison.
- Trial normal quantization and conservative position quantization only after silhouette, sharp-edge, bounding-box, and picking tests. A starting experiment is 14-bit position and 10-bit normal quantization; it is not enabled by this plan.
- Prefer Meshopt compression after decoder support and device benchmarks.
- No simplification, join, or generic weld in the first release.
- Purpose: balanced desktop/mobile default.

### Low

- Native XCAF preset: `preview` (`linear=0.85`, `angular=0.65`, relative).
- Preserve component/material buckets and all identity metadata.
- Same safe cleanup as Medium.
- Trial 12-bit position and 8-bit normal quantization, gated by feature and silhouette tests; do not assume these values are acceptable before benchmarking.
- Prefer Meshopt compression after decoder support and device benchmarks.
- Cautious per-object simplification may be investigated later, but only with locked object boundaries, borders/material seams, normals, and a maximum geometric error tied to object size. It must never be the initial Low implementation.
- Purpose: smallest practical display asset and better mobile interaction, with clearly lower tessellation fidelity.

## Pipeline recommendation

### During OpenCascade meshing

1. Resolve the job's semantic quality to the existing native preset.
2. Keep the existing XCAF import, colour resolution, transform accumulation, naming, and object-bucketing code unchanged.
3. Record the semantic preset, native preset, exact deflections, OCCT version, triangle/vertex counts, conversion time, and source/output bytes.
4. Consider model-scale- or feature-aware meshing only after the fixed presets are benchmarked. Relative deflection is a useful baseline but can underrepresent small features within very large parts.

Lower tessellation should carry most of the Low/Medium triangle reduction. It protects topology-aware boundaries because OCCT generates the mesh from B-Rep faces before the GLB identity structure is built.

### After GLB generation

Use a separate candidate file and an allowlisted transform sequence:

1. Read and validate the raw GLB.
2. Snapshot node count, mesh/primitive count, material assignments, node names, transforms, extras, accessor bounds, and per-ID triangle counts.
3. Remove only genuinely unused resources. Do not prune metadata-bearing nodes.
4. Deduplicate byte-identical accessors/materials where this does not merge nodes, primitives, extras, or picking identities.
5. Optionally reorder vertex/index data for locality. This changes storage order, not shape or identity.
6. Apply preset-gated quantization only after visual and numeric tolerances are defined.
7. Apply Meshopt buffer compression only after all served viewers register the decoder.
8. Re-read the candidate and compare it to the snapshot. Reject it on any structural, metadata, transform, material, bounds, validation, or picking mismatch.
9. Publish atomically and retain the raw candidate temporarily for rollback/analysis according to a storage policy.

### Safe now or suitable for the first spike

- Lower/raise tessellation through the existing native presets.
- Validation and metric collection.
- Removal of unreachable resources, with metadata-bearing node protection.
- Exact accessor and material deduplication when structural identity is verified.
- Index/vertex-cache reordering that preserves primitive boundaries.
- Meshopt compression after decoder deployment.
- Conservative quantization as a measured experiment, not an assumed lossless operation.

### Unsafe or delayed

- **Joining meshes/primitives:** can erase separately selectable parts, material boundaries, names, and extras.
- **Generic welding:** the current converter duplicates vertices intentionally for sharp normals and face-colour boundaries. Welding may create smoothing or colour seams and may change topology.
- **Blind simplification/decimation:** can flatten small holes, cylinder segments, threads, fasteners, flange edges, and sharp corners. It also degrades mesh-based measurement.
- **Scene flattening or transform baking:** current transform/orientation behaviour is solved and should not be reopened by an optimization pass.
- **Material merging by colour alone:** visually equal colours may belong to different selectable or semantically distinct objects.
- **Aggressive pruning:** may remove metadata-only identity nodes if hierarchy is introduced later.
- **Texture work as an initial priority:** current CAD assets are primarily flat materials/colours. Add KTX2/WebP/AVIF work only if textured assets become material to file size.

## Meshopt, Draco, and quantization

Both `EXT_meshopt_compression` and `KHR_draco_mesh_compression` require client-side decoding when declared as required extensions. Compression reduces transfer and stored buffer size but does not reduce final triangle count or GPU geometry requirements. Decode work, temporary memory, and JavaScript/WASM startup must be included in mobile tests.

Meshopt is the preferred first compression experiment for ModelBase:

- it is designed for fast decoding and can compress general glTF buffer data;
- three.js `GLTFLoader` supports it through `setMeshoptDecoder`;
- it composes naturally with quantization and geometry reordering;
- it is a better fit for interactive CAD loading where decode latency matters.

Draco remains a useful comparison candidate because it can achieve strong mesh compression, but it needs `DRACOLoader`, commonly has a heavier decode path, and replaces primitive geometry data through its extension. Benchmark it rather than assuming that the smallest network file gives the best time-to-interactive.

Quantization reduces attribute precision and makes compression more effective. It is not visually or numerically lossless. Position error must be evaluated in model units and relative to object dimensions; normal error must be checked on cylinders and hard edges. Any future measurement UI must identify the display preset and must not claim source-CAD precision from a quantized/tessellated mesh.

Primary references:

- [OpenCascade `BRepMesh_IncrementalMesh`](https://dev.opencascade.org/doc/refman/html/class_b_rep_mesh___incremental_mesh.html)
- [glTF-Transform functions](https://gltf-transform.dev/modules/functions.html)
- [glTF-Transform optimize transform](https://gltf-transform.dev/modules/functions/functions/optimize.html)
- [EXT_meshopt_compression specification](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Vendor/EXT_meshopt_compression)
- [KHR_draco_mesh_compression specification](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_draco_mesh_compression)
- [KHR_mesh_quantization specification](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_mesh_quantization)
- [three.js `GLTFLoader`](https://threejs.org/docs/#examples/en/loaders/GLTFLoader)
- [three.js `DRACOLoader`](https://threejs.org/docs/#examples/en/loaders/DRACOLoader)

## Persistence and code-change map

The first implementation should add one non-null job column, for example `quality TEXT NOT NULL DEFAULT 'medium' CHECK (quality IN ('low','medium','high'))`. Existing databases need an idempotent `ensureColumn` migration; validation must also happen in application code because SQLite cannot add this constraint cleanly to an existing column through the current helper.

Store quality on the conversion job, not only the model, because a model may later be reconverted at a different preset. The generated manifest/stats/log should copy the job value. A model details response can expose the latest conversion job's quality separately later.

Files expected to change:

| Concern | File(s) | Required change |
| --- | --- | --- |
| Upload modal | `apps/web/src/main.tsx` | Add Low/Medium/High pills; default Medium; apply only to STEP/STP files. For mixed multi-file uploads, send quality only for STEP/STP. |
| Upload request | `apps/web/src/api.ts` | Add validated quality to STEP/STP multipart form data. |
| Shared UI records | `apps/web/src/types.ts` | Add quality to job/detail types when returned. |
| Upload and job creation | `apps/server/src/routes/models.ts` | Parse/validate `quality`; ignore or reject it consistently for direct GLB/GLTF uploads; pass it to `createJob`. |
| DB schema and queries | `apps/server/src/db.ts` | Add/migrate `jobs.quality`, update `JobRecord`, `createJob`, list queries, and worker job selection. |
| Worker API | `apps/server/src/routes/worker.ts` | Include job quality in `/jobs/next`; quality remains immutable after claim. |
| Worker contract | `apps/worker/src/client.ts` | Add quality to `WorkerJob`. |
| Converter invocation | `apps/worker/src/worker.ts`, `apps/worker/src/converterProcessor.ts` | Use job quality rather than global quality; map `low->preview`, `medium->balanced`, `high->high`; keep `CONVERTER_QUALITY` only as a backward-compatible fallback during rollout. |
| Logs/artifacts | `apps/worker/src/converterProcessor.ts` | Continue recording semantic and native preset in log, stats, and manifest. |
| Decoder support | `apps/web/src/viewer/ViewerPage.tsx`, `apps/server/public/model.js` if still served | Register Meshopt/Draco decoder before compressed GLBs can be published. Prefer removing the legacy path in a separate, explicit change rather than silently leaving it incompatible. |
| Post-process stage | New worker module plus worker package dependencies | Read raw output, transform to a candidate, validate metadata/structure, then publish. Keep this isolated from XCAF colour/name/transform logic. |

The current upload modal is `UploadModal` in `apps/web/src/main.tsx`; upload job creation is `POST /api/models` in `apps/server/src/routes/models.ts`; converter arguments are assembled in `apps/worker/src/worker.ts` and `apps/worker/src/converterProcessor.ts`; quality logging already occurs in `converterProcessor.ts` and the native `conversion.log`.

## Implementation phases

### Phase 0: benchmark harness

- Select only copied/non-production fixtures: a simple coloured part, cylinder/hole plate, screw/thread sample, flange/fitting, repeated assembly, and the largest safe representative assembly.
- Capture source size, GLB size, node/mesh/primitive/material counts, triangles, conversion time, load/decode time, peak browser memory where available, first render, first successful pick, and FPS during orbit.
- Add a metadata signature keyed by `stableObjectId` containing names, material, bounds, and triangle count.

### Phase 1: per-job tessellation quality

- Add the UI pills and persistence contract together; do not ship a decorative selector that has no conversion effect.
- Default existing and omitted requests to Medium.
- Keep the converter's existing native values unchanged.
- Show quality in job details/logs.
- Roll out server and worker compatibility before relying on the field, so old/new components interoperate safely.

### Phase 2: safe post-process spike

- Add glTF-Transform in the worker package, not an untracked repository-root package.
- Run validation, structural snapshots, safe cleanup/dedup, and optional reorder on copied fixtures.
- Compare byte and gzip/Brotli transfer sizes as well as raw GLB sizes. Plain geometry may already compress well over HTTP, so on-disk percentage alone is misleading.

### Phase 3: decoder and Meshopt rollout

- Add the Meshopt decoder to every live viewer path and verify old uncompressed GLBs first.
- Deploy decoder-capable viewers before producing compressed assets.
- Gate Meshopt output behind a server/worker feature flag and fall back to the validated uncompressed candidate on failure.
- Benchmark Low/Medium/High on desktop and representative mobile devices.

### Phase 4: quantization experiments

- Start with Medium 14/10 and Low 12/8 position/normal bit targets.
- Define absolute and relative bounds tolerances before enabling either preset.
- Keep High unquantized until evidence supports a transparent setting.

### Phase 5: optional CAD-aware simplification research

- Only if tessellation plus compression misses size/performance targets.
- Operate within one stable object/material bucket at a time.
- Lock boundaries, material seams, and sharp features; reject topology, silhouette, or minimum-feature failures.
- Keep it feature-flagged and off by default.

## Test matrix and release gates

Run every representative fixture at Low, Medium, and High against raw, safe-cleanup, quantized candidate, Meshopt candidate, and (comparison only) Draco candidate.

### Structural and metadata gates

- Same set and count of `stableObjectId` and `selectableId` values.
- Same node names, object/component/product names, XCAF label paths, and relevant extras.
- Same node transforms and world-space bounds within the preset's numeric tolerance.
- Same material assignment and colour factors per stable ID.
- No cross-ID mesh join and no lost selectable primitive.
- GLB validator passes with no new errors.

### Visual and mechanical gates

- Golden views from at least six directions plus close-ups of circles, holes, threads, flange edges, fittings, thin walls, and sharp corners.
- Silhouette/pixel-diff thresholds at fixed cameras.
- No smoothing across intended hard edges and no cracks at material boundaries.
- Known dimensions measured on the display mesh, with error recorded by preset.
- Picking the same test points resolves to the same stable/selectable IDs.

### Performance gates

- Network bytes with actual production HTTP content encoding.
- Download, decoder initialization, decode, first render, and first-pick times separately.
- Peak browser memory and GPU failure/out-of-memory behaviour.
- Desktop Chrome/Edge and representative Android/iOS hardware, including a cold-cache run.
- Orbit FPS and raycast latency on the largest fixture.

### Repository checks for implementation changes

Run:

```text
npm --prefix apps/web run build
npm --prefix apps/server run typecheck
npm --prefix apps/server run build
npm --prefix apps/worker run typecheck
npm --prefix apps/worker run build
git diff --check
docker compose -f deploy/docker-compose.elitedesk.yml config --quiet
```

If native parameters or converter code change, also build the native converter and run its existing simple-object and assembly report comparisons. Phase 1 should not need a native code change because the required presets already exist.

## Expected effects

Do not promise a universal compression ratio: CAD topology, repeated parts, face segmentation, and preset sensitivity vary substantially. Use these as benchmark hypotheses, not release claims:

- Tessellation changes should produce the largest reduction in triangle count, decoded geometry memory, raycast cost, and render cost.
- Safe cleanup/dedup may range from negligible to useful depending on repeated accessors/materials; it should not be justified by size alone if it complicates identity.
- Meshopt should materially reduce geometry transfer/storage with fast decode, but decoded GPU geometry remains broadly proportional to vertex/index count.
- Quantization can improve both raw and compressed sizes, with a measurable positional/normal error budget.
- Simplification can reduce triangles further but has the highest risk to mechanical features and measurement, so it has no expected production benefit until the gated experiment proves one.

Each benchmark report should state actual bytes, percentages, triangles, decode time, peak memory, and visual/measurement error rather than describing a preset as merely “optimized.”

## Risks and rollback

- Keep post-processing behind an environment feature flag, default off.
- Keep per-job quality immutable and recorded so output is reproducible.
- Never rewrite existing production models in bulk. Reconvert only through an explicit future action.
- Publish only after validation; otherwise retain/use the native raw GLB and mark the optimization failure in the conversion log without failing an otherwise valid conversion.
- Deploy decoder-capable viewers before compressed outputs.
- Retain a short-lived raw artifact or reproducible source plus exact converter settings for rollback.
- Track output format/pipeline version in manifest and stats.
- A rollback disables post-processing and restores Medium-to-`balanced` native conversion; it does not require changing colour, naming, transform, upload, storage, or viewer logic.

## Recommended next implementation prompt

Implement Phase 1 only: add a STEP/STP-only Low/Medium/High pill selector (Medium default), persist `jobs.quality`, send it through the worker API, map it to the native `preview/balanced/high` presets, and expose both semantic/native quality in logs and artifacts. Do not add glTF post-processing, decoder dependencies, quantization, simplification, weld, join, or native converter changes. Add contract tests for omitted/invalid values and verify one small copied STEP fixture at each preset without touching existing models.
