# Mobile viewer performance and compression spike

Date: 2026-06-19

## Current problem

ModelBase now produces visually acceptable CAD tessellation, but representative display GLBs are large enough that transfer dominates mobile startup. The U843 model used in this spike is 85,499,096 bytes (81.54 MiB). The production converter output was treated as immutable during this work: no production model was replaced or reconverted.

This spike separates four concerns:

- **Transfer size:** bytes fetched before parsing can begin.
- **Decode time:** CPU/WASM work required to reconstruct GPU-ready geometry.
- **GPU/rendering:** uploaded vertex data, draw calls, fill rate, shadows, and per-frame JavaScript.
- **Visual crispness:** canvas backing resolution relative to its CSS size and device pixel ratio (DPR).

## Reference project findings

Reference: `Silanna PCW Panel AR - Model Viewer/app` (inspected as reference material only; it remains untracked and was not copied into ModelBase).

- It uses `<model-viewer>` directly from unpkg, not the custom ModelBase Three.js viewer.
- Attributes are `camera-controls`, `enable-pan`, `camera-orbit="20deg 60deg 2m"`, `min-field-of-view="0.1deg"`, `orbit-sensitivity="1"`, `bounds="tight"`, `environment-image="neutral"`, `shadow-intensity="1"`, and AR modes.
- It supplies a poster and custom progress bar, which improve perceived startup but do not reduce geometry transfer or decode time.
- Its extra JavaScript implements mouse/touch panning and tap-to-recenter. It does not implement ModelBase-style selectable-object raycasting or metadata lookup.
- It does not apply a CSS transform to the viewer and does not contain an app-level DPR cap.
- The referenced Silanna asset is recorded in `.glitch-assets` as a **2,305,796-byte** `.gltf`. That is about 37 times smaller than the 85.5 MB U843 test GLB, so the reference's reported speed is not evidence that `<model-viewer>` alone is faster. Asset size/content is the dominant known difference.
- The Glitch CDN host could not be resolved from the test environment, so the current remote asset's buffers, extensions, and live rendering could not be inspected. The repository metadata establishes the top-level asset size but not whether buffers were embedded or external.

The reference's camera, environment, and shadow settings affect appearance and GPU cost, but they do not explain an order-of-magnitude transfer difference. Copying these settings into ModelBase is not recommended without a controlled visual comparison.

## Current viewer findings

Active path: `apps/web/src/viewer/ViewerPage.tsx`.

- It is a custom Three.js `WebGLRenderer`, `GLTFLoader`, and `OrbitControls` viewer. It is not `<model-viewer>`.
- Rendering is already event-driven. It schedules frames for initial load, resize, control damping, and the 240 ms quarter-turn animation; it does not continuously render while idle.
- Raycasting runs only after a pointer-up that moved no more than six CSS pixels. It is not performed continuously.
- The selectable mesh list is built once after load. Selection display names are cached in a `WeakMap`; scene traversals are not repeated per frame.
- There are three inexpensive lights and no shadows, environment map, post-processing, or expensive per-frame material work.
- The two wrapper groups provide the Z-up display rotation and centre-of-model pivot required by Rotate X/Y. They add two transforms, but not geometry or draw calls, and are not a credible startup bottleneck.
- Bounds are calculated once for pivoting and once for camera framing after load. They are not recalculated while orbiting.
- The canvas uses `renderer.setSize(cssWidth, cssHeight, false)` and is not CSS-transformed. CSS scaling is not the blur source.
- The viewer deliberately capped DPR at 1.5. On a DPR-2 phone that renders only 75% of the required linear backing resolution (56.25% of native pixel count), which is a direct and testable blur cause.
- The legacy fallback path `apps/server/public/model.js` already caps DPR at 2, but does not register a Meshopt decoder. Production normally serves the built React frontend; the fallback should be updated before compressed assets ever become mandatory across all deployment modes.

## Blurry mobile root-cause hypotheses

Ranked by current evidence:

1. **Confirmed code-level cause: DPR cap of 1.5.** The canvas is intentionally undersampled on common DPR-2 and DPR-3 phones. The cap is now 2, matching the legacy viewer and preserving a guard against 3x-4x fill cost.
2. **Large-assembly interaction cost.** U843 renders 3,033,144 vertices. During orbit damping, a higher DPR increases fill cost; this can reduce smoothness on weak mobile GPUs even though idle rendering is cheap.
3. **Camera/lighting softness.** The 45-degree FOV and hemispheric fill can make edges look less contrasty, but there is no post-process blur, shadow map, or environment convolution. These are aesthetic hypotheses, not demonstrated defects.
4. **Browser/device dynamic resolution.** Not controlled by ModelBase. Real-device profiling remains necessary, especially on Safari and thermal-limited Android devices.

## Techniques evaluated

### Meshopt compression

Test command (copied artifact only):

```powershell
npx --yes @gltf-transform/cli@4.4.0 meshopt u843-raw.glb u843-meshopt.glb `
  --level medium --quantize-position 16 --quantize-normal 12 `
  --quantize-texcoord 14 --quantize-generic 16
```

Meshopt produced the best byte result. The Three.js loader requires `setMeshoptDecoder()` for `EXT_meshopt_compression`; the active viewer now registers Three's bundled decoder. Existing uncompressed GLBs continue through the same loader.

The extension is designed for fast WASM decoding directly into GPU-ready buffer views and remains compatible with HTTP gzip/Brotli. See the [Khronos extension specification](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/EXT_meshopt_compression/README.md), [meshoptimizer glTF guidance](https://github.com/zeux/meshoptimizer/blob/master/gltf/README.md), and [Three.js GLTFLoader source](https://github.com/mrdoob/three.js/blob/r166/examples/jsm/loaders/GLTFLoader.js).

### Conservative quantization only

The same 16-bit position, 12-bit normal, 14-bit UV, and 16-bit generic settings were tested without Meshopt. This isolates the storage/GPU effect of `KHR_mesh_quantization`. It reduced bytes substantially, but far less than Meshopt.

### Draco comparison

Draco was tested with sequential encoding, 16-bit positions, 12-bit normals, and decode-speed preference 8. It was smaller than raw but larger than Meshopt. It requires a separate Draco decoder setup that was not added to the viewer. Meshopt remains preferable because it was smaller in this sample, is designed for very fast decode, and fits the preferred rollout direction.

### Cleanup, deduplication, and cache optimization

- No explicit dedup, weld, join, flatten, merge, prune, simplify, or decimate command was run.
- The individual glTF-Transform commands automatically removed accessors replaced by their transformed equivalents; node/mesh/primitive counts and metadata were unchanged.
- Index/vertex ordering is inherent to Meshopt's encoding. No independent reorder-only production stage was added.
- Model artifact URLs are currently mutable (`.../:slug/display.glb`) because reconversion may replace the file. Public model responses explicitly use `private, no-store`; admin model files are sent with normal Express revalidation behavior. Adding long-lived or immutable caching to these URLs risks stale models, so no cache header was changed.
- A future cache phase should use content-hashed or artifact-versioned GLB URLs, then apply long-lived immutable caching to those URLs only. Downloads can keep their current disposition and validation behavior.

## Test artifacts and results

All files are under ignored scratch directory `.tmp/mobile-performance-spike/` and are not committed:

| Variant | Bytes | MiB | Reduction | Required extension |
| --- | ---: | ---: | ---: | --- |
| Raw production copy | 85,499,096 | 81.54 | baseline | none |
| Quantized | 48,989,908 | 46.72 | 42.7% | `KHR_mesh_quantization` |
| Draco | 19,540,872 | 18.64 | 77.1% | `KHR_draco_mesh_compression` |
| Meshopt | 16,978,808 | 16.19 | **80.1%** | `EXT_meshopt_compression`, `KHR_mesh_quantization` |

Representative source: EliteDesk model `u843-non-haz-panel-20260618082048`, copied from its `display.glb`. The requested `...20260618100539` slug was not present; this ready U843 variant was selected instead.

### Structural and metadata gate

Raw, quantized, Draco, and Meshopt files each retained:

- 196 nodes, 196 meshes, 196 primitives, and 6 materials;
- 3,033,144 rendered vertices;
- all 196 node extras records;
- all 196 `stableObjectId` values and all 196 `selectableId` values;
- identical node-name, mesh-name, and node-extras hashes;
- identical material names, metallic/roughness values, and numeric base colours.

The raw material JSON uses fixed six-decimal formatting while transformed files use shorter equivalent numeric formatting; values are unchanged.

Raw bounds were `[15281.21875, -1921.32581, -0.62668]` to `[16137.48047, -1234.39478, 156.315]`. Conservative Meshopt bounds were `[15281.21875, -1921.32748, -0.62668]` to `[16137.48047, -1234.39463, 156.31475]`. Maximum observed bound drift was about 0.0017 model units over an approximately 856-unit span.

### Browser validation

A temporary local server loaded the real production web build with either the raw or Meshopt scratch GLB. This was a DPR-1 desktop browser and local-disk transfer, not a mobile-network benchmark.

- Raw and Meshopt both loaded without console warnings/errors.
- Meshopt picking selected `GTC UHP MINI GAS STICK, GS8-02-150 + 1/2" MALE VCR X 1/2" FEMALE VCR`, proving decoded geometry, metadata lookup, and selected-name behavior.
- Rotate X and Rotate Y controls remained present; both animation paths ran without console errors.
- Fresh local first-interactive probes were approximately 1.31 seconds for raw and 1.33 seconds for Meshopt. This shows no concerning decode regression locally, but the local transfer path intentionally cannot demonstrate Meshopt's network benefit.
- The test browser reported DPR 1 and a 1280x664 CSS/backing canvas, so it could not visually validate the DPR-2 crispness improvement. The backing-resolution issue is established directly by the prior `min(devicePixelRatio, 1.5)` code.

Actual mobile transfer, decode, thermal behavior, and orbit feel were not measured in this spike. Those require a physical phone and network throttling or production-like hosting of versioned test artifacts.

## Safe changes implemented now

1. Raised the active viewer DPR cap from 1.5 to 2. This is a small, reversible crispness fix and matches the legacy fallback viewer's cap.
2. Registered Three.js's bundled `MeshoptDecoder` on the active `GLTFLoader`. This is backwards-compatible with existing uncompressed GLBs and does not make compressed assets mandatory.

No worker, server artifact, converter, native OpenCascade/XCAF, colour, naming, orientation, camera, light, metadata, or production model output was changed.

## What must wait

- Production worker post-processing and default compressed output.
- Legacy fallback viewer Meshopt support.
- Uploading or replacing a production `display.glb` with a compressed candidate.
- Versioned artifact URLs and immutable cache headers.
- Physical iOS/Android first-render, decode, memory, thermal, and orbit testing.
- Visual CAD edge/cylinder comparison at DPR 2 on a real phone.
- A decision on whether 16-bit positions are conservative enough for all model scales; very large coordinate ranges should be sampled independently.
- Brotli/gzip effectiveness for GLB responses at the actual reverse-proxy layer. Binary compression policy was not changed.

## Recommended production phases

### Phase 1: compatibility and real-device test

- Deploy the decoder/DPR viewer change while keeping every production GLB uncompressed.
- Host a copied Meshopt candidate at a separate, versioned test URL outside production model folders.
- Test old and Meshopt assets on representative iPhone and Android devices, recording transfer, response-end, decoder completion, first frame, memory, and orbit FPS.
- Visually compare cylinders, small holes, edge silhouettes, colours, orientation, picking, selected names, and both quarter-turn controls.

### Phase 2: deterministic optimizer script

- Add a standalone, opt-in script pinned to a reviewed glTF-Transform version.
- Use the conservative settings from this spike and reject output unless structural, metadata, colour, bounds, and viewer smoke gates pass.
- Keep raw `display.glb` and optimized output separate. Do not overwrite in place.
- Record input/output hashes, command version/settings, sizes, and validation report.

### Phase 3: versioned artifact delivery

- Add an optimized artifact field/version to the model manifest or database.
- Serve content-hashed/versioned optimized URLs with long-lived immutable caching.
- Retain the raw GLB for download and rollback.
- Select optimized display output only after conversion and validation succeed; otherwise fall back to raw.

### Phase 4: guarded worker integration

- Add the optimizer behind a disabled-by-default feature flag.
- Canary on copied/new models only, then enable per model or conversion job.
- Monitor conversion time, worker memory, output validation failures, browser decode errors, and mobile first-render metrics before changing defaults.

## Risks and rollback

- Quantization can visibly move fine geometry when coordinates span a very large range. Mitigate with conservative precision, per-model bounds checks, and visual sampling.
- Raising DPR from 1.5 to 2 increases worst-case pixel fill by about 78% at the cap. Event-driven rendering limits idle cost, but low-end mobile orbit smoothness must be checked. Rollback is a one-line DPR cap change; an adaptive interaction-resolution strategy is a later option if needed.
- Meshopt requires WASM and decoder registration. The active viewer is now compatible, but the legacy fallback is not. Do not require compressed files until all served viewer paths are covered.
- Mutable artifact URLs make aggressive caching unsafe. Introduce versioned URLs before immutable headers.
- Any optimizer can expose library regressions on unusual GLBs. Keep raw artifacts, validate before publication, and use automatic raw fallback.

## Recommended next implementation prompt

> Build an opt-in, deterministic Meshopt optimization tool for ModelBase without changing the production worker default. Use glTF-Transform with pinned conservative settings (16-bit position, 12-bit normal), write to a separate versioned output, and emit a machine-readable validation report comparing node/mesh/primitive counts, names, extras, stableObjectId/selectableId, materials/colours, bounds, and loadability. Add tests and a local benchmark harness, but do not overwrite display.glb or activate optimized delivery.
