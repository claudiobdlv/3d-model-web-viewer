# FormatIQ DXF Mesh Import Spike

Zero-dependency Node.js ESM spike for DXF mesh entity detection and colour resolution.

No `npm install` needed — pure Node.js stdlib only.

## Run the smoke test

```sh
cd spikes/formatiq-dxf-spike
node src/dxfSpikeParser.mjs fixtures/test-3dface.dxf fixtures/test-polyface.dxf \
  fixtures/test-block-insert.dxf fixtures/test-layer-color.dxf fixtures/test-acis-only.dxf
```

Or via npm:
```sh
npm test
```

## Parse any DXF file

```sh
node spikes/formatiq-dxf-spike/src/dxfSpikeParser.mjs path/to/your-export.dxf
```

## What it detects

| Entity | Type | Action |
|--------|------|--------|
| `3DFACE` | Triangle / quad | Parsed, counted, colour resolved |
| `POLYLINE` (flag 64) | POLYFACE_MESH | Parsed, vertices + face records counted |
| `POLYLINE` (flag 16) | POLYMESH | Parsed as above |
| `MESH` | R2010+ subdivision mesh | Detected, vertex/face count reported; full triangulation deferred to production |
| `INSERT` | Block reference | Parsed, block name + transform recorded |
| `3DSOLID` | ACIS solid | Detected → error if only content; warning + skip if mixed |
| `BODY` | ACIS solid | Same as 3DSOLID |
| `REGION` | ACIS surface | Same as 3DSOLID |
| Others | 2D or unknown | Counted in `skipped` map |

## Output shape

```json
{
  "sourceFile": "test-3dface.dxf",
  "dxfVersion": "AC1015",
  "summary": {
    "status": "ok | partial-import-with-warnings | acis-only-hard-error | no-3d-mesh-geometry | empty",
    "supportedEntityCount": 1,
    "unsupportedAcisCount": 0,
    "insertCount": 0,
    "triangleCount": 1,
    "warnings": [],
    "exportAdvice": null
  },
  "entityCounts": { "3DFACE": 1, "POLYFACE_MESH": 0, ... },
  "layers": { "0": { "colorIndex": 7, "hex": "#ffffff", "frozen": false } },
  "blocks": {},
  "inserts": {},
  "details": { "supported": [...], "acis": [...], "inserts": [...] }
}
```

## Fixtures

| File | Tests |
|------|-------|
| `test-3dface.dxf` | Single green 3DFACE triangle on default layer |
| `test-polyface.dxf` | Tetrahedron as POLYFACE_MESH (4 pos vertices, 4 face records) |
| `test-block-insert.dxf` | TRIANGLE block inserted 3× with different positions/scales/rotations |
| `test-layer-color.dxf` | BYLAYER colours (Walls=red, Floor=green), entity true-colour override (Ceiling face=lime), layer true-colour (Ceiling layer=magenta) |
| `test-acis-only.dxf` | 3DSOLID + BODY only → `acis-only-hard-error` status |

## Next step

See `docs/formatiq-dxf-mesh-import-plan.md` for the full production implementation plan.
