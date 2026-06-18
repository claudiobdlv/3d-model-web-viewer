# Object name extraction investigation

## PCW Skid 4

The production model `pcw-skid-4-20260617104826` exposed two selectable render
groups. Before this change their GLB `displayName` values were raw XCAF label
names (`=>[0:1:1:3]` and `=>[0:1:1:4]`), while both had the layer `ITEMS`.
Their XCAF referred labels were structural `COMPOUND` and `SHELL` labels.

The human-readable component name is present in the raw STEP product graph:

- `PRODUCT #37254`: `GRUNDFOS CR 32-5-2 A-F-A-E-HQQE VERTICAL CENTRIFUGAL PUMP + DIN FLANGE DN65`
- `PRODUCT_DEFINITION #37242` links through formation `#37244` to that product.
- `PRODUCT_DEFINITION_SHAPE #37237` and `SHAPE_DEFINITION_REPRESENTATION #37235`
  link it to `SHAPE_REPRESENTATION #37272`, which carries the same name.
- `NEXT_ASSEMBLY_USAGE_OCCURRENCE #13` places product definition `#37242`
  beneath the document product definition `#37241`.

## Resolution rules

The converter rejects raw label paths, numeric label paths, structural shape
names, generic translator names, and generated `brep_rep_*`/`shell_rep_*`
names. It prefers an explicit XCAF instance/object name, then an owning product
or component name, then a readable referred-label or inherited parent name.
When an assembly has no usable XCAF name and the STEP file has exactly one
usable non-document product name, that product name becomes the assembly
component name and is inherited by its rendered children. A layer name remains
the fallback only when no object, referred, inherited component, or product
name is available.

Each GLB node and primitive now carries `displayName`, `resolvedObjectName`,
`objectName`, `blockName`, `componentName`, `productName`, `nameCandidates`,
`layerNames`, `selectableId`, and `parentObjectId`. Raw XCAF and referred label
paths remain available separately for diagnostics.

For PCW Skid 4, both selectable children now resolve to the pump product name
instead of a raw XCAF path or `ITEMS`. Their selectable ids, transforms,
geometry, materials, and colour sources are unchanged.
