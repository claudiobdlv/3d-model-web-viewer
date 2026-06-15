# Native OpenCascade/XCAF GLB prototype

## Purpose

This prototype builds the next converter backend candidate without replacing the
current production `occt-import-js` converter. It reads STEP/STP with native
OpenCascade XCAF, tessellates renderable CAD shapes, writes a GLB, and writes a
JSON sidecar report for colour/name/hierarchy inspection.

The implementation is isolated under `spikes/occt-xcaf-glb/`. It does not change
the production server, worker, converter, Docker Compose, Cloudflare, or any
EliteDesk services.

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
./spikes/occt-xcaf-glb/run.sh /path/to/input.stp /tmp/u843-xcaf-glb-output balanced
```

The output directory receives:

```text
display.glb
xcaf-report.json
conversion.log
```

The runner builds `occt-xcaf-glb-spike:local` with Docker when Docker is
available. If Docker is unavailable, it falls back to a local CMake build and
expects OpenCascade development packages to already be installed.

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
  /tmp/u843-xcaf-glb-output-v3 \
  balanced
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

The prototype uses XCAF colour tools only. Material rules are not used. Colour
priority is:

1. Face surface colour.
2. Face generic colour.
3. Face curve colour.
4. Coloured XCAF subshape/solid label surface colour containing the face.
5. Coloured XCAF subshape/solid label generic colour containing the face.
6. Coloured XCAF subshape/solid shape colour containing the face.
7. Owning label surface colour.
8. Owning label generic colour.
9. Owning label curve colour.
10. Owning shape surface/generic/curve colour.
11. Referred/original label surface colour for assembly references.
12. Referred/original label generic colour for assembly references.
13. Referred/original label curve colour for assembly references.
14. Nearest explicitly coloured ancestor label.
15. Layer label colour if OpenCascade exposes one for that layer.
16. Neutral grey fallback.

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

| Metric | v2 high | v3 balanced | v4 balanced |
| --- | ---: | ---: | ---: |
| Coloured primitives | 20,185 | 147 | 159 |
| Default grey primitives | 1,839 | 26 | 14 |
| Default grey face uses | not reported | 17,652 | 1,839 |
| Unique colours | 6 | 6 | 6 |
| Node count | not reported | 173 | 173 |
| Primitive count | 22,024 | 173 | 173 |
| Vertices | 3,162,696 | 1,152,630 | 1,152,630 |
| Triangles | 1,054,232 | 384,210 | 384,210 |
| GLB size | 110,412,276 bytes | 32,478,256 bytes | 32,477,752 bytes |
| Repeated component colour mismatches | not reported | not reported | 0 |
| Conversion time | 73.58s | 97.38s | 71.95s |

The v4 GLB passed readback validation with 173 meshes, 173 primitives, 173
nodes, 384,210 triangles, and no validator errors or warnings.

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
  exporter uses layer colour only when OCCT exposes an explicit colour.
- The current spike keeps flat normals for all triangles. That preserves hard
  CAD edges and flat panels, but curved fittings would benefit from a later
  normal-generation pass that smooths within curved faces only.
- No production integration exists yet. `CONVERTER_BACKEND=occt-xcaf` should
  wait until colour coverage and hierarchy mapping are stronger.

## Before production integration

Recommended next work:

- Visually inspect `/tmp/u843-xcaf-glb-output-v3/display.glb` in the web viewer
  and compare against Rhino or the source CAD colours.
- Use `xcaf-report.json` `globalBoundingBox`, `topObjectsByBoundingBoxSize`, and
  `transformSamples` to investigate any remaining misplaced components.
- Investigate the remaining default-heavy labels in `topDefaultHeavyLabels`,
  especially components that appear genuinely uncoloured in XCAF versus labels
  whose colours are still attached through a path the prototype does not follow.
- Preserve a useful nested assembly hierarchy while keeping selectable component
  instances.
- Add optional smooth normals for curved faces without smoothing across hard CAD
  edges.
- Add automated GLB readback validation to the spike runner itself.
- Add backend selection behind `CONVERTER_BACKEND=occt-xcaf` only after U843
  visual inspection proves colour and selection quality are better than the
  current `occt-import-js` output.
