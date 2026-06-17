# STEP presentation hierarchy investigation

Date: 2026-06-17

## Scope

This note tracks the multi-component colour failure found after
`e7f5ba7 Implement STEP presentation colour resolver`.

The converter was already running in the intended production mode:

```bash
CONVERTER_BACKEND=xcaf-baseline
XCAF_COLOUR_MODE=step-presentation
```

The bug was not missing STEP colour values. It was a hierarchy/topology mapping
gap when more than one component-level STEP representation group existed in the
same file.

## Relevant uploads

Recent EliteDesk uploads used for the investigation:

| Case | Slug | Source path | Result before fix |
| --- | --- | --- | --- |
| Single component | `test-4-20260616085828` | `/home/claudio/projects/3d-model-web-viewer/data/uploads/test-4-20260616085828/original.stp` | Correct STEP-presentation colour |
| Single component | `test-5-20260616085832` | `/home/claudio/projects/3d-model-web-viewer/data/uploads/test-5-20260616085832/original.stp` | Correct STEP-presentation colour |
| Both components | `test-6-20260616085916` | `/home/claudio/projects/3d-model-web-viewer/data/uploads/test-6-20260616085916/original.stp` | Incorrect neutral grey |

Before the fix, `test-6` had:

- `4` `COLOUR_RGB` entities
- `4` `STYLED_ITEM` entities
- `4` representation colour links
- `0` STEP-presentation-derived face uses
- `124` default material face uses
- rejection reason:
  `multiple STEP representation groups have strong styled topology targets; no unique representation group was selected`

## Cause

The single-component files each contain one named component
`SHAPE_REPRESENTATION` and one BREP representation group. The resolver did not
actually connect the component name to the styled BREP group directly, but the
global fallback was safe because there was only one strong styled representation
group in the whole STEP file.

The multi-component file contains two named component `SHAPE_REPRESENTATION`s:

- `#1930` for the V16B component
- `#1931` for the V10B component

Those named representations do not directly contain the styled
`MANIFOLD_SOLID_BREP` targets. They are connected sideways through
`SHAPE_REPRESENTATION_RELATIONSHIP` entities:

- `#1930 -> #18 SHAPE_REPRESENTATION_RELATIONSHIP -> #61 ADVANCED_BREP_SHAPE_REPRESENTATION -> #57/#58 MANIFOLD_SOLID_BREP`
- `#1931 -> #19 SHAPE_REPRESENTATION_RELATIONSHIP -> #62 ADVANCED_BREP_SHAPE_REPRESENTATION -> #59/#60 MANIFOLD_SOLID_BREP`

The previous raw STEP style index only walked forward references from a named
representation. That missed the relationship bridge, so name-specific matching
failed. The fallback then saw two strong styled representation groups and
correctly refused to guess which one belonged to each XCAF component.

## Fix

The raw STEP style resolver now crosses explicit representation bridge entities
when indexing a named representation:

- `SHAPE_REPRESENTATION_RELATIONSHIP`
- `CONTEXT_DEPENDENT_SHAPE_REPRESENTATION`

After crossing the bridge, the existing strong-target and topology-count checks
still apply. The converter does not colour a whole compound from one child
style, does not use layer/name/material guessing, and does not hard-code model
or component names.

When a component compound contains multiple styled BREP targets, render geometry
is split by styled target. The selectable parent remains the XCAF component
instance, and the split render groups keep metadata linking them back to that
parent.

## Verification

The fixed native converter was run on the EliteDesk with the existing upload as
a non-committed `/tmp` comparison:

```bash
./spikes/occt-xcaf-glb/run.sh \
  /home/claudio/projects/3d-model-web-viewer/data/uploads/test-6-20260616085916/original.stp \
  /tmp/test6-hierarchy-fix-v2 \
  balanced \
  --colour-mode step-presentation
```

The fixed report showed:

- `4` exported GLB nodes/material groups
- `4` STEP-presentation-derived groups
- `124` STEP-presentation-derived face uses
- `0` default material uses
- `0` ambiguous representation rejects
- `0` broad representation rejects

Each group had exact STEP provenance. Examples:

- V16B group: `#1930 -> #18 -> #61 -> #57 MANIFOLD_SOLID_BREP -> #49 STYLED_ITEM`
- V16B group: `#1930 -> #18 -> #61 -> #58 MANIFOLD_SOLID_BREP -> #50 STYLED_ITEM`
- V10B group: `#1931 -> #19 -> #62 -> #59 MANIFOLD_SOLID_BREP -> #51 STYLED_ITEM`
- V10B group: `#1931 -> #19 -> #62 -> #60 MANIFOLD_SOLID_BREP -> #52 STYLED_ITEM`

The GLB JSON was read back successfully. Node and mesh primitive `extras`
included selection metadata such as:

- `selectableId`
- `parentObjectId`
- `displayName`
- `xcafLabelPath`
- `referredLabelPath`
- `stepEntityIds`
- `stepStyledItemId`
- `colourSource`
- `geometrySource`

## Remaining limitations

The GLB is still a flattened render hierarchy. The metadata now preserves enough
parent identity for click-selection, but a later viewer change still needs to
walk from the picked mesh/primitive back to `selectableId` and present the
display/block/component fields in the UI.

The resolver still requires exact strong STEP topology targets and a matching
exported topology count. If a future STEP file connects styles only through
weak representation-level targets, the converter should continue to report the
evidence instead of applying a broad colour guess.
