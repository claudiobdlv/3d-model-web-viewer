# OpenCascade XCAF STEP to GLB prototype

This is an isolated native OpenCascade/XCAF prototype. It does not replace the
production `occt-import-js` converter and does not touch Docker Compose.

```bash
./spikes/occt-xcaf-glb/run.sh /path/to/input.stp /tmp/u843-xcaf-glb-output balanced --colour-mode xcaf-baseline
```

The output directory receives:

- `display.glb`
- `xcaf-report.json`
- `conversion.log`

Quality presets are `preview`, `balanced`, and `high`. `balanced` is the
web-friendly default for visual inspection; `high` keeps denser CAD tessellation
for closer review.

`--colour-mode xcaf-baseline` is the clean evidence-based mode. It keeps the
native XCAF reader, transform handling, lightweight component/material grouping,
metadata extras, raw RGB material factors, and readable reports. It disables raw
STEP styled-item colours as active material assignment, disables layer colours
as active material assignment, and does not use material rules, layer/name
guessing, U843-specific logic, or colour-space conversion by default.

`--colour-space raw` is the default and writes STEP/XCAF RGB values directly to
glTF material factors. `--colour-space srgb-to-linear` remains available for
experiments, but v7-linear was visually too dark on U843 and is not the v8
default.

`--colour-mode experimental` keeps the previous strong-only raw STEP style
application path for comparison. In baseline mode, raw STEP style parsing stays
available as report-only diagnostics and never paints the exported component.

After generating a simple-object report and a full-assembly report, append the
cross-report investigation section with:

```bash
python3 spikes/occt-xcaf-glb/compare_simple_assembly.py \
  --simple /tmp/test1-xcaf-baseline-output/xcaf-report.json \
  --assembly /tmp/u843-xcaf-baseline-output/xcaf-report.json \
  --simple-name-hint "test 1"
```

The runner uses Docker when available, otherwise it falls back to a local CMake
build with OpenCascade development packages already installed.

Validate naming invariants in a generated report with:

```bash
python3 spikes/occt-xcaf-glb/verify_name_regression.py /tmp/test1/xcaf-report.json \
  --expect-display 'COPPER TUBE - 1/2"' \
  --expect-display 'COPPER TUBE - 3"'

python3 spikes/occt-xcaf-glb/verify_name_regression.py /tmp/u843/xcaf-report.json \
  --layer-part-contains 'COPPER TUBE' \
  --minimum-layer-boundaries 80
```
