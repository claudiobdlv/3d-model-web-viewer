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

## Exact colour attachment difference

```text
test 1:
Rhino visible colour = green
STEP colour exists at:
  #15 COLOUR_RGB('',0.,0.149019607843137,0.)
    -> #17 FILL_AREA_STYLE_COLOUR
    -> #19 FILL_AREA_STYLE
    -> #21 SURFACE_STYLE_FILL_AREA
    -> #23 SURFACE_SIDE_STYLE
    -> #25 SURFACE_STYLE_USAGE
    -> #28 PRESENTATION_STYLE_ASSIGNMENT
    -> #30 STYLED_ITEM('',(#28),#34)
    -> #34 MANIFOLD_SOLID_BREP('brep_1',#37)
  #16 COLOUR_RGB('',0.,0.149019607843137,0.)
    -> #18 FILL_AREA_STYLE_COLOUR
    -> #20 FILL_AREA_STYLE
    -> #22 SURFACE_STYLE_FILL_AREA
    -> #24 SURFACE_SIDE_STYLE
    -> #26 SURFACE_STYLE_USAGE
    -> #29 PRESENTATION_STYLE_ASSIGNMENT
    -> #31 STYLED_ITEM('',(#29),#35)
    -> #35 MANIFOLD_SOLID_BREP('brep_2',#38)
STEP target reachability = yes, but only through the representation graph:
  #3137 SHAPE_REPRESENTATION(...)
    -> #14 SHAPE_REPRESENTATION_RELATIONSHIP('', '', #3137, #36)
    -> #36 ADVANCED_BREP_SHAPE_REPRESENTATION('brep_rep_0',(#34,#35,#3468),#3135)
    -> #34/#35 MANIFOLD_SOLID_BREP targets
STEP layer membership:
  #32 PRESENTATION_LAYER_ASSIGNMENT('PIPE SUPPORTS','',(#34))
  #33 PRESENTATION_LAYER_ASSIGNMENT('3D PRINTED','',(#35))
XCAF direct colour = no
XCAF label path = 0:1:1:1:1
XCAF display name = 3D PRINTED BRACKET + 3 x 1/2", 37mm OFFSET, TYPE A
XCAF layer membership = none exposed
XCAF direct face/subshape colour = no
XCAF owning label/shape colour = no
XCAF referred/original label colour = no
XCAF instance/component colour = no
XCAF ancestor colour = no
converter baseline output = grey/default_neutral_grey
reason = OpenCascade imports the two styled BREP items as one COMPOUND XCAF
  object and does not promote either raw BREP STYLED_ITEM into a direct XCAF
  label, shape, face, subshape, ancestor, instance, referred-label, or layer
  colour candidate. The green exists in the raw STEP presentation graph, but
  xcaf-baseline treats raw STEP styles as diagnostic-only.

test 2:
Rhino visible colour = green
STEP colour exists at:
  #19 COLOUR_RGB('',0.,0.149019607843137,0.)
    -> #21 FILL_AREA_STYLE_COLOUR
    -> #23 FILL_AREA_STYLE
    -> #25 SURFACE_STYLE_FILL_AREA
    -> #27 SURFACE_SIDE_STYLE
    -> #29 SURFACE_STYLE_USAGE
    -> #32 PRESENTATION_STYLE_ASSIGNMENT
    -> #34 STYLED_ITEM('',(#32),#38)
    -> #38 SHELL_BASED_SURFACE_MODEL('shell_1',(#40))
  #20 COLOUR_RGB('',0.,0.149019607843137,0.)
    -> #22 FILL_AREA_STYLE_COLOUR
    -> #24 FILL_AREA_STYLE
    -> #26 SURFACE_STYLE_FILL_AREA
    -> #28 SURFACE_SIDE_STYLE
    -> #30 SURFACE_STYLE_USAGE
    -> #33 PRESENTATION_STYLE_ASSIGNMENT
    -> #35 STYLED_ITEM('',(#33),#16)
    -> #16 MANIFOLD_SOLID_BREP('brep_1',#18)
STEP target reachability = yes, through two representation relationships:
  #3728 SHAPE_REPRESENTATION(...)
    -> #14 SHAPE_REPRESENTATION_RELATIONSHIP('', '', #3728, #17)
    -> #17 ADVANCED_BREP_SHAPE_REPRESENTATION('brep_rep_0',(#16,#4114),#3726)
    -> #16 MANIFOLD_SOLID_BREP target
  #3728 SHAPE_REPRESENTATION(...)
    -> #15 SHAPE_REPRESENTATION_RELATIONSHIP('', '', #3728, #39)
    -> #39 MANIFOLD_SURFACE_SHAPE_REPRESENTATION('shell_rep_0',(#38,#4115),#3726)
    -> #38 SHELL_BASED_SURFACE_MODEL target
STEP layer membership:
  #36 PRESENTATION_LAYER_ASSIGNMENT('3D PRINTED','',(#38))
  #37 PRESENTATION_LAYER_ASSIGNMENT('PIPE SUPPORTS','',(#16))
XCAF direct colour = yes
XCAF label path = 0:1:1:2:1, display name =>[0:1:1:3], shape type SOLID
  layer membership = referred layer PIPE SUPPORTS
  direct face/subshape colour = no
  owning label/shape colour = yes, owning_shape_surface
  referred/original label colour = yes, referred_label_surface at 0:1:1:3
  instance/component colour = no
  ancestor colour = no
XCAF label path = 0:1:1:2:2, display name =>[0:1:1:4], shape type SHELL
  layer membership = referred layer 3D PRINTED
  direct face/subshape colour = no
  owning label/shape colour = yes, owning_shape_surface
  referred/original label colour = yes, referred_label_surface at 0:1:1:4
  instance/component colour = no
  ancestor colour = no
converter baseline output = green/owning_shape_surface
reason = OpenCascade imports the styled solid and shell as separate XCAF
  component labels and promotes the same green to direct XCAF surface colour
  metadata on the owning component shapes and their referred/original labels.
  xcaf-baseline trusts those direct XCAF candidates, so the output is green.
```

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

## Hypotheses checked

| Possible cause | Finding |
| --- | --- |
| Direct polysurface vs block/reference | Both files have context-dependent/reference structure. The difference is that `test 2` decomposes into two XCAF component labels with referred/original labels, while `test 1` collapses to one compound output object. |
| Object colour vs by-layer colour | Not enough evidence to call this a layer-colour issue. Both files contain explicit raw `COLOUR_RGB` and `STYLED_ITEM` presentation styles. XCAF exposes layer names for `test 2` only, and exposes no layer colour values for either file. |
| Face/subshape style vs presentation style only | Neither baseline report shows direct face/subshape XCAF colour. The relevant raw styles are STEP presentation `STYLED_ITEM`s. |
| Solid/body vs representation item colour | This is the strongest structural difference. `test 1` styles two `MANIFOLD_SOLID_BREP` targets inside one `ADVANCED_BREP_SHAPE_REPRESENTATION`, but OCCT does not expose them as XCAF colours. `test 2` styles one `MANIFOLD_SOLID_BREP` and one `SHELL_BASED_SURFACE_MODEL`; OCCT promotes both resulting component shapes to XCAF `owning_shape_surface` colour. |
| Nested assembly/block hierarchy | Both have top-level shape representation relationships. `test 2` has two reachable representation branches, BREP and surface shell, that become separate coloured XCAF labels. `test 1` has one BREP representation with two styled BREP members that becomes one uncoloured compound label. |
| Different STEP entity structure despite similar Rhino appearance | Confirmed. Rhino can show both as green, but the STEP topology/style attachment structure differs enough that OpenCascade/XCAF exposes direct colour for `test 2` and not for `test 1`. |

## Implemented resolver mode

The native converter now has a dedicated mode:

```bash
--colour-mode step-presentation --colour-space raw
```

This mode keeps XCAF as the hierarchy, transform, and topology traversal source.
Direct XCAF face/subshape, owning-label, and referred-label colours still win.
When XCAF does not expose a colour for the exported topology, the converter uses
the STEP presentation graph itself:

- `COLOUR_RGB`
- `FILL_AREA_STYLE_COLOUR`
- `SURFACE_STYLE_*`
- `PRESENTATION_STYLE_ASSIGNMENT`
- `STYLED_ITEM`
- `MANIFOLD_SOLID_BREP` / `SHELL_BASED_SURFACE_MODEL`
- the containing shape representation path

For `test 1`, the resolver finds two strong styled targets, `#34` and `#35`,
under the same `ADVANCED_BREP_SHAPE_REPRESENTATION`. Because OpenCascade exports
the XCAF object as one compound with two matching child solid groups, the GLB
export is split by styled BREP target. The two output groups keep separate
`stableObjectId` values and report:

- `colourSource=step_presentation_styled_item`
- `materialSource=step_presentation_styled_item`
- `geometrySource=compound split by styled BREP`
- the `STYLED_ITEM` id
- the styled target id/type/scope
- the representation path used as evidence

This is not a layer-name, object-name, material-rule, or hard-coded colour path.
It is direct STEP presentation-style colour resolution mapped to the exported
topology.

For `test 2`, the expected behaviour remains the same as baseline: OpenCascade
promotes the green to direct XCAF owning/referred shape surface colour on two
component labels, so XCAF colour wins before STEP presentation data is needed.

Broad representation-level matches remain diagnostic-only unless the styled
topology can be mapped to exported subshapes without ambiguity. A compound with
multiple styled targets is not painted as one object; it must either split into
matching styled topology groups or remain uncoloured with the rejection reason
recorded in `xcaf-report.json`.

## Live verification on 2026-06-16

The implemented mode was deployed to the EliteDesk worker with:

```bash
CONVERTER_BACKEND=xcaf-baseline
XCAF_COLOUR_MODE=step-presentation
```

Fresh uploads through `POST /api/models` produced:

- `test-1-step-presentation-v2-20260616084135`
- `test-2-step-presentation-v2-20260616084135`
- `test-1-step-presentation-v3-20260616084735`
- `test-2-step-presentation-v3-20260616084735`
- `u843-step-presentation-v2-20260616084826`

Worker logs for these jobs included:

```text
Converter backend: xcaf-baseline
XCAF colour mode: step-presentation
```

Endpoint checks returned `200` for each fresh slug's viewer page, original
download, GLB download, and authenticated `xcaf-report.json`.

The final `v3` `test 1` upload exports two GLB nodes/material groups instead of
one grey compound:

- `#30 STYLED_ITEM` targeting `#34 MANIFOLD_SOLID_BREP`
- `#31 STYLED_ITEM` targeting `#35 MANIFOLD_SOLID_BREP`
- both report `colourSource=step_presentation_styled_item`
- both report `geometrySource=compound split by styled BREP`
- both write `0.000000,0.019382,0.000000,1.000000`, matching the XCAF green
  material value from `test 2`
- default material usage is `0`

The final `v3` `test 2` upload remains green through direct XCAF colour:

- both output groups report `colourSource=owning_shape_surface`
- `materialSource=label`
- default material usage is `0`

The final full U843 fresh upload also completed in `step-presentation` mode. Its
report showed `173` exported nodes, `1,054,456` triangles, and `0` STEP
presentation-derived groups. It retained the direct XCAF colour result:
`owning_shape_surface`, `referred_label_surface`, and
`referred_subshape_label_surface`, with `14` remaining default-grey groups.
