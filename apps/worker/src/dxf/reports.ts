// FormatIQ DXF — report and manifest/stats file builders
import path from "node:path";
import type {
  ParsedDxf, DxfFormatReport, DxfOptimizationReport, DxfConversionStatus,
  OptimizationStats, DxfBlockTraversalSummary, DxfBlockReuseStats,
} from "./types.js";
import { resolveColor } from "./colors.js";
import { analyzeBlockTraversal } from "./blockTraversal.js";
import { isDefaultExtrusion } from "./ocs.js";
import { expandInsertInstances } from "./insertInstances.js";
import { DEFAULT_BLOCK_NESTING_LIMIT } from "./blockTraversal.js";

function analyzeLayer0Inheritance(parsedDxf: ParsedDxf): { count: number; summary: Record<string, number> } {
  let count = 0;
  const summary: Record<string, number> = {};

  function visit(insert: ParsedDxf["entities"]["inserts"][number], inheritedLayer: string | undefined, depth: number, stack: string[]): void {
    if (depth > DEFAULT_BLOCK_NESTING_LIMIT || stack.includes(insert.blockName)) return;
    const block = parsedDxf.blocks[insert.blockName];
    if (!block) return;
    const effectiveLayer = insert.layer === "0" && inheritedLayer ? inheritedLayer : insert.layer;
    for (const entity of block.supported) {
      if (entity.layer === "0" && effectiveLayer !== "0") {
        count++;
        summary[effectiveLayer] = (summary[effectiveLayer] ?? 0) + 1;
      }
    }
    for (const nested of block.inserts) {
      for (const _instance of expandInsertInstances(nested)) {
        visit(nested, effectiveLayer, depth + 1, [...stack, insert.blockName]);
      }
    }
  }

  for (const insert of parsedDxf.entities.inserts) {
    for (const _instance of expandInsertInstances(insert)) visit(insert, undefined, 1, []);
  }
  return { count, summary };
}

// ─── Format Report ────────────────────────────────────────────────────────────

export function buildFormatReport(params: {
  parsedDxf: ParsedDxf;
  sourcePath: string;
  sourceFileSizeBytes: number;
  traversal?: DxfBlockTraversalSummary;
}): DxfFormatReport {
  const { parsedDxf, sourcePath, sourceFileSizeBytes } = params;
  const { entities, blocks, layers, dxfVersion } = parsedDxf;
  const traversal = params.traversal ?? analyzeBlockTraversal(parsedDxf);

  // Entity counts
  const entityCounts = {
    "3DFACE": 0,
    POLYFACE_MESH: 0,
    POLYMESH: 0,
    MESH: 0,
    INSERT: entities.inserts.length,
    MINSERT: 0,
    "3DSOLID": 0,
    BODY: 0,
    REGION: 0,
  };
  const allSupported = [...entities.supported, ...Object.values(blocks).flatMap((block) => block.supported)];
  const allAcis = [...entities.acis, ...Object.values(blocks).flatMap((block) => block.acis)];
  const allInserts = [...entities.inserts, ...Object.values(blocks).flatMap((block) => block.inserts)];
  entityCounts.MINSERT = allInserts.filter((insert) => insert.type === "MINSERT").length;
  entityCounts.INSERT = allInserts.length - entityCounts.MINSERT;
  for (const e of allSupported) {
    if (e.type === "3DFACE") entityCounts["3DFACE"]++;
    else if (e.type === "POLYFACE_MESH") entityCounts["POLYFACE_MESH"]++;
    else if (e.type === "POLYMESH") entityCounts["POLYMESH"]++;
    else if (e.type === "MESH") entityCounts["MESH"]++;
  }
  for (const e of allAcis) {
    if (e.type === "3DSOLID") entityCounts["3DSOLID"]++;
    else if (e.type === "BODY") entityCounts["BODY"]++;
    else if (e.type === "REGION") entityCounts["REGION"]++;
  }

  const acisEntityCount = allAcis.length;

  // Insert summary
  const insertsByBlock: Record<string, number> = {};
  for (const ins of entities.inserts) {
    insertsByBlock[ins.blockName] = (insertsByBlock[ins.blockName] ?? 0) + expandInsertInstances(ins).length;
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
  const hasSupportedEntities = entities.supported.some((entity) => entity.triangleCount > 0);
  const hasInserts = entities.inserts.length > 0;
  const hasAcis = acisEntityCount > 0;
  // Also check if any block definitions have geometry (accessed via inserts)
  const anyBlockHasGeometry = hasInserts && traversal.reachableTriangleCount > 0;
  const hasUsable3D = hasSupportedEntities || anyBlockHasGeometry;

  let conversionStatus: DxfConversionStatus;
  const warnings: string[] = [];
  let exportAdvice: string | null = null;

  const meshEntityCount = entityCounts.MESH;
  const meshEntities = allSupported.filter((entity) => entity.type === "MESH");
  const meshTriangleCount = meshEntities.reduce((sum, entity) => sum + entity.triangleCount, 0);
  const invalidMeshFaceCount = meshEntities.reduce((sum, entity) => sum + entity.invalidFaceCount, 0);
  const meshDiagnostics = meshEntities.flatMap((entity) => entity.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    handle: entity.handle,
  })));
  if (meshEntityCount > 0) {
    if (meshTriangleCount > 0) {
      warnings.push(`${meshEntityCount} MESH entity/entities triangulated from R2010+ level-0 face lists (${meshTriangleCount} triangle(s)).`);
    }
    for (const diagnostic of meshDiagnostics) {
      warnings.push(`MESH${diagnostic.handle ? ` ${diagnostic.handle}` : ""} [${diagnostic.code}]: ${diagnostic.message}`);
    }
  }

  const extrusionEntities = [...allSupported, ...allInserts].filter((entity) => entity.hasExplicitExtrusion);
  const transformedEntityCount = extrusionEntities.filter((entity) => entity.ocsApplied).length;
  const unsupportedEntityCount = extrusionEntities.filter(
    (entity) => !entity.ocsApplied && !isDefaultExtrusion(entity.extrusion)
  ).length;
  if (unsupportedEntityCount > 0) {
    warnings.push(`${unsupportedEntityCount} unsupported MESH entity/entities include OCS extrusion data; orientation is reported but geometry is not converted.`);
  }
  warnings.push(...traversal.cycleWarnings, ...traversal.depthLimitWarnings, ...traversal.missingBlockWarnings);

  if (!hasUsable3D && hasAcis) {
    conversionStatus = "acis-only-hard-error";
    warnings.push(
      `This DXF contains ${acisEntityCount} ACIS solid(s) (3DSOLID/BODY/REGION) with no supported mesh geometry. ` +
        "Re-export a dedicated Revit 3D view with Solids set to Polymesh and Colours set to By element/display colours. Avoid ACIS solids."
    );
    exportAdvice =
      "Export a dedicated Revit 3D view with Solids set to Polymesh and Colours set to By element/display colours. Avoid ACIS solids.";
  } else if (!hasUsable3D) {
    conversionStatus = "no-usable-3d-geometry";
    const skippedTotal = Object.values(entities.skipped).reduce((a, b) => a + b, 0);
    if (meshEntityCount > 0) {
      warnings.push("DXF MESH entities contained no usable level-0 triangles; review the MESH diagnostics above.");
      exportAdvice = "Re-export a level-0 polygon mesh or repair the malformed MESH vertex/face lists in the source application.";
    } else if (skippedTotal > 0) {
      warnings.push("DXF contains only 2D or unsupported entities. No 3D mesh geometry found.");
      exportAdvice =
        "Export a dedicated Revit 3D view with Solids set to Polymesh and Colours set to By element/display colours. Avoid ACIS solids.";
      warnings.push(exportAdvice);
    } else {
      warnings.push("DXF appears to contain no geometry entities at all.");
    }
  } else if (hasUsable3D && hasAcis) {
    conversionStatus = "partial-with-warnings";
    warnings.push(
      `${acisEntityCount} ACIS solid(s) (3DSOLID/BODY/REGION) were detected and skipped. ` +
        `Re-export from Revit with "Solids (3D views)" set to "Polymesh" to include them.`
    );
  } else if (traversal.cycleWarnings.length > 0 || traversal.depthLimitWarnings.length > 0 || meshDiagnostics.length > 0) {
    conversionStatus = "partial-with-warnings";
  } else {
    conversionStatus = "ok";
  }

  const layer0Inheritance = analyzeLayer0Inheritance(parsedDxf);

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
    mInsertCount: entityCounts.MINSERT,
    expandedMInsertInstanceCount: traversal.expandedMInsertInstanceCount,
    insertsByBlock,
    nestedInsertCount: traversal.nestedInsertCount,
    maxBlockNestingDepth: traversal.maxBlockNestingDepth,
    blockCycleWarningCount: traversal.cycleWarnings.length,
    blockDepthLimitWarningCount: traversal.depthLimitWarnings.length,
    mesh: {
      triangulationStatus: meshEntityCount === 0 ? "not-present" : meshTriangleCount > 0 ? "triangulated" : "detected-invalid",
      entityCount: meshEntityCount,
      triangulatedEntityCount: meshEntities.filter((entity) => entity.triangleCount > 0).length,
      triangleCount: meshTriangleCount,
      invalidFaceCount: invalidMeshFaceCount,
      malformedWarningCount: meshDiagnostics.length,
      diagnostics: meshDiagnostics,
    },
    malformedMeshWarningCount: meshDiagnostics.length,
    layer0InheritedEntityCount: layer0Inheritance.count,
    inheritedLayerSummary: layer0Inheritance.summary,
    ocs: {
      explicitExtrusionEntityCount: extrusionEntities.length,
      transformedEntityCount,
      unsupportedEntityCount,
      unsupportedWarningCount: unsupportedEntityCount,
    },
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
    traversalMs: number;
    meshOptimizationMs: number;
    glbBuildMs: number;
    totalMs: number;
    meshoptMs: number;
  };
  meshopt: DxfOptimizationReport["meshopt"];
  traversal: DxfBlockTraversalSummary;
  blockReuse: DxfBlockReuseStats;
  warnings: string[];
}): DxfOptimizationReport {
  const { parsedDxf, stats, rawGlbSizeBytes, displayGlbSizeBytes, materialsByLayer, timing, warnings, sourcePath, meshopt, traversal, blockReuse } = params;
  const blocks = parsedDxf.blocks;

  const uniqueBlockDefinitions = Object.keys(blocks).length;
  function blockHasReachableGeometry(blockName: string, stack: string[] = []): boolean {
    if (stack.includes(blockName)) return false;
    const block = blocks[blockName];
    if (!block) return false;
    if (block.triangleCount > 0) return true;
    return block.inserts.some((insert) => blockHasReachableGeometry(insert.blockName, [...stack, blockName]));
  }
  const blockDefinitionsWithGeometry = Object.keys(blocks).filter((name) => blockHasReachableGeometry(name)).length;
  const totalInstanceCount = traversal.renderedInsertCount;

  const reductionPercent =
    displayGlbSizeBytes !== null && rawGlbSizeBytes > 0
      ? Number(((1 - displayGlbSizeBytes / rawGlbSizeBytes) * 100).toFixed(2))
      : null;
  const uniqueMaterials = Object.values(materialsByLayer).reduce((s, v) => s + v.length, 0);
  const cardinalityWarning = uniqueMaterials > 256
    ? `High DXF material cardinality (${uniqueMaterials}); consider consolidating source layers/colours before rollout.`
    : null;
  const reportWarnings = cardinalityWarning ? [...warnings, cardinalityWarning] : warnings;

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
      nestedInstanceCount: traversal.nestedInsertCount,
      blockDefinitionsWithGeometry,
      emptyBlockDefinitions: uniqueBlockDefinitions - blockDefinitionsWithGeometry,
      uniqueRenderedMeshes: blockReuse.uniqueRenderedMeshes,
      reusedBlockMeshCount: blockReuse.reusedBlockMeshCount,
      geometryDuplicationAvoidedTriangles: blockReuse.geometryDuplicationAvoidedTriangles,
      expandedMInsertInstanceCount: traversal.expandedMInsertInstanceCount,
    },
    materials: {
      uniqueMaterials,
      materialsByLayer,
      cardinalityWarning,
    },
    normals: { strategy: "flat", smoothAngleThreshold: null },
    glb: {
      rawSizeBytes: rawGlbSizeBytes,
      displaySizeBytes: displayGlbSizeBytes,
      reductionPercent,
    },
    meshopt,
    timing,
    warnings: reportWarnings,
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
