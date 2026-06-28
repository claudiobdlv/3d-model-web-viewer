// FormatIQ DXF — report and manifest/stats file builders
import path from "node:path";
import type {
  ParsedDxf, DxfFormatReport, DxfOptimizationReport, DxfConversionStatus,
  OptimizationStats,
} from "./types.js";
import { resolveColor } from "./colors.js";

// ─── Format Report ────────────────────────────────────────────────────────────

export function buildFormatReport(params: {
  parsedDxf: ParsedDxf;
  sourcePath: string;
  sourceFileSizeBytes: number;
}): DxfFormatReport {
  const { parsedDxf, sourcePath, sourceFileSizeBytes } = params;
  const { entities, blocks, layers, dxfVersion } = parsedDxf;

  // Entity counts
  const entityCounts = {
    "3DFACE": 0,
    POLYFACE_MESH: 0,
    POLYMESH: 0,
    MESH: 0,
    INSERT: entities.inserts.length,
    "3DSOLID": 0,
    BODY: 0,
    REGION: 0,
  };
  for (const e of entities.supported) {
    if (e.type === "3DFACE") entityCounts["3DFACE"]++;
    else if (e.type === "POLYFACE_MESH") entityCounts["POLYFACE_MESH"]++;
    else if (e.type === "POLYMESH") entityCounts["POLYMESH"]++;
    else if (e.type === "MESH") entityCounts["MESH"]++;
  }
  for (const e of entities.acis) {
    if (e.type === "3DSOLID") entityCounts["3DSOLID"]++;
    else if (e.type === "BODY") entityCounts["BODY"]++;
    else if (e.type === "REGION") entityCounts["REGION"]++;
  }

  const acisEntityCount = entities.acis.length;

  // Insert summary
  const insertsByBlock: Record<string, number> = {};
  for (const ins of entities.inserts) {
    insertsByBlock[ins.blockName] = (insertsByBlock[ins.blockName] ?? 0) + 1;
  }

  // Layer summaries (referenced ones + "0")
  const referencedLayerNames = new Set<string>(
    [...entities.supported, ...entities.acis, ...entities.inserts].map((e) => e.layer)
  );
  referencedLayerNames.add("0");

  const layerSummaries: DxfFormatReport["layers"] = [];
  for (const name of Object.keys(layers)) {
    const l = layers[name]!;
    const color = resolveColor(null, l.trueColor, name, layers);
    layerSummaries.push({
      name,
      colorIndex: l.colorIndex,
      trueColor: l.trueColor,
      hex: color.hex,
      frozen: l.frozen,
    });
  }

  // Block summaries
  const blockSummaries: DxfFormatReport["blocks"] = Object.values(blocks).map((b) => ({
    name: b.name,
    entityCount: b.supported.length + b.inserts.length,
    acisCount: b.acis.length,
    triangleCount: b.triangleCount,
  }));

  // Determine status + warnings
  const hasSupportedEntities = entities.supported.length > 0;
  const hasInserts = entities.inserts.length > 0;
  const hasAcis = acisEntityCount > 0;
  const hasAny3D = hasSupportedEntities || hasInserts;

  // Also check if any block definitions have geometry (accessed via inserts)
  const anyBlockHasGeometry = hasInserts && Object.values(blocks).some((b) => b.triangleCount > 0);
  const hasUsable3D = hasSupportedEntities || anyBlockHasGeometry;

  let conversionStatus: DxfConversionStatus;
  const warnings: string[] = [];
  let exportAdvice: string | null = null;

  const meshEntityCount = entityCounts.MESH;
  if (meshEntityCount > 0) {
    warnings.push(
      `${meshEntityCount} MESH entity/entities (DXF R2010+) detected but not yet triangulated. ` +
        "Full MESH support is planned for a future release."
    );
  }

  if (!hasUsable3D && hasAcis) {
    conversionStatus = "acis-only-hard-error";
    warnings.push(
      `This DXF contains ${acisEntityCount} ACIS solid(s) (3DSOLID/BODY/REGION) with no supported mesh geometry. ` +
        "Re-export from Revit with solids as polymesh and display colours enabled."
    );
    exportAdvice =
      'In Revit DXF export options: set "Solids (3D views)" to "Polymesh" and enable element display colours.';
  } else if (!hasUsable3D) {
    conversionStatus = "no-usable-3d-geometry";
    const skippedTotal = Object.values(entities.skipped).reduce((a, b) => a + b, 0);
    if (skippedTotal > 0) {
      warnings.push("DXF contains only 2D or unsupported entities. No 3D mesh geometry found.");
      exportAdvice =
        "Ensure you are exporting a 3D view from Revit (not a floor plan). Check that the view contains visible solids or mesh elements.";
    } else {
      warnings.push("DXF appears to contain no geometry entities at all.");
    }
  } else if (hasUsable3D && hasAcis) {
    conversionStatus = "partial-with-warnings";
    warnings.push(
      `${acisEntityCount} ACIS solid(s) (3DSOLID/BODY/REGION) were detected and skipped. ` +
        `Re-export from Revit with "Solids (3D views)" set to "Polymesh" to include them.`
    );
  } else {
    conversionStatus = "ok";
  }

  return {
    schemaVersion: 1,
    sourceFormat: "dxf",
    converterBackend: "dxf-js",
    dxfVersion,
    sourceFileName: path.basename(sourcePath),
    sourceFileSizeBytes,
    entityCounts,
    skippedEntitySummary: entities.skipped,
    acisEntityCount,
    layerCount: Object.keys(layers).length,
    layers: layerSummaries,
    blockCount: Object.keys(blocks).length,
    blocks: blockSummaries,
    insertCount: entities.inserts.length,
    insertsByBlock,
    conversionStatus,
    warnings,
    exportAdvice,
  };
}

// ─── Optimization Report ──────────────────────────────────────────────────────

export function buildOptimizationReport(params: {
  sourcePath: string;
  parsedDxf: ParsedDxf;
  stats: OptimizationStats;
  rawGlbSizeBytes: number;
  displayGlbSizeBytes: number | null;
  materialsByLayer: Record<string, string[]>;
  timing: {
    parseMs: number;
    meshOptimizationMs: number;
    glbBuildMs: number;
    totalMs: number;
  };
  warnings: string[];
}): DxfOptimizationReport {
  const { parsedDxf, stats, rawGlbSizeBytes, displayGlbSizeBytes, materialsByLayer, timing, warnings, sourcePath } = params;
  const blocks = parsedDxf.blocks;

  const uniqueBlockDefinitions = Object.keys(blocks).length;
  const blockDefinitionsWithGeometry = Object.values(blocks).filter((b) => b.triangleCount > 0).length;
  const totalInstanceCount = parsedDxf.entities.inserts.length;

  const reductionPercent =
    displayGlbSizeBytes !== null && rawGlbSizeBytes > 0
      ? Number(((1 - displayGlbSizeBytes / rawGlbSizeBytes) * 100).toFixed(2))
      : null;

  return {
    schemaVersion: 1,
    converterBackend: "dxf-js",
    sourceFileName: path.basename(sourcePath),
    geometry: {
      rawTriangleCount: stats.rawTriangleCount,
      rawVertexCount: stats.rawVertexCount,
      outputTriangleCount: stats.outputTriangleCount,
      degenerateTrianglesRemoved: stats.degenerateTrianglesRemoved,
      outputVertexCount: stats.outputVertexCount,
      duplicateVerticesWelded: stats.duplicateVerticesWelded,
    },
    blocks: {
      uniqueBlockDefinitions,
      totalInstanceCount,
      blockDefinitionsWithGeometry,
      emptyBlockDefinitions: uniqueBlockDefinitions - blockDefinitionsWithGeometry,
    },
    materials: {
      uniqueMaterials: Object.values(materialsByLayer).reduce((s, v) => s + v.length, 0),
      materialsByLayer,
    },
    normals: { strategy: "flat", smoothAngleThreshold: null },
    glb: {
      rawSizeBytes: rawGlbSizeBytes,
      displaySizeBytes: displayGlbSizeBytes,
      reductionPercent,
    },
    timing,
    warnings,
  };
}

// ─── Stats and Manifest ───────────────────────────────────────────────────────

export function buildStats(params: {
  sourcePath: string;
  sourceFileSizeBytes: number;
  glbSizeBytes: number;
  parsedDxf: ParsedDxf;
  triangleCount: number;
  nodeCount: number;
  materialCount: number;
}): Record<string, unknown> {
  const { parsedDxf } = params;
  return {
    success: true,
    converterBackend: "dxf-js",
    sourceFormat: "dxf",
    dxfVersion: parsedDxf.dxfVersion,
    sourceFileName: path.basename(params.sourcePath),
    sourceFileSizeBytes: params.sourceFileSizeBytes,
    outputGlbSizeBytes: params.glbSizeBytes,
    triangleCount: params.triangleCount,
    nodeCount: params.nodeCount,
    materialCount: params.materialCount,
    blockCount: Object.keys(parsedDxf.blocks).length,
    instanceCount: parsedDxf.entities.inserts.length,
    layerCount: Object.keys(parsedDxf.layers).length,
    warningMessages: [],
    errorMessages: [],
  };
}

export function buildManifest(params: {
  slug: string;
  glbSizeBytes: number;
  parsedDxf: ParsedDxf;
  hasMeshoptReport: boolean;
}): Record<string, unknown> {
  return {
    slug: params.slug,
    status: "ready",
    displayFile: "display.glb",
    generatedBy: "converter-worker",
    generatedAt: new Date().toISOString(),
    converterBackend: "dxf-js",
    sourceFormat: "dxf",
    dxfVersion: params.parsedDxf.dxfVersion,
    artifacts: {
      displayGlb: "display.glb",
      manifest: "manifest.json",
      stats: "stats.json",
      materialDebug: "material-debug.json",
      formatReport: "format-report.json",
      dxfOptimizationReport: "dxf-optimization-report.json",
      conversionLog: "conversion.log",
      xcafReport: null,
      meshReport: null,
    },
  };
}
