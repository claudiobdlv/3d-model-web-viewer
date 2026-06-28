// FormatIQ Phase 2A — DXF backend tests
// Tests are internal/test-only; DXF is NOT wired into the production upload route.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseDxf } from "./dxf/parseDxf.js";
import { resolveColor } from "./dxf/colors.js";
import { extractAllTriangles } from "./dxf/geometry.js";
import { convertDxfToGlb } from "./dxf/convertDxfToGlb.js";
import { convertStepJob } from "./converterProcessor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "dxf", "fixtures");

function fix(name: string): string {
  return path.join(FIXTURES, name);
}

// ─── Unit: parseDxf ──────────────────────────────────────────────────────────

test("parseDxf: 3DFACE fixture parses correctly", () => {
  const result = parseDxf(fix("test-3dface.dxf"));
  assert.equal(result.dxfVersion, "AC1015");
  assert.equal(result.entities.supported.length, 1);
  const face = result.entities.supported[0]!;
  assert.equal(face.type, "3DFACE");
  assert.equal(face.triangleCount, 1); // v2===v3 → triangle
});

test("parseDxf: POLYFACE_MESH fixture parses 4 triangles", () => {
  const result = parseDxf(fix("test-polyface.dxf"));
  assert.equal(result.entities.supported.length, 1);
  const poly = result.entities.supported[0]!;
  assert.equal(poly.type, "POLYFACE_MESH");
  assert.equal(poly.triangleCount, 4);
});

test("parseDxf: block-insert fixture reports 3 inserts and 1 block", () => {
  const result = parseDxf(fix("test-block-insert.dxf"));
  assert.equal(result.entities.inserts.length, 3);
  assert.equal(Object.keys(result.blocks).length, 1);
  assert.ok(result.blocks["TRIANGLE"]);
  // The block contains a triangle
  assert.equal(result.blocks["TRIANGLE"]!.triangleCount, 1);
  // All inserts reference TRIANGLE
  for (const ins of result.entities.inserts) {
    assert.equal(ins.blockName, "TRIANGLE");
  }
});

test("parseDxf: layer-color fixture parses 3 layers and 3 faces", () => {
  const result = parseDxf(fix("test-layer-color.dxf"));
  assert.equal(result.entities.supported.length, 3);
  // Layers: 0, Walls, Floor, Ceiling
  assert.ok(result.layers["Walls"]);
  assert.ok(result.layers["Floor"]);
  assert.ok(result.layers["Ceiling"]);
});

test("parseDxf: ACIS-only fixture produces 2 ACIS entities and 0 supported", () => {
  const result = parseDxf(fix("test-acis-only.dxf"));
  assert.equal(result.entities.supported.length, 0);
  assert.equal(result.entities.acis.length, 2);
  const types = result.entities.acis.map((e) => e.type).sort();
  assert.deepEqual(types, ["3DSOLID", "BODY"]);
});

// ─── Unit: colour resolution ─────────────────────────────────────────────────

test("resolveColor: entity ACI 3 (green) resolves correctly", () => {
  const layers = { "0": { name: "0", colorIndex: 7, trueColor: null, frozen: false } };
  const color = resolveColor(3, null, "0", layers);
  assert.equal(color.source, "entity-aci");
  assert.equal(color.hex, "#00ff00");
});

test("resolveColor: BYLAYER red (ACI 1) resolves via layer table", () => {
  const layers = {
    "0": { name: "0", colorIndex: 7, trueColor: null, frozen: false },
    Walls: { name: "Walls", colorIndex: 1, trueColor: null, frozen: false },
  };
  // Entity with no color → BYLAYER
  const color = resolveColor(null, null, "Walls", layers);
  assert.equal(color.source, "layer-aci");
  assert.equal(color.hex, "#ff0000");
});

test("resolveColor: entity true-colour 65280 overrides layer", () => {
  // 65280 = 0x00FF00 → green
  const layers = {
    "0": { name: "0", colorIndex: 7, trueColor: null, frozen: false },
    Ceiling: { name: "Ceiling", colorIndex: 7, trueColor: 16711935, frozen: false },
  };
  const color = resolveColor(null, 65280, "Ceiling", layers);
  assert.equal(color.source, "entity-truecolor");
  assert.equal(color.hex, "#00ff00");
});

test("resolveColor: BYBLOCK (ACI 0) returns byblock sentinel", () => {
  const layers = { "0": { name: "0", colorIndex: 7, trueColor: null, frozen: false } };
  const color = resolveColor(0, null, "0", layers);
  assert.equal(color.source, "byblock");
});

test("resolveColor: BYLAYER (ACI 256) defers to layer table", () => {
  const layers = {
    "0": { name: "0", colorIndex: 7, trueColor: null, frozen: false },
    Floor: { name: "Floor", colorIndex: 3, trueColor: null, frozen: false },
  };
  const color = resolveColor(256, null, "Floor", layers);
  assert.equal(color.source, "layer-aci");
  assert.equal(color.hex, "#00ff00");
});

// ─── Unit: triangle extraction ────────────────────────────────────────────────

test("extractAllTriangles: 3DFACE triangle gives 1 triangle", () => {
  const result = parseDxf(fix("test-3dface.dxf"));
  const tris = extractAllTriangles(result.entities.supported);
  assert.equal(tris.length, 1);
});

test("extractAllTriangles: POLYFACE_MESH gives 4 triangles", () => {
  const result = parseDxf(fix("test-polyface.dxf"));
  const tris = extractAllTriangles(result.entities.supported);
  assert.equal(tris.length, 4);
});

test("extractAllTriangles: layer-color fixture triangles have correct material keys", () => {
  const result = parseDxf(fix("test-layer-color.dxf"));
  const tris = extractAllTriangles(result.entities.supported);
  // 3 faces: Walls quad (2 tris), Floor tri (1), Ceiling tri (1) → 4 total
  assert.equal(tris.length, 4);

  const wallTris = tris.filter((t) => t.layer === "Walls");
  assert.equal(wallTris.length, 2); // quad → 2 triangles
  assert.ok(wallTris[0]!.colorHex.startsWith("#"), "color hex present");
  assert.equal(wallTris[0]!.colorHex, "#ff0000"); // ACI 1 = red

  const ceilTris = tris.filter((t) => t.layer === "Ceiling");
  assert.equal(ceilTris.length, 1);
  assert.equal(ceilTris[0]!.colorHex, "#00ff00"); // entity trueColor 65280
});

test("parseDxf: non-default extrusion is transformed from OCS to WCS", () => {
  const result = parseDxf(fix("test-ocs-extrusion.dxf"));
  const face = result.entities.supported[0]!;
  assert.equal(face.type, "3DFACE");
  assert.equal(face.hasExplicitExtrusion, true);
  assert.equal(face.ocsApplied, true);
  if (face.type !== "3DFACE") assert.fail("expected 3DFACE");
  assert.deepEqual(face.v1.map((value) => Math.round(value)), [-1, 0, 0]);
  assert.deepEqual(face.v2.map((value) => Math.round(value)), [0, 0, 1]);
});

test("BYBLOCK geometry inherits a simple INSERT ACI colour", () => {
  const result = parseDxf(fix("test-byblock-color.dxf"));
  const block = result.blocks.BYBLOCK_TRIANGLE!;
  assert.equal(block.supported[0]?.color.source, "byblock");
  const inherited = resolveColor(result.entities.inserts[0]!.colorIndex, null, "0", result.layers);
  const triangles = extractAllTriangles(block.supported, inherited);
  assert.equal(triangles[0]?.colorHex, "#0000ff");
});

// ─── Integration: convertDxfToGlb ────────────────────────────────────────────

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dxf-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

test("convertDxfToGlb: 3DFACE fixture produces all output files", async () => {
  await withTmpDir(async (dir) => {
    const out = await convertDxfToGlb({ sourcePath: fix("test-3dface.dxf"), outputDir: dir, slug: "test-3dface" });

    // All output paths should exist
    for (const key of Object.keys(out) as (keyof typeof out)[]) {
      const p = out[key];
      const stat = await fs.promises.stat(p).catch(() => null);
      assert.ok(stat && stat.isFile(), `Expected file at ${key}: ${p}`);
    }

    // GLB must be non-empty
    const glbStat = await fs.promises.stat(out.displayGlbPath);
    assert.ok(glbStat.size > 0, "display.glb must be non-empty");

    // format-report should have conversionStatus ok
    const report = JSON.parse(await fs.promises.readFile(out.formatReportPath, "utf8"));
    assert.equal(report.conversionStatus, "ok");
    assert.equal(report.sourceFormat, "dxf");

    // manifest should have converterBackend
    const manifest = JSON.parse(await fs.promises.readFile(out.manifestPath, "utf8"));
    assert.equal(manifest.converterBackend, "dxf-js");
    assert.equal(manifest.artifacts.formatReport, "format-report.json");

    // stats should have sourceFormat
    const stats = JSON.parse(await fs.promises.readFile(out.statsPath, "utf8"));
    assert.equal(stats.sourceFormat, "dxf");
    assert.equal(stats.converterBackend, "dxf-js");
    assert.ok(["applied", "skipped-not-smaller"].includes(stats.optimization.status), stats.optimization.message);
    assert.ok(stats.optimization.message, "meshopt outcome must be explained");
    assert.equal(stats.optimization.validation.passed, true);
    assert.ok(stats.optimization.validation.gates.includes("node extras"));
    assert.ok(stats.optimization.validation.gates.includes("material names and PBR factors"));

    const optimizationReport = JSON.parse(await fs.promises.readFile(out.dxfOptimizationReportPath, "utf8"));
    assert.equal(optimizationReport.glb.rawSizeBytes, stats.optimization.rawSizeBytes);
    assert.equal(optimizationReport.glb.displaySizeBytes, stats.optimization.displaySizeBytes);
    assert.equal(optimizationReport.meshopt.status, stats.optimization.status);
  });
});

test("convertDxfToGlb: POLYFACE_MESH fixture reports 4 triangles", async () => {
  await withTmpDir(async (dir) => {
    const out = await convertDxfToGlb({ sourcePath: fix("test-polyface.dxf"), outputDir: dir, slug: "test-poly" });
    const report = JSON.parse(await fs.promises.readFile(out.formatReportPath, "utf8"));
    assert.equal(report.conversionStatus, "ok");
    assert.equal(report.entityCounts["POLYFACE_MESH"], 1);
    // Optimization report should exist and show raw triangle count = 4
    const optReport = JSON.parse(await fs.promises.readFile(out.dxfOptimizationReportPath, "utf8"));
    assert.equal(optReport.geometry.rawTriangleCount, 4);
  });
});

test("convertDxfToGlb: block-insert fixture reports block reuse", async () => {
  await withTmpDir(async (dir) => {
    const out = await convertDxfToGlb({ sourcePath: fix("test-block-insert.dxf"), outputDir: dir, slug: "test-blk" });
    const report = JSON.parse(await fs.promises.readFile(out.formatReportPath, "utf8"));
    assert.equal(report.conversionStatus, "ok");
    assert.equal(report.insertCount, 3);
    assert.equal(report.blockCount, 1);
    assert.deepEqual(report.insertsByBlock, { TRIANGLE: 3 });
    assert.equal(report.blocks[0].name, "TRIANGLE");

    // GLB must be present and non-empty
    const glbStat = await fs.promises.stat(out.displayGlbPath);
    assert.ok(glbStat.size > 0, "display.glb must be non-empty");
  });
});

test("convertDxfToGlb: layer-color fixture reports ok status", async () => {
  await withTmpDir(async (dir) => {
    const out = await convertDxfToGlb({ sourcePath: fix("test-layer-color.dxf"), outputDir: dir, slug: "test-color" });
    const report = JSON.parse(await fs.promises.readFile(out.formatReportPath, "utf8"));
    assert.equal(report.conversionStatus, "ok");
    assert.equal(report.entityCounts["3DFACE"], 3);
    assert.ok(report.layerCount >= 3);
  });
});

test("converterProcessor invokes dxf-js internally and returns normal artifacts", async () => {
  await withTmpDir(async (dir) => {
    const out = await convertStepJob({
      sourcePath: fix("test-3dface.dxf"),
      outputDir: dir,
      slug: "processor-dxf",
      converterBackend: "dxf-js",
      converterCli: "unused",
      xcafConverterBin: "unused",
      xcafColourMode: "xcaf-baseline",
      quality: "medium",
      glbOptimizationMode: "meshopt",
    });
    assert.ok(out.formatReportPath);
    assert.ok(out.dxfOptimizationReportPath);
    for (const name of ["display.glb", "manifest.json", "stats.json", "format-report.json", "dxf-optimization-report.json", "material-debug.json", "conversion.log"]) {
      const stat = await fs.promises.stat(path.join(dir, "processor-dxf", name));
      assert.ok(stat.isFile(), `${name} should be produced`);
    }
    assert.ok((await fs.promises.stat(out.displayGlbPath)).size > 0);
  });
});

test("convertDxfToGlb: OCS report records transformed extrusion", async () => {
  await withTmpDir(async (dir) => {
    const out = await convertDxfToGlb({ sourcePath: fix("test-ocs-extrusion.dxf"), outputDir: dir, slug: "test-ocs" });
    const report = JSON.parse(await fs.promises.readFile(out.formatReportPath, "utf8"));
    assert.equal(report.ocs.explicitExtrusionEntityCount, 1);
    assert.equal(report.ocs.transformedEntityCount, 1);
  });
});

test("convertDxfToGlb: BYBLOCK INSERT colour is present in generated materials", async () => {
  await withTmpDir(async (dir) => {
    const out = await convertDxfToGlb({ sourcePath: fix("test-byblock-color.dxf"), outputDir: dir, slug: "test-byblock" });
    const materialDebug = JSON.parse(await fs.promises.readFile(out.materialDebugPath, "utf8"));
    assert.ok(materialDebug.materials.some((material: { colorHex: string }) => material.colorHex === "#0000ff"));
  });
});

test("convertDxfToGlb: mixed supported mesh and ACIS succeeds with partial warning", async () => {
  await withTmpDir(async (dir) => {
    const out = await convertDxfToGlb({ sourcePath: fix("test-mixed-mesh-acis.dxf"), outputDir: dir, slug: "test-mixed" });
    const report = JSON.parse(await fs.promises.readFile(out.formatReportPath, "utf8"));
    assert.equal(report.conversionStatus, "partial-with-warnings");
    assert.equal(report.acisEntityCount, 1);
    assert.match(report.warnings.join(" "), /skipped/i);
  });
});

test("convertDxfToGlb: MESH-only input is reported and rejected without fake geometry", async () => {
  await withTmpDir(async (dir) => {
    await assert.rejects(
      () => convertDxfToGlb({ sourcePath: fix("test-mesh-only.dxf"), outputDir: dir, slug: "test-mesh-only" }),
      /no 3D mesh geometry|no usable 3D geometry/i
    );
    const report = JSON.parse(await fs.promises.readFile(path.join(dir, "test-mesh-only", "format-report.json"), "utf8"));
    assert.equal(report.entityCounts.MESH, 1);
    assert.equal(report.conversionStatus, "no-usable-3d-geometry");
    assert.match(report.warnings.join(" "), /detected but not yet triangulated/i);
  });
});

test("convertDxfToGlb: ACIS-only fixture throws with actionable advice", async () => {
  await withTmpDir(async (dir) => {
    await assert.rejects(
      () => convertDxfToGlb({ sourcePath: fix("test-acis-only.dxf"), outputDir: dir, slug: "test-acis" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /ACIS|acis/i);
        return true;
      }
    );

    // format-report should still be written with correct status
    const reportPath = path.join(dir, "test-acis", "format-report.json");
    const report = JSON.parse(await fs.promises.readFile(reportPath, "utf8"));
    assert.equal(report.conversionStatus, "acis-only-hard-error");
    assert.equal(report.acisEntityCount, 2);
    assert.ok(report.warnings.length > 0);
    assert.ok(report.exportAdvice, "exportAdvice should be present");
    // Should contain Revit re-export guidance
    assert.match(report.exportAdvice, /[Pp]olymesh|polymesh/);
  });
});

// Note: No fixture exists for mixed-ACIS, 2D-only, or no-geometry cases.
// These paths are covered by the parseDxf unit tests above and by the
// buildFormatReport logic. Full integration tests can be added in Phase 2B
// when additional fixtures are created.
