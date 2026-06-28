# FormatIQ DXF Fixture Policy

FormatIQ compatibility work needs representative DXF structure without placing project, customer, or production geometry in Git. This policy applies before DXF upload is exposed.

## Fixtures that may be committed

- Tiny hand-authored ASCII DXFs that isolate one parser or rendering rule.
- Synthetic DXFs generated from code with invented geometry, layer names, handles, and coordinates.
- Public, non-confidential sample DXFs whose license permits redistribution. Record the source URL, license, and any modifications beside the fixture.

Committed fixtures must be small, deterministic, reviewable as text, and free of names, paths, metadata, title blocks, coordinates, or geometry derived from a real project. Sanitizing a confidential model by renaming layers is not enough; recreate the required structure with synthetic geometry.

## Files that must never be committed

- Coworker or customer Revit/AutoCAD exports.
- Production uploads, generated GLBs, copied storage, databases, logs, or reports.
- Confidential project geometry, site coordinates, title blocks, people/company names, or embedded paths.
- A private sample that cannot be proven safe and redistributable.

## Private local compatibility samples

Place private real-export samples only in:

```text
.tmp/formatiq-private-samples/
```

The repository ignores `.tmp/` and explicitly lists the FormatIQ sample, result, and benchmark subfolders. Before running the harness, confirm `git status --short --ignored` reports the sample as ignored. Never move private samples into `apps/worker/src/dxf/fixtures/`.

From `apps/worker`, run all private `.dxf` files without touching the app database, upload API, or production storage:

```powershell
npm run dxf:compat
```

Optional explicit local paths are supported:

```powershell
npm run dxf:compat -- "D:\private-dxf" "D:\private-dxf-results"
```

The default output is `.tmp/formatiq-compatibility-results/`. The harness prints and writes a summary containing filename, status, entity/ACIS/MESH/block/instance counts, triangles, materials, raw/display GLB sizes, elapsed time, and warnings. Outputs remain local and ignored.

## Review and sanitization checklist

1. Record the exporter (Revit/AutoCAD), release, DXF version, and export settings outside Git if that context is confidential.
2. Reproduce any parser failure with the smallest hand-authored or synthetic DXF possible.
3. Remove all project-derived names, handles, coordinates, header metadata, comments, preview data, and unused sections.
4. Confirm the minimized fixture contains only invented geometry and generic labels.
5. Run `git diff --cached --name-only` before commit and verify no private input or generated output is staged.

The implemented MINSERT fields follow Autodesk's documented INSERT group codes: column count `70`, row count `71`, column spacing `44`, and row spacing `45`. Level-0 MESH diagnostics follow Autodesk's documented vertex, face-list, edge, and crease fields. See [Autodesk INSERT DXF codes](https://help.autodesk.com/cloudhelp/2018/ENU/AutoCAD-DXF/files/GUID-28FA4CFB-9D5E-4880-9F11-36C97578252F.htm) and [Autodesk MESH DXF codes](https://help.autodesk.com/cloudhelp/2017/ENU/AutoCAD-DXF/files/GUID-4B9ADA67-87C8-4673-A579-6E4C76FF7025.htm).
