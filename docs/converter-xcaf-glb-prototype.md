# Native OpenCascade/XCAF GLB prototype

## Purpose

This prototype is now also available as the production worker backend
`CONVERTER_BACKEND=xcaf-baseline`. The original spike remains under
`spikes/occt-xcaf-glb/` for investigation. It reads STEP/STP with native
OpenCascade XCAF, tessellates renderable CAD shapes, writes a GLB, and writes a
JSON sidecar report for colour/name/hierarchy inspection.

The production worker image builds the same native binary into
`/app/bin/xcaf-step-to-glb` and selects it with:

```bash
CONVERTER_BACKEND=xcaf-baseline
```

The fallback production backend remains:

```bash
CONVERTER_BACKEND=occt-js
```

## Files

- `spikes/occt-xcaf-glb/src/main.cpp` - native XCAF reader, tessellator, GLB
  writer, and report writer.
- `spikes/occt-xcaf-glb/CMakeLists.txt` - CMake build for the prototype.
- `spikes/occt-xcaf-glb/Dockerfile` - isolated Ubuntu/OpenCascade build image.
- `spikes/occt-xcaf-glb/run.sh` - Docker-first runner.
- `spikes/occt-xcaf-glb/README.md` - short usage notes.

## Build and run

From the repo root:

```bash
./spikes/occt-xcaf-glb/run.sh /path/to/input.stp /tmp/u843-xcaf-glb-output balanced --colour-mode xcaf-baseline
```

The output directory receives:

```text
display.glb
xcaf-report.json
conversion.log
```

In the worker path, the wrapper also writes compatibility files expected by the
server:

```text
stats.json
material-debug.json
manifest.json
```

The runner builds `occt-xcaf-glb-spike:local` with Docker when Docker is
available. If Docker is unavailable, it falls back to a local CMake build and
expects OpenCascade development packages to already be installed.

The current evidence-based baseline mode is:

```bash
--colour-mode xcaf-baseline --colour-space raw
```

This keeps the native OpenCascade/XCAF backend direction, v3/v4 transform
handling, lightweight grouped GLB export, valid GLB output, and object
metadata/extras. It disables the experimental active colour paths that produced
unreliable visual results: raw STEP styled-item material assignment,
sRGB-to-linear conversion as a default, layer-colour material assignment, broad
representation graph colour application, material rules, layer/name guessing,
and U843-specific fallback logic.

The production resolver for STEP presentation styles is:

```bash
--colour-mode step-presentation --colour-space raw
```

In the worker this is selected with:

```bash
CONVERTER_BACKEND=xcaf-baseline
XCAF_COLOUR_MODE=step-presentation
```

This mode still uses XCAF for hierarchy, transforms, and topology traversal.
Direct XCAF colours stay higher priority. When XCAF does not promote a colour
onto the exported object, the converter maps explicit STEP `STYLED_ITEM`
presentation colours to the matching exported topology. Compound objects are not
painted as a whole when the STEP representation contains multiple styled BREP
members; the exporter splits the GLB node/material buckets by the matching
styled BREP or shell target and records `geometrySource=compound split by styled
BREP`.

For a real upload-path verification, upload a STEP/STP through `/admin`, then
confirm:

- worker logs contain `Converter backend: xcaf-baseline`
- `data/logs/<slug>/conversion.log` contains `Converter backend: xcaf-baseline`
- `/3dviewer/<slug>` loads
- `/downloads/<slug>/original` returns the source file
- `/downloads/<slug>/display.glb` returns the generated GLB
- `/admin/models/<slug>/xcaf-report.json` is available to authenticated admin

## EliteDesk U843 run

The real U843 test file currently lives on the EliteDesk at:

```bash
/home/claudio/projects/3d-model-web-viewer/data/uploads/u843-non-haz-panel-20260615065620/original.stp
```

The safe spike command is:

```bash
cd /home/claudio/projects/3d-model-web-viewer
./spikes/occt-xcaf-glb/run.sh \
  /home/claudio/projects/3d-model-web-viewer/data/uploads/u843-non-haz-panel-20260615065620/original.stp \
  /tmp/u843-xcaf-baseline-output \
  balanced \
  --colour-mode xcaf-baseline
```

Keep U843 outputs under `/tmp` or another ignored path. Do not commit uploaded
STEP files, generated GLBs, reports, logs, SQLite databases, `.env`, secrets, or
`data/`.

## Metadata preservation

The GLB writer creates one renderable node per component/material bucket. Faces
inside a bucket still duplicate triangle vertices and use flat normals, so hard
CAD edges and flat panels are preserved without requiring one GLB node per face.
Each node has a meaningful name when XCAF exposes one and includes `extras`
fields intended for future click selection:

- `stableObjectId`
- `labelPath`
- `instancePath`
- `displayName`
- `layer`
- `colourSource`
- `materialSource`
- `colourLookupPath`
- `colourType`
- `fallbackReason`
- `geometrySource`
- `originalStepLabel`
- `transformSource`
- `faceCount`

The JSON sidecar also includes summary counts for free shapes, processed
labels/components, named objects, coloured objects, layers, unique colours,
primitive count, vertex count, triangle count, GLB size, conversion time,
skipped shapes, and failed shapes. It also groups default-grey primitives by
label path, display name, layer, parent label, shape type, ancestor-colour
availability, and face/subshape-colour availability, with a top-20 list of the
default-heavy labels/components.

The sidecar now includes a geometry sanity section:

- `globalBoundingBox`
- per-object bounding boxes
- per-object triangle and face counts
- `topObjectsByTriangleCount`
- `topObjectsByBoundingBoxSize`
- compact `transformSamples` with label path, instance path, local transform,
  accumulated transform, original/referred label, and transform source

`labelPath` remains the raw XCAF label path. `instancePath` records the assembly
instance chain so repeated references get unique `stableObjectId` values without
losing the source label for debugging.

## Colour extraction

`--colour-mode xcaf-baseline` uses direct OpenCascade/XCAF colour metadata only.
Material rules are not used. Name, layer-name, and component-name guessing are
not used. Raw STEP styled-item colours are parsed for diagnostics only and do
not become GLB material assignment. Layer membership is preserved as metadata,
but layer colours do not become materials in baseline mode.

Baseline colour priority is:

1. Exact face/subshape surface colour from XCAF.
2. Exact face/subshape generic colour from XCAF.
3. Owning solid/body label colour from XCAF, if explicitly set.
4. Referred/original label colour from XCAF, if explicitly set and tied to that
   topology.
5. Instance/component label colour from XCAF, if explicitly set.
6. Explicit inherited ancestor colour, only when passed through a real coloured
   parent label.
7. Neutral grey fallback.

The legacy `--colour-mode experimental` path still exists for comparison. It
keeps the v8 strong-only raw STEP style application and layer-colour material
assignment behaviour, but that path is not the clean baseline.

`--colour-mode step-presentation` is the proper STEP presentation-style
resolver. It parses the explicit `COLOUR_RGB` to presentation-style to
`STYLED_ITEM` chain and maps `MANIFOLD_SOLID_BREP` or
`SHELL_BASED_SURFACE_MODEL` targets to the corresponding exported topology.
This is topology-based evidence, not layer-name or object-name inference. A
single exact styled target can colour the matching exported shape after direct
XCAF colours are checked. Multiple styled targets under one compound must map to
the same number of exported solid/shell groups; otherwise they remain
diagnostic-only with a rejection reason in `xcaf-report.json`.
STEP presentation RGB values are normalized to the same linear material values
OpenCascade exposes through XCAF, so files like `test 1` and `test 2` write the
same green GLB material when they carry the same intended STEP display colour.

Reports for STEP-presentation output include:

- `colourSource=step_presentation_styled_item`
- `materialSource=step_presentation_styled_item`
- `rawStepStyledItemId`
- `rawStepTargetId`
- `rawStepTargetType`
- `rawStepTargetScope`
- `rawStepTargetPath`
- `geometrySource`

The v4 colour fix separates metadata lookup topology from render topology. XCAF
colour associations are resolved on the original/unmoved shape and face labels,
while GLB vertices are emitted from the shape after the accumulated assembly
instance transform is applied. This matters for repeated assembly components:
moving a referred shape before colour lookup can change the face/location
identity enough that referred subshape colours no longer match, so one sibling
keeps the intended colour while another falls back to neutral grey.

The important v2 improvement is step 4: assembly instances can reference a
compound with no direct colour while its child solids have the actual XCAF
surface colour and layer metadata. The exporter now collects those coloured
subshape labels from both the instance label and the referred/original label,
then propagates a solid/shell/subshape colour down to every tessellated face it
contains. This preserves the face primitive layout and triangle count while
applying the more specific XCAF metadata.

Neutral grey fallback is used for uncoloured geometry instead of guessed
red/blue/green/white materials.

`colourSource` keeps the exact lookup that won, such as
`referred_subshape_label_surface`. `materialSource` groups results into broader
report buckets: `face/subshape`, `label`, `referred label`, `ancestor`, `layer`,
or `default`.

`xcaf-report.json` also includes compact colour diagnostics for repeated
components. `repeatedComponentColourMismatches` groups repeated primitives by
display name, referred/original label, layer, face count, and triangle count,
then flags groups where siblings have different final colours or a mix of
default grey and coloured materials. `diagnosticNameMatches` adds colour lookup
traces for valve-like names such as `VALVE`, `DIAPHRAGM`, `K30`, `VCR`,
`GAUGE`, `REGULATOR`, `FITTING`, `TUBE`, `PIPE`, and `SUPPORT`.

The v5 diagnostics add a more explicit `siblingColourComparison` section and
per-object layer/style fields:

- `labelRole`
- `parentChain`
- `instanceLabelLayers`
- `referredLabelLayers`
- `ancestorLayers`
- `matchedSubshapeLayers`
- `candidateColours`
- `exactColourLookupPath`

This makes the Rhino block/layer question inspectable without hard-coding the
U843 model. For this STEP, repeated fittings that now colour consistently get
their real colour from referred/original product labels such as
`referred_label_surface`; their layer membership is usually exposed as a layer
name such as `FITTINGS`, but OpenCascade 7.6.3 does not expose an actual layer
colour value for those layer labels through the XCAF colour tool. Subshape
labels can expose both layer membership and surface colours, for example the
`ITEMS` layer on a matched referred subshape.

The remaining default-grey objects have no XCAF face/subshape colour, owning
label colour, referred/original label colour, inherited ancestor colour, or
explicit layer colour exposed by the current OpenCascade/XCAF path. Rhino may be
using its own imported layer table/presentation-style interpretation to render
those objects by layer colour, but this prototype does not infer colours from
layer names and does not yet read a separate Rhino layer-colour table from the
STEP transfer.

The v6 spike added a raw STEP presentation-style resolver. It shallow-parses STEP
entity records, resolves explicit `COLOUR_RGB` -> presentation style ->
`STYLED_ITEM` chains, and then walks named shape-representation graphs to BREP
or topology items targeted by those styled items. The resolver feeds only those
explicit raw `STYLED_ITEM` colours into the GLB exporter, after direct XCAF
face/subshape/label/referred-label colours and before inherited ancestor/default
grey fallback. It does not use layer names, component names, or hard-coded colour
tables as material rules.

That active raw-style application is disabled in `xcaf-baseline`. The resolver
remains useful as an inspector because it can show whether the STEP file carries
colours outside the direct XCAF label/subshape path, but v6/v7/v8 visual testing
showed that applying those colours through the current representation matching
can still produce wrong saturated or missing colours.

The v7 spike adds configurable colour-space handling and stricter raw STEP style
confidence. `--colour-space raw` preserves v6 behaviour and writes XCAF/STEP RGB
values directly to glTF `baseColorFactor`. `--colour-space srgb-to-linear`
treats XCAF/STEP RGB values as display/sRGB values and converts them to linear
values before writing GLB materials. This matters for dark display colours such
as STEP green `0.0, 0.14902, 0.0` and blue `0.0, 0.0, 0.172549`: writing them
directly as linear factors can make the browser render them much brighter and
more saturated than Rhino-like display values.

Visual inspection of v7-linear showed the opposite failure mode for U843: the
converted model was too dark and still not Rhino-like. The v8 spike therefore
keeps raw/display RGB as the default material-factor policy and leaves
`--colour-space srgb-to-linear` as an explicit future experiment only.

Raw STEP styles now carry a mapping confidence. The exporter applies raw style
colours only when the style is traced through a named shape representation to an
exact BREP/topology target, for example `exact manifold solid BREP`. Weak or
name-only matches are reportable diagnostics but do not override XCAF colours.

The v8 spike tightens that further with a strong-only scope rule. A raw style is
not applied just because a named representation contains some exact styled BREP
target. The representation must resolve to exactly one strong BREP/topology
target for that exported component. Representation-level targets, weak/name-only
matches, and ambiguous representations with multiple strong styled targets are
left as audit entries instead of recolouring the whole component bucket. This
avoids the v6/v7 risk where a precise STEP style target could still be applied
too broadly after the exporter matched it by representation/component name.

`xcaf-report.json` now includes:

- `colourMode` - whether active material assignment is clean XCAF baseline or
  the old experimental raw-style path.
- `colourSpace` - whether GLB material values were converted.
- `finalGlbColourAudit` - every unique GLB material colour, RGB written to GLB,
  hex, source buckets, and primitive/face/triangle counts.
- `rawStepColourAudit` - every raw STEP `COLOUR_RGB`, hex if interpreted as
  sRGB, linear-converted values, referencing `STYLED_ITEM` ids, and mapped
  object names.
- `rawStepStyleResolver.mappingConfidenceCounts` - counts of applied raw style
  mappings by confidence.
- `rawStepDerivedComponents` - compact component list for raw-derived final
  colours, including style id, target type/scope/path, confidence, face count,
  and triangle count.
- `componentsStayedDefaultGrey` - compact list of components still using the
  neutral default, including any raw-style rejection reason.
- `simpleVsAssemblyColourComparison` - a placeholder in single-input reports,
  replaced by `compare_simple_assembly.py` after the simple and full-assembly
  baseline reports are both available.
- `colourChangeAudit` - appended by `compare_reports.py` when v4/v5/v6/v7
  reports are available, focused on objects whose colour/source changed across
  the versioned test outputs.

## Tessellation

The prototype uses `BRepMesh_IncrementalMesh`.

`preview`:

- Linear deflection: `0.85`
- Angular deflection: `0.65`
- Relative mode: `true`

`balanced`:

- Linear deflection: `0.45`
- Angular deflection: `0.50`
- Relative mode: `true`

`high`:

- Linear deflection: `0.12`
- Angular deflection: `0.22`
- Relative mode: `true`

The GLB writer duplicates vertices per triangle and writes flat normals. This is
deliberate for the spike: planar panels stay flat and hard CAD edges remain
sharp. Curved fittings render with the OpenCascade tessellation density selected
by the quality preset, but normals are not smoothed across triangles yet.

## Transform and location handling

The prototype uses the `TopLoc_Location` returned by each component shape and
the per-face triangulation location returned from `BRep_Tool::Triangulation`.

The v3 fix addresses referenced assembly instances. When an XCAF component is a
reference to an assembly definition, traversal must walk the referred children,
but those children do not automatically carry the referencing component's
instance location. The traversal now accumulates that reference location and
applies it with `TopoDS_Shape::Moved()` before tessellation. This preserves each
child component's own shape location while adding the missing parent instance
transform.

The v4 implementation keeps that transform handling but applies it only to the
render shape. Colour lookup continues to use the untransformed source shape so
OpenCascade can still match colours attached to referred/original faces,
subshapes, solids, or labels.

The report records:

- `localTransform`: the shape location exposed on the leaf label.
- `accumulatedTransform`: the final shape location after any referred assembly
  instance transform is applied.
- `transformSource`: `label_shape_location` for direct labels or
  `referred_assembly_instance` when a parent reference transform was propagated.

This is intentionally still a flattened GLB hierarchy. It is a correctness
prototype, not the final assembly-tree writer.

## Size and performance

v2 wrote one node/mesh/primitive per tessellated face. That preserved colour
identity but produced more than 22,000 GLB primitives on U843 and a 110 MB file.

v3 and v4 group geometry by selectable component instance plus
material/colour/layer.
It does not merge the whole model into one mesh, so later click-selection can
still operate at a useful component level. It also avoids smoothing across hard
CAD edges by continuing to duplicate triangle vertices inside each grouped mesh.

The grouping key intentionally preserves instance identity through
`instancePath`/`stableObjectId`; repeated components with different final
materials are exported as separate component/material buckets and cannot inherit
the first sibling's material by accident.

Latest U843 comparison:

| Metric | v2 high | v3 balanced | v4 balanced | v5 balanced | v6 balanced | v7 raw balanced | v7 linear balanced |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Colour-space mode | raw | raw | raw | raw | raw | raw | sRGB-to-linear |
| Coloured primitives | 20,185 | 147 | 159 | 159 | 172 | 172 | 172 |
| Raw STEP styled-item primitive buckets | 0 | 0 | 0 | 0 | 13 | 13 | 13 |
| Raw STEP styled-item face uses | 0 | 0 | 0 | 0 | 1,821 | 1,821 | 1,821 |
| Raw STEP confidence | n/a | n/a | n/a | n/a | unreported | exact manifold solid BREP | exact manifold solid BREP |
| Default grey primitives | 1,839 | 26 | 14 | 14 | 1 | 1 | 1 |
| Default grey face uses | not reported | 17,652 | 1,839 | 1,839 | 18 | 18 | 18 |
| Unique colours | 6 | 6 | 6 | 6 | 9 | 9 | 9 |
| Node count | not reported | 173 | 173 | 173 | 173 | 173 | 173 |
| Primitive count | 22,024 | 173 | 173 | 173 | 173 | 173 | 173 |
| Vertices | 3,162,696 | 1,152,630 | 1,152,630 | 1,152,630 | 1,152,630 | 1,152,630 | 1,152,630 |
| Triangles | 1,054,232 | 384,210 | 384,210 | 384,210 | 384,210 | 384,210 | 384,210 |
| GLB size | 110,412,276 bytes | 32,478,256 bytes | 32,477,752 bytes | 32,507,932 bytes | 32,509,484 bytes | 32,533,468 bytes | 32,533,476 bytes |
| Repeated component colour mismatches | not reported | not reported | 0 | 0 | 0 | 0 | 0 |
| Layer colour values exposed | not reported | not reported | not reported | no | no | no | no |
| Conversion time | 73.58s | 97.38s | 71.95s | 71.97s | 76.98s | 79.21s | 77.29s |

The next comparison target is the baseline output, not another layered raw-style
variant. Baseline should be generated as fresh admin-visible models without
overwriting v6/v7/v8 outputs.

The v5 GLB passed a direct GLB structural readback with 173 meshes, 173 nodes,
six materials, 519 accessors, and a valid JSON/BIN chunk layout. The existing JS
validator could not be run on the EliteDesk shell during this pass because `npm`
was not available in `PATH`.

The v6 GLB passed direct GLB v2 readback with two chunks, 173 meshes, 173 nodes,
nine materials, 519 accessors, and 384,210 triangles. It is registered on the
EliteDesk as the temporary admin-visible model `u843-xcaf-v6-display` for visual
inspection before production converter integration.

The v7 raw and linear GLBs both passed direct GLB v2 readback with two chunks,
173 meshes, 173 nodes, nine materials, 519 accessors, and 384,210 triangles.
They are registered on the EliteDesk as `u843-xcaf-v7-raw-display` and
`u843-xcaf-v7-linear-display`. Compare the linear variant first when checking
the v6 bright blue/green issue, because it is the variant that converts STEP
display RGB into glTF linear material factors.

## Current limitations

- The GLB output currently flattens hierarchy into renderable component/material
  nodes. Label paths, instance paths, and stable IDs are preserved in `extras`,
  but the original assembly tree is not fully recreated as nested GLB nodes.
- The U843 metadata-only XCAF spike sees richer document-level colour/name data
  than the first renderable GLB mapping applied. The v2 prototype bridges the
  largest gap by propagating coloured referred subshape/solid labels to their
  tessellated faces, and v4 keeps lookup on source topology for transformed
  repeated instances. Some components may still have no matching face/subshape,
  label, referred-label, ancestor, or layer colour in OpenCascade 7.6.3.
- The GLB still duplicates triangle vertices to preserve hard CAD normals, so it
  remains larger than an optimized indexed/smoothed mesh would be.
- OpenCascade 7.6.3 exposes layer membership reliably for this sample, but layer
  label colours are not always available through `XCAFDoc_ColorTool`; the
  exporter uses layer colour only when OCCT exposes an explicit colour. In the
  v5 U843 run, layer names were available but explicit layer colour values were
  not.
- The current spike keeps flat normals for all triangles. That preserves hard
  CAD edges and flat panels, but curved fittings would benefit from a later
  normal-generation pass that smooths within curved faces only.
- No production integration exists yet. `CONVERTER_BACKEND=occt-xcaf` should
  wait until colour coverage and hierarchy mapping are stronger.

## Before production integration

Recommended next work:

- Visually inspect `/tmp/u843-xcaf-baseline-output/display.glb` in the web
  viewer and compare against Rhino or the source CAD colours.
- Use `xcaf-report.json` `globalBoundingBox`, `topObjectsByBoundingBoxSize`, and
  `transformSamples` to investigate any remaining misplaced components.
- Use `siblingColourComparison` and per-object `candidateColours` to inspect any
  visually wrong repeated block instances.
- Use `simpleVsAssemblyColourComparison`, appended by
  `spikes/occt-xcaf-glb/compare_simple_assembly.py`, to compare a standalone
  object report with a full-assembly report.
- Investigate the remaining default-heavy labels in `topDefaultHeavyLabels`,
  especially components that appear genuinely uncoloured in XCAF versus labels
  whose colours are still attached through a path the prototype does not follow.
- Investigate whether a STEP presentation/layer style table is available through
  lower-level OpenCascade STEP model entities when XCAF exposes only layer names.
- Consider optional user-supplied layer-colour mapping only as an explicit
  fallback, not as an automatic inference from U843 layer names.
- Preserve a useful nested assembly hierarchy while keeping selectable component
  instances.
- Add optional smooth normals for curved faces without smoothing across hard CAD
  edges.
- Add automated GLB readback validation to the spike runner itself.
- Visually inspect the `xcaf-baseline` outputs first. If the standalone object
  is green/correct but the matching full-assembly object is white/grey, use
  `simpleVsAssemblyColourComparison` plus per-object `candidateColours` to
  determine whether the same colour exists on the referred/original label,
  instance label, subshape label, layer membership, or only raw STEP style data.
- Investigate a topology-aware bridge from raw STEP styled items to exact XCAF
  subshapes only after the baseline evidence proves the direct XCAF lookup gap.
- Add backend selection behind `CONVERTER_BACKEND=occt-xcaf` only after U843
  visual inspection proves colour and selection quality are better than the
  current `occt-import-js` output.
