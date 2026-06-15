# Native OpenCascade XCAF STEP metadata spike

## Purpose

The current production converter uses `occt-import-js`, which is enough to turn
many STEP/STP files into mesh geometry but has shown weak colour fidelity on real
CAD assemblies. On the U843 panel test, the JavaScript importer exposed mesh
colours for only some meshes and did not expose usable face/node colour metadata
for the full model. Rhino reads the same file with correct colours, which
strongly suggests the STEP contains richer product metadata than the current
converter can access.

This spike tests that theory without replacing the production converter. It
builds a native OpenCascade/XCAF report tool that reads a STEP file and writes a
JSON metadata report. It does not emit GLB, touch the running app, change Docker
Compose, or alter deployment.

## Why XCAF

Basic STEP import focuses on turning shapes into geometry. XCAF/XDE adds the CAD
document model around those shapes: product labels, assembly references,
instance names, part names, colours, layers, and material metadata. Native
OpenCascade exposes this through `STEPCAFControl_Reader` and the XCAF document
tools:

- `XCAFDoc_ShapeTool` for free shapes, assemblies, components, references, and
  referred product labels.
- `XCAFDoc_ColorTool` for generic, surface, and curve colours.
- `XCAFDoc_LayerTool` for layer assignments.
- `XCAFDoc_MaterialTool` for material document support where the STEP reader
  populates it.

The spike enables name, colour, layer, and material modes before transfer, then
walks the assembly tree and labelled subshapes.

## Files

- `spikes/occt-xcaf-colour/src/main.cpp` - native C++ JSON reporter.
- `spikes/occt-xcaf-colour/CMakeLists.txt` - CMake build.
- `spikes/occt-xcaf-colour/Dockerfile` - isolated Ubuntu/OpenCascade build.
- `spikes/occt-xcaf-colour/run.sh` - convenience runner.

## Running locally

From the repo root:

```bash
./spikes/occt-xcaf-colour/run.sh /path/to/input.stp /tmp/xcaf-report.json
```

The script uses Docker when available:

1. Builds `occt-xcaf-colour-spike:local`.
2. Mounts the input directory read-only.
3. Mounts the report directory read/write.
4. Runs the native reporter inside the container.

If Docker is not available, it falls back to a local CMake build. The host then
needs OpenCascade development headers and libraries installed.

## Running on the EliteDesk

The known U843 test file is expected at:

```bash
/home/claudio/projects/3d-model-web-viewer/data/uploads/u843-non-haz-panel-20260615065620/original.stp
```

Use an output path outside the git repo:

```bash
cd /home/claudio/projects/3d-model-web-viewer
./spikes/occt-xcaf-colour/run.sh \
  /home/claudio/projects/3d-model-web-viewer/data/uploads/u843-non-haz-panel-20260615065620/original.stp \
  /tmp/u843-xcaf-report.json
```

Do not commit the STEP file, generated GLBs, JSON report, SQLite files, `.env`,
logs, or `data/`.

## Report shape

The JSON report includes:

- Input file path and OpenCascade version.
- Read and transfer status.
- Number of free shapes.
- Count of labels/components discovered.
- Summary counts for names, colours, colour source types, unique colours,
  layers, materials, unnamed labels, and uncoloured labels.
- An `assemblyTree` array with label path, display name, shape type, assembly
  flags, reference target, colour values, layers, material hints, and child
  count.

## How to interpret results

A promising result for a future `CONVERTER_BACKEND=occt-xcaf` is:

- XCAF sees many more coloured labels/subshapes than `occt-import-js`.
- Colours are attached to product, instance, surface, or subshape labels in a
  way that can be mapped to GLB primitive/material splits.
- XCAF sees useful names for parts, products, repeated components, or assembly
  instances.
- The assembly tree distinguishes repeated instances from referred part shapes.

A weak result is:

- XCAF sees roughly the same limited colours as `occt-import-js`.
- Names are missing or generic.
- No useful layer/material data appears.
- Colour assignments are present only at a level that cannot explain Rhino's
  display.

If XCAF reports the rich colour/name data Rhino sees, the next step is a native
converter backend that walks the XCAF document, meshes shapes with instance
context, and emits GLB with per-part/per-face primitive material splits.

If XCAF still cannot see the missing metadata, or sees it in a form that cannot
be mapped reliably, Rhino/Rhino.Compute becomes a stronger candidate converter
backend because Rhino has already proven it can interpret this file correctly.
