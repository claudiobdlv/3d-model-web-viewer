# STEP style colour investigation

This document records the raw STEP presentation/style investigation for the
native OpenCascade/XCAF GLB spike.

## Scope

- Production worker integration was not changed.
- No model data, generated GLBs, logs, SQLite databases, `.env` files, or
  uploaded STEP files are committed.
- The raw reports generated on the EliteDesk are runtime artifacts only:
  - `/tmp/u843-step-style-report.json`
  - `/tmp/u843-style-xcaf-crossref.json`
  - `/tmp/u843-xcaf-glb-output-occt79/xcaf-report.json`

## How STEP stores presentation colours

The U843 STEP file uses the normal presentation chain:

```text
COLOUR_RGB
  <- FILL_AREA_STYLE_COLOUR
  <- FILL_AREA_STYLE
  <- SURFACE_STYLE_FILL_AREA
  <- SURFACE_SIDE_STYLE
  <- SURFACE_STYLE_USAGE
  <- PRESENTATION_STYLE_ASSIGNMENT
  <- STYLED_ITEM
```

The `STYLED_ITEM` usually targets a representation item such as a
`MANIFOLD_SOLID_BREP`. Separately, named products and shape representations can
point to an `ADVANCED_BREP_SHAPE_REPRESENTATION`, which then lists the BREP
items. A general resolver therefore needs both paths:

- colour/style chain to `STYLED_ITEM`
- named representation/component chain to the styled representation items

Presentation layers are stored with `PRESENTATION_LAYER_ASSIGNMENT`; those
assignments contain names and member entity ids. In this file they do not carry
independent colour values.

## U843 raw STEP contents

The raw scan parsed 672843 STEP entities. Colour/style/layer counts:

| Entity type | Count |
| --- | ---: |
| `STYLED_ITEM` | 725 |
| `PRESENTATION_STYLE_ASSIGNMENT` | 725 |
| `SURFACE_STYLE_USAGE` | 350 |
| `SURFACE_SIDE_STYLE` | 350 |
| `SURFACE_STYLE_FILL_AREA` | 350 |
| `FILL_AREA_STYLE` | 350 |
| `FILL_AREA_STYLE_COLOUR` | 350 |
| `COLOUR_RGB` | 725 |
| `DRAUGHTING_PRE_DEFINED_COLOUR` | 0 |
| `PRESENTATION_LAYER_ASSIGNMENT` | 730 |
| `MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION` | 1 |

The 725 `COLOUR_RGB` entities collapse to six distinct RGB values:

| RGB | Count |
| --- | ---: |
| `1.0, 0.0, 1.0` | 358 |
| `0.0, 0.0, 0.172549` | 234 |
| `0.32549, 0.32549, 0.380392` | 56 |
| `0.309804, 0.0, 0.0` | 39 |
| `0.172549, 0.172549, 0.172549` | 25 |
| `0.0, 0.14902, 0.0` | 13 |

Layer findings:

- 730 `PRESENTATION_LAYER_ASSIGNMENT` entities exist.
- Layer names include values such as `FIXINGS`, `316L SS TUBE`, `LASER
  ETCHING`, and `ITEMS`.
- The inspector did not find layer-owned colour/style entities.
- This matches XCAF v5: `layerColoursAvailable: false`.

## XCAF v5 versus raw STEP

The v5 XCAF report, using OpenCascade 7.6.3, sees:

- 173 exported primitives
- 6 unique colours
- 14 default-neutral-grey primitive groups
- `layerColourAvailability.layerNamesAvailable: true`
- `layerColourAvailability.layerColoursAvailable: false`

The raw STEP report shows that the STEP file contains presentation colours
beyond what the current XCAF lookup path maps onto all final GLB objects. The
strongest example is the default-grey Festo regulator group:

```text
XCAF grey object:
  label 0:1:1:1:65
  FESTO REGULATOR, MS4-LR-1_4-D7-VS-DM1 + 1/4" G THREAD

Raw STEP path:
  #273523 SHAPE_REPRESENTATION
  -> #281009 AXIS2_PLACEMENT_3D
  -> #9335 ADVANCED_BREP_SHAPE_REPRESENTATION
  -> #9050/#9051 MANIFOLD_SOLID_BREP
  -> #7728/#7729 STYLED_ITEM
  -> #4527/#4528 COLOUR_RGB
```

The cross-reference report found:

- 14 XCAF default-grey groups.
- 13 groups with raw STEP candidates.
- 13 groups with raw colour candidates reachable through representation/BREP to
  `STYLED_ITEM` paths.
- The remaining unmatched group is `0:1:1:1:172 =>[0:1:1:122]`, which has no
  useful display name or layer in the XCAF report for text/representation
  correlation.

This explains why Rhino can colour the file correctly: it is likely resolving
presentation styles at the raw STEP representation-item level, then carrying
those styles through the component/representation graph. Our XCAF GLB spike is
already reading many colours, but it misses styles that are attached to BREP
items behind a block/component representation boundary.

## OpenCascade version experiment

The current v5 spike uses OpenCascade 7.6.3 from Ubuntu 24.04 packages.

Package availability checked on the EliteDesk:

- Ubuntu 24.04: `libocct-*-dev` candidate `7.6.3+dfsg1-7.1build1`
- Debian trixie: `7.8.1+dfsg1-3`
- Ubuntu 26.04: `7.9.2+dfsg-4`

The XCAF GLB spike was built and run in a temporary Ubuntu 26.04 container with
OCCT 7.9.2. The 7.9 packages rename the STEP link libraries from the older
`TKSTEP*` / `TKXDESTEP` set to `TKDESTEP` / `TKDE`, so the temporary build used
that adjusted link list.

Comparison:

| Metric | OCCT 7.6.3 v5 | OCCT 7.9.2 temp |
| --- | ---: | ---: |
| Exported primitives | 173 | 173 |
| Unique colours | 6 | 6 |
| Default grey groups | 14 | 14 |
| Default material uses | 1839 | 1839 |
| Layer colour candidates | 0 | 0 |
| `layerColoursAvailable` | false | false |
| Triangles | 384210 | 384082 |

The newer OCCT package did not expose the missing colours through the current
XCAF lookup path. It was faster on this run and tessellated a few faces
slightly differently, but the colour metadata result was effectively unchanged.

## Recommended implementation path

Implement a general raw STEP presentation-style resolver and feed its findings
into the XCAF GLB exporter.

The resolver should:

1. Parse STEP entity records shallowly and build a reference graph.
2. Resolve colour chains from `COLOUR_RGB` to `STYLED_ITEM`.
3. Map `STYLED_ITEM` targets to representation items such as
   `MANIFOLD_SOLID_BREP`, shell, face, or curve items.
4. Cross-reference XCAF labels/components to raw STEP named
   `SHAPE_REPRESENTATION` and representation relationships.
5. Walk from matched representations to BREP items and apply the most specific
   raw presentation colour available.
6. Preserve existing XCAF colour priority where XCAF already exposes a face,
   subshape, label, referred-label, or ancestor colour.
7. Use layer names only as metadata/correlation hints unless a STEP layer has
   an explicit colour/style entity.

An OpenCascade upgrade is still useful later for maintenance and performance,
but it is not the fix for this colour gap by itself. A user-supplied layer
colour sidecar is not the primary fix here because the STEP contains explicit
presentation colours; the layers appear to have names but not colour values.

## v6 implementation result

The native XCAF GLB spike now includes a first-pass raw STEP presentation-style
resolver. It parses STEP entity records in C++, maps explicit `COLOUR_RGB`
presentation-style chains to `STYLED_ITEM` targets, and walks named
shape-representation graphs to BREP/topology items targeted by those styled
items. The GLB exporter applies those raw colours only after direct XCAF
face/subshape/label/referred-label colours and before inherited ancestor/default
grey fallback.

On the U843 balanced run, v6 applied `raw_step_styled_item` colour to 13
component/material buckets, reducing default-grey buckets from 14 to 1 and
default-grey face uses from 1,839 to 18. The output is available on the
EliteDesk as `/tmp/u843-xcaf-glb-output-v6/display.glb` and is registered in the
admin UI as `u843-xcaf-v6-display` for visual inspection.

## v7 colour-space and confidence result

The v6 resolver filled most missing grey geometry, but visual inspection showed
some newly recovered blue and green components as too bright/saturated compared
with Rhino. The likely cause is colour-space interpretation: STEP `COLOUR_RGB`
values are display-style RGB values, while glTF material `baseColorFactor`
values are consumed as linear factors. Writing dark display values directly as
linear factors makes them display brighter in a browser renderer.

The v7 spike adds:

- `--colour-space raw` - preserves v6 material behaviour.
- `--colour-space srgb-to-linear` - converts XCAF/STEP display RGB to linear
  values before writing GLB `baseColorFactor`.
- Raw STEP mapping confidence. Raw `STYLED_ITEM` colours are applied only when
  the mapping reaches an exact BREP/topology target through a named shape
  representation path. Weak/name-only matches are report diagnostics and do not
  override XCAF colours.
- Colour audit sections in `xcaf-report.json`:
  - `finalGlbColourAudit`
  - `rawStepColourAudit`
  - `rawStepStyleResolver.mappingConfidenceCounts`

The U843 v7 outputs are:

```text
/tmp/u843-xcaf-glb-output-v7-raw/display.glb
/tmp/u843-xcaf-glb-output-v7-linear/display.glb
```

Both variants preserve the same geometry: 173 nodes, 173 meshes/primitives,
519 accessors, and 384,210 triangles. The raw output is 32,533,468 bytes; the
linear output is 32,533,476 bytes. The BIN geometry chunk is identical. The
small size difference is JSON material/report metadata.

On the U843 run, all applied raw STEP style fills were traced with
`exact manifold solid BREP` confidence:

| Metric | v6 raw | v7 raw | v7 sRGB-to-linear |
| --- | ---: | ---: | ---: |
| Unique colours | 9 | 9 | 9 |
| Raw STEP styled-item primitive buckets | 13 | 13 | 13 |
| Raw STEP styled-item face uses | 1,821 | 1,821 | 1,821 |
| Default grey primitives | 1 | 1 | 1 |
| Default grey face uses | 18 | 18 | 18 |
| Raw mapping confidence | unreported | exact manifold solid BREP | exact manifold solid BREP |

Examples from `finalGlbColourAudit`:

| Source RGB | v7 raw GLB factor | v7 linear GLB factor | Source |
| --- | --- | --- | --- |
| `0.0, 0.14902, 0.0` | `0.0, 0.14902, 0.0` | `0.0, 0.019382, 0.0` | raw STEP styled item |
| `0.0, 0.0, 0.172549` | `0.0, 0.0, 0.172549` | `0.0, 0.0, 0.025187` | raw STEP styled item |
| `0.32549, 0.32549, 0.380392` | `0.32549, 0.32549, 0.380392` | `0.0865, 0.0865, 0.119538` | raw STEP styled item |

This supports the colour-space hypothesis for the bright blue/green issue. It
does not show evidence that v6 applied raw STEP styles through an over-broad
weak/name-only match for the U843 fills now used by v7; the v7 applied mappings
all resolved to exact manifold solid BREP targets. Visual Rhino comparison is
still required before making `srgb-to-linear` the production default.

## v8 scoped raw-style result

Visual comparison of v7-linear showed that sRGB-to-linear conversion made the
model too dark and still did not make the result Rhino-like. v8 therefore keeps
raw/display RGB as the default GLB material-factor policy. The
`--colour-space srgb-to-linear` option remains available, but it is not the v8
default.

The more likely failure mode is raw STEP style scope. v6/v7 could correctly find
an exact `MANIFOLD_SOLID_BREP` styled target, then still apply that style too
broadly because the final exporter matched the style back to an exported
component by named representation. If a representation contains multiple styled
BREP/topology items, applying the first resolved style to the whole component
bucket can recolour unrelated-looking solids.

v8 makes raw style application strong-only:

1. Direct XCAF face/subshape/label/referred colours still win over raw STEP
   styles.
2. Representation-level, weak, and name-only raw style matches are report-only.
3. A raw style can fill a missing colour only when the matched named
   representation resolves to exactly one strong BREP/topology target.
4. Ambiguous representations with multiple strong styled targets are rejected
   and reported instead of painting a whole component with one target colour.

The report now includes `rawStepDerivedComponents`, `componentsStayedDefaultGrey`,
raw-style rejection counts, and, when `compare_reports.py` is run against the
versioned outputs, a `colourChangeAudit` section comparing v4/v5/v6/v7/v8 object
colour/source assignments.

## Tools added

`spikes/step-style-inspector/step_style_inspector.py` generates the raw report
and optional XCAF cross-reference:

```bash
python3 spikes/step-style-inspector/step_style_inspector.py \
  /path/to/input.stp \
  --xcaf-report /tmp/u843-xcaf-glb-output-v5/xcaf-report.json \
  --out /tmp/u843-step-style-report.json \
  --crossref-out /tmp/u843-style-xcaf-crossref.json
```

The tool is intentionally isolated from production conversion. It summarizes
presentation/style entities and graph links without expanding geometry arrays.
