# OpenCascade XCAF STEP to GLB prototype

This is an isolated native OpenCascade/XCAF prototype. It does not replace the
production `occt-import-js` converter and does not touch Docker Compose.

```bash
./spikes/occt-xcaf-glb/run.sh /path/to/input.stp /tmp/u843-xcaf-glb-output balanced
```

The output directory receives:

- `display.glb`
- `xcaf-report.json`
- `conversion.log`

Quality presets are `preview`, `balanced`, and `high`. `balanced` is the
web-friendly default for visual inspection; `high` keeps denser CAD tessellation
for closer review.

`--colour-space raw` is the default and writes STEP/XCAF RGB values directly to
glTF material factors. `--colour-space srgb-to-linear` remains available for
experiments, but v7-linear was visually too dark on U843 and is not the v8
default.

Raw STEP style application is strong-only in v8. A raw `STYLED_ITEM` colour is
applied only when the matched named representation resolves to exactly one
strong BREP/topology target. Representation-level, weak, name-only, and
ambiguous multi-target matches are reported for debugging but not used to paint
the exported component.

The runner uses Docker when available, otherwise it falls back to a local CMake
build with OpenCascade development packages already installed.
