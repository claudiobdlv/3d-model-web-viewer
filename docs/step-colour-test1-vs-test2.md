# STEP colour comparison: test 1 vs test 2

Date: 2026-06-16

This note compares the two live EliteDesk uploads:

- `test 1`: `test-1-20260616075141`
- `test 2`: `test-2-20260616075207`

The goal was to explain why the real upload path converts `test 1` as default
grey while `test 2` receives the expected green material, without using
material, object-name, layer-name, or model-specific guessing.

## Runtime paths

Both uploads were processed by the real worker path with
`CONVERTER_BACKEND=xcaf-baseline`.

`test 1` input and outputs:

- Input STEP: `/home/claudio/projects/3d-model-web-viewer/data/uploads/test-1-20260616075141/original.stp`
- GLB: `/home/claudio/projects/3d-model-web-viewer/data/models/test-1-20260616075141/display.glb`
- Stats: `/home/claudio/projects/3d-model-web-viewer/data/models/test-1-20260616075141/stats.json`
- XCAF report: `/home/claudio/projects/3d-model-web-viewer/data/models/test-1-20260616075141/xcaf-report.json`
- Material debug: `/home/claudio/projects/3d-model-web-viewer/data/models/test-1-20260616075141/material-debug.json`
- Conversion log: `/home/claudio/projects/3d-model-web-viewer/data/logs/test-1-20260616075141/conversion.log`
- Worker output log: `/home/claudio/projects/3d-model-web-viewer/data/worker-output/test-1-20260616075141/conversion.log`

`test 2` input and outputs:

- Input STEP: `/home/claudio/projects/3d-model-web-viewer/data/uploads/test-2-20260616075207/original.stp`
- GLB: `/home/claudio/projects/3d-model-web-viewer/data/models/test-2-20260616075207/display.glb`
- Stats: `/home/claudio/projects/3d-model-web-viewer/data/models/test-2-20260616075207/stats.json`
- XCAF report: `/home/claudio/projects/3d-model-web-viewer/data/models/test-2-20260616075207/xcaf-report.json`
- Material debug: `/home/claudio/projects/3d-model-web-viewer/data/models/test-2-20260616075207/material-debug.json`
- Conversion log: `/home/claudio/projects/3d-model-web-viewer/data/logs/test-2-20260616075207/conversion.log`
- Worker output log: `/home/claudio/projects/3d-model-web-viewer/data/worker-output/test-2-20260616075207/conversion.log`

Fresh comparison reports were generated on the EliteDesk:

- `/tmp/test1-xcaf-compare/xcaf-report.json`
- `/tmp/test2-xcaf-compare/xcaf-report.json`
- `/tmp/test1-step-style-report.json`
- `/tmp/test2-step-style-report.json`
- `/tmp/test1-vs-test2-colour-diff.json`

The live worker used `quality=high`; the fresh `/tmp` comparison used
`balanced`. Triangle counts differ for that reason, but the colour-source
decision is the same.

## Side-by-side findings

| Field | test 1 | test 2 |
| --- | --- | --- |
| Runtime source file | `test 1.stp` | `test 2.stp` |
| Runtime source size | `384321` bytes | `456994` bytes |
| Runtime nodes / meshes | `1 / 1` | `2 / 2` |
| Runtime triangles | `9168` | `10264` |
| Runtime final material | `default_neutral_grey` | `owning_shape_surface` |
| Runtime material source | `default` | `label` |
| Runtime default-grey components | `1` | `0` |
| Runtime XCAF mode | `xcaf-baseline` | `xcaf-baseline` |
| Fresh XCAF labels processed | `2` | `4` |
| Fresh XCAF tessellated shapes | `1` | `2` |
| Fresh XCAF layers | none | `3D PRINTED`, `PIPE SUPPORTS` |
| Fresh XCAF colour source | `default_neutral_grey` | `owning_shape_surface` |
| Raw STEP `COLOUR_RGB` | `2`, both green `0,0.149019607843137,0` | `2`, both green `0,0.149019607843137,0` |
| Raw STEP `STYLED_ITEM` | `2` | `2` |
| Raw STEP presentation layers | `PIPE SUPPORTS`, `3D PRINTED` | `3D PRINTED`, `PIPE SUPPORTS` |
| Layer colour exposed through XCAF | no | no |

## Structural difference

Both files contain raw STEP green style data. In both files, the raw STEP
inspector found:

- `2` `COLOUR_RGB` entities
- `2` `STYLED_ITEM` entities
- `2` `PRESENTATION_STYLE_ASSIGNMENT` entities
- `2` `PRESENTATION_LAYER_ASSIGNMENT` entities
- green RGB values of `0.0, 0.149019607843137, 0.0`

The difference is where that style data lands after OpenCascade imports the file
into XCAF.

For `test 1`, the raw `STYLED_ITEM`s point at `MANIFOLD_SOLID_BREP` entities
`#34` and `#35` under an `ADVANCED_BREP_SHAPE_REPRESENTATION`. The raw STEP
presentation layers still exist and contain `PIPE SUPPORTS` and `3D PRINTED`,
but XCAF imports the model as a single compound object:

- label path `0:1:1:1:1`
- display name `3D PRINTED BRACKET + 3 x 1/2", 37mm OFFSET, TYPE A`
- shape type `COMPOUND`
- no XCAF layer names
- no owning-shape colour
- no referred-label colour
- no face/subshape colour
- no ancestor colour

The baseline converter therefore has no direct XCAF colour candidate and falls
back to `default_neutral_grey`.

For `test 2`, the raw style data is promoted differently. Its `STYLED_ITEM`s
target a `SHELL_BASED_SURFACE_MODEL` (`#38`) and a `MANIFOLD_SOLID_BREP`
(`#16`). XCAF imports this as two coloured component labels:

- `0:1:1:2:1`, shape type `SOLID`, referred layer `PIPE SUPPORTS`
- `0:1:1:2:2`, shape type `SHELL`, referred layer `3D PRINTED`

Both labels expose the green value through direct XCAF candidates:

- `owningShape=0.000000,0.019382,0.000000,1.000000`
- `referredLabel=0.000000,0.019382,0.000000,1.000000`
- colour source `owning_shape_surface`

That is why `test 2` becomes green in `xcaf-baseline`.

## Conclusion

This is primarily an XCAF direct-colour availability issue caused by a STEP
export structure difference.

`test 1` does contain raw STEP green colour and raw presentation layer
membership, but OpenCascade 7.6.3 does not expose that colour as direct XCAF
label, owning-shape, referred-label, face/subshape, ancestor, or layer colour in
the baseline path. The current baseline converter intentionally treats raw STEP
style data as diagnostic-only, so `test 1` is grey.

`test 2` contains similar raw STEP green style data, but OpenCascade also exposes
it through XCAF owning/referred shape surface colours on two component labels.
The baseline converter trusts that metadata, so `test 2` is green.

Layer membership alone is not enough here. `test 1` has raw presentation layers,
but XCAF reports no layers. `test 2` reports layer names through XCAF, but not
layer colours; its material comes from XCAF shape surface colour, not layer
colour.

## Recommended next step

Do not add layer-name or object-name rules.

The safest implementation path is a narrow raw STEP style fallback for otherwise
default-grey XCAF objects, gated by strong topology/representation evidence:

- only consider fallback when baseline XCAF found no direct colour candidate;
- trace from the XCAF object's STEP representation or BREP topology to nearby
  `STYLED_ITEM` targets;
- require an unambiguous raw colour candidate for the exact representation,
  BREP, shell, solid, or face set;
- record the STEP entity path, target type, styled item id, and confidence in
  `xcaf-report.json` and `material-debug.json`;
- keep broad representation matches diagnostic-only when multiple colours or
  multiple plausible targets are present.

This would allow files shaped like `test 1` to use genuine STEP presentation
style evidence without hard-coding colours, names, layers, or Rhino-specific
export behavior.
