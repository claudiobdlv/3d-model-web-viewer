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
./spikes/occt-xcaf-glb/run.sh /path/to/input.stp /tmp/u843-xcaf-glb-output high
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
  /tmp/u843-xcaf-glb-output \
  high
```

Keep U843 outputs under `/tmp` or another ignored path. Do not commit uploaded
STEP files, generated GLBs, reports, logs, SQLite databases, `.env`, secrets, or
`data/`.

## Metadata preservation

The GLB writer creates one renderable node per tessellated face. Each node has a
meaningful name when XCAF exposes one and includes `extras` fields intended for
future click selection:

- `stableObjectId`
- `labelPath`
- `displayName`
- `layer`
- `colourSource`
- `originalStepLabel`

The JSON sidecar also includes summary counts for free shapes, processed
labels/components, named objects, coloured objects, layers, unique colours,
primitive count, vertex count, triangle count, GLB size, conversion time,
skipped shapes, and failed shapes.

## Colour extraction

The prototype uses XCAF colour tools only. Material rules are not used. Colour
priority is:

1. Face surface colour.
2. Face generic colour.
3. Face curve colour.
4. Label surface colour.
5. Label generic colour.
6. Label curve colour.
7. Referred-label surface colour.
8. Referred-label generic colour.
9. Referred-label curve colour.
10. Neutral grey fallback.

Neutral grey fallback is used for uncoloured geometry instead of guessed
red/blue/green/white materials.

## Tessellation

The prototype uses `BRepMesh_IncrementalMesh`.

`balanced`:

- Linear deflection: `0.35`
- Angular deflection: `0.45`
- Relative mode: `true`

`high`:

- Linear deflection: `0.12`
- Angular deflection: `0.22`
- Relative mode: `true`

The GLB writer duplicates vertices per triangle and writes flat normals. This is
deliberate for the spike: planar panels stay flat and hard CAD edges remain
sharp. Curved fittings render with the OpenCascade tessellation density selected
by the quality preset, but normals are not smoothed across triangles yet.

## Current limitations

- The GLB output currently flattens hierarchy into renderable face nodes. Label
  paths and stable IDs are preserved in `extras`, but the original assembly tree
  is not fully recreated as nested GLB nodes.
- The U843 metadata-only XCAF spike sees richer document-level colour/name data
  than this first renderable GLB mapping currently applies. This prototype maps
  colours that can be directly associated with tessellated shape labels/faces,
  but more work is needed to bridge all XCAF subshape/document colour labels to
  the final face primitives.
- The GLB is intentionally verbose because each face is a separate node/mesh to
  preserve object identity and sharp normals. A production backend should merge
  primitives by object/material where doing so does not lose selection metadata.
- No production integration exists yet. `CONVERTER_BACKEND=occt-xcaf` should
  wait until colour coverage and hierarchy mapping are stronger.

## Before production integration

Recommended next work:

- Reconcile the metadata-only XCAF label scan with the renderable tessellation
  traversal so more of the known coloured labels reach GLB primitives.
- Preserve a useful nested assembly hierarchy while keeping selectable leaf
  parts.
- Add optional smooth normals for curved faces without smoothing across hard CAD
  edges.
- Add automated GLB readback validation to the spike runner.
- Add backend selection behind `CONVERTER_BACKEND=occt-xcaf` only after U843
  visual inspection proves colour and selection quality are better than the
  current `occt-import-js` output.
