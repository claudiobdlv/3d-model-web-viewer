// FormatIQ DXF — top-level converter orchestrator
// Internal/test-only for Phase 2A. Not wired into the production upload route.
import fs from "node:fs";
import path from "node:path";
import type { ConvertDxfInput, ConvertDxfOutput, OptimizationStats } from "./types.js";
import { parseDxf } from "./parseDxf.js";
import { extractAllTriangles } from "./geometry.js";
import { optimizeMesh } from "./meshOptimize.js";
import { buildGlb } from "./buildGlb.js";
import { buildFormatReport, buildOptimizationReport, buildStats, buildManifest } from "./reports.js";
import { optimizeDisplayGlb } from "../glbOptimizer.js";

async function appendLog(logPath: string, msg: string): Promise<void> {
  await fs.promises.appendFile(logPath, msg).catch(() => {});
}

export async function convertDxfToGlb(input: ConvertDxfInput): Promise<ConvertDxfOutput> {
  const totalStart = Date.now();
  const { sourcePath, outputDir, slug } = input;
  const glbOptimizationMode = input.glbOptimizationMode ?? "meshopt";

  const jobDir = path.join(outputDir, slug);
  await fs.promises.mkdir(jobDir, { recursive: true });

  const logPath = path.join(jobDir, "conversion.log");
  const displayGlbPath = path.join(jobDir, "display.glb");
  const rawGlbPath = path.join(jobDir, "display.raw.glb");
  const manifestPath = path.join(jobDir, "manifest.json");
  const statsPath = path.join(jobDir, "stats.json");
  const materialDebugPath = path.join(jobDir, "material-debug.json");
  const formatReportPath = path.join(jobDir, "format-report.json");
  const dxfOptimizationReportPath = path.join(jobDir, "dxf-optimization-report.json");

  await fs.promises.writeFile(logPath, "");
  throwIfAborted(input.signal);
  await input.onProgress?.(15, "Converting DXF - parsing geometry");

  const sourceStat = await fs.promises.stat(sourcePath);
  const sourceFileSizeBytes = sourceStat.size;
  const sourceFileName = path.basename(sourcePath);

  await appendLog(logPath, `[DXF] Parsing ${sourceFileName} (${(sourceFileSizeBytes / 1024 / 1024).toFixed(2)} MB)\n`);

  // ── Parse ─────────────────────────────────────────────────────────────────
  const parseStart = Date.now();
  let parsedDxf;
  try {
    parsedDxf = parseDxf(sourcePath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await appendLog(logPath, `[DXF] Parse error: ${msg}\n`);
    throw new Error(`DXF parse failed: ${msg}`);
  }
  const parseMs = Date.now() - parseStart;

  await appendLog(logPath, `[DXF] DXF version: ${parsedDxf.dxfVersion ?? "unknown"}\n`);
  await appendLog(logPath, `[DXF] LAYER table: ${Object.keys(parsedDxf.layers).length} layer(s)\n`);
  await appendLog(logPath, `[DXF] BLOCKS section: ${Object.keys(parsedDxf.blocks).length} block definition(s)\n`);

  const ec = parsedDxf.entities;
  await appendLog(
    logPath,
    `[DXF] ENTITIES: ${ec.supported.length} supported, ${ec.inserts.length} INSERT(s), ${ec.acis.length} ACIS\n`
  );

  if (ec.acis.length > 0) {
    await appendLog(
      logPath,
      `[DXF] ACIS entities detected: ${ec.acis.length} — will be skipped\n`
    );
  }

  // ── Build format report (early, before potentially throwing) ───────────────
  const formatReport = buildFormatReport({ parsedDxf, sourcePath, sourceFileSizeBytes });
  await fs.promises.writeFile(formatReportPath, JSON.stringify(formatReport, null, 2) + "\n");

  if (formatReport.conversionStatus === "acis-only-hard-error") {
    const warning = formatReport.warnings[0] ?? "ACIS-only file.";
    await appendLog(logPath, `[DXF] ERROR: ${warning}\n`);
    // Write minimal stats/manifest so callers can inspect the report
    const emptyStats = buildStats({ sourcePath, sourceFileSizeBytes, glbSizeBytes: 0, parsedDxf, triangleCount: 0, nodeCount: 0, materialCount: 0 });
    await fs.promises.writeFile(statsPath, JSON.stringify(emptyStats, null, 2) + "\n");
    await fs.promises.writeFile(manifestPath, JSON.stringify(buildManifest({ slug, glbSizeBytes: 0, parsedDxf, hasMeshoptReport: false }), null, 2) + "\n");
    await fs.promises.writeFile(materialDebugPath, JSON.stringify({ converterBackend: "dxf-js", materialRules: "none", materials: [] }, null, 2) + "\n");
    // Write an empty GLB placeholder so file checks don't crash
    await fs.promises.writeFile(displayGlbPath, Buffer.alloc(0));
    throw new Error(`DXF conversion failed: ${warning}`);
  }

  if (formatReport.conversionStatus === "no-usable-3d-geometry") {
    const warning = `No usable 3D geometry. ${formatReport.warnings.join(" ")}`;
    await appendLog(logPath, `[DXF] ERROR: ${warning}\n`);
    throw new Error(`DXF conversion failed: ${warning}`);
  }

  // ── Mesh optimization ─────────────────────────────────────────────────────
  const optStart = Date.now();

  // Ungrouped entity triangles
  const entityTriangles = extractAllTriangles(ec.supported);
  const { stats: entityStats } = optimizeMesh(entityTriangles);

  // Block definition triangles (for reporting totals)
  let blockRawTriangles = 0;
  for (const block of Object.values(parsedDxf.blocks)) {
    const tris = extractAllTriangles(block.supported);
    blockRawTriangles += tris.length;
  }

  // Combined stats for reporting
  const combinedStats: OptimizationStats = {
    rawTriangleCount: entityStats.rawTriangleCount + blockRawTriangles,
    rawVertexCount: entityStats.rawVertexCount + blockRawTriangles * 3,
    degenerateTrianglesRemoved: entityStats.degenerateTrianglesRemoved,
    duplicateVerticesWelded: entityStats.duplicateVerticesWelded,
    outputTriangleCount: entityStats.outputTriangleCount,
    outputVertexCount: entityStats.outputVertexCount,
  };

  const meshOptimizationMs = Date.now() - optStart;

  // ── Build GLB ─────────────────────────────────────────────────────────────
  const glbStart = Date.now();
  throwIfAborted(input.signal);
  await input.onProgress?.(55, "Converting DXF - building GLB");
  const glbResult = await buildGlb(parsedDxf);
  const glbBuildMs = Date.now() - glbStart;
  const rawGlbSizeBytes = glbResult.glbBytes.length;

  await fs.promises.writeFile(rawGlbPath, glbResult.glbBytes);

  await appendLog(
    logPath,
    `[DXF] GLB built: ${glbResult.nodeCount} nodes, ${glbResult.materialCount} materials, ${glbResult.triangleCount} triangles, ${rawGlbSizeBytes} bytes\n`
  );
  throwIfAborted(input.signal);
  await input.onProgress?.(80, glbOptimizationMode === "meshopt" ? "Optimizing DXF GLB" : "Publishing DXF GLB");
  const meshoptStart = Date.now();
  const optimization = await optimizeDisplayGlb({
    requestedMode: glbOptimizationMode,
    rawGlbPath,
    displayGlbPath,
    conversionLogPath: logPath,
  });
  const meshoptMs = Date.now() - meshoptStart;
  const totalMs = Date.now() - totalStart;
  await appendLog(logPath, `[DXF] GLB optimization: ${optimization.status}; ${optimization.rawSizeBytes} -> ${optimization.displaySizeBytes} bytes\n`);
  await appendLog(logPath, `[DXF] Completed in ${(totalMs / 1000).toFixed(2)}s\n`);

  // ── Material debug ────────────────────────────────────────────────────────
  const materialsByLayer: Record<string, string[]> = {};
  for (const material of glbResult.materials) {
    const colors = materialsByLayer[material.layer] ?? [];
    if (!colors.includes(material.colorHex)) colors.push(material.colorHex);
    materialsByLayer[material.layer] = colors;
  }
  const materialDebug = { converterBackend: "dxf-js", materialRules: "dxf-layer-color-with-byblock-inheritance", materials: glbResult.materials };
  await fs.promises.writeFile(materialDebugPath, JSON.stringify(materialDebug, null, 2) + "\n");

  // ── Stats ─────────────────────────────────────────────────────────────────
  const statsObj = buildStats({
    sourcePath,
    sourceFileSizeBytes,
    glbSizeBytes: optimization.displaySizeBytes,
    parsedDxf,
    triangleCount: glbResult.triangleCount,
    nodeCount: glbResult.nodeCount,
    materialCount: glbResult.materialCount,
  });
  Object.assign(statsObj, {
    optimization: {
      requestedMode: optimization.requestedMode,
      status: optimization.status,
      rawSizeBytes: optimization.rawSizeBytes,
      displaySizeBytes: optimization.displaySizeBytes,
      reductionPercent: optimization.rawSizeBytes > 0
        ? Number(((1 - optimization.displaySizeBytes / optimization.rawSizeBytes) * 100).toFixed(2))
        : 0,
      validation: optimization.validation,
      fallbackUsed: optimization.fallbackUsed,
      message: optimization.message,
    },
    warningMessages: formatReport.warnings,
  });
  await fs.promises.writeFile(statsPath, JSON.stringify(statsObj, null, 2) + "\n");

  // ── Manifest ──────────────────────────────────────────────────────────────
  const manifest = buildManifest({ slug, glbSizeBytes: optimization.displaySizeBytes, parsedDxf, hasMeshoptReport: optimization.status === "applied" });
  Object.assign(manifest, { optimization: (statsObj as Record<string, unknown>).optimization });
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  // ── DXF optimization report ───────────────────────────────────────────────
  const optReport = buildOptimizationReport({
    sourcePath,
    parsedDxf,
    stats: combinedStats,
    rawGlbSizeBytes,
    displayGlbSizeBytes: optimization.displaySizeBytes,
    materialsByLayer,
    timing: { parseMs, meshOptimizationMs, glbBuildMs, meshoptMs, totalMs },
    meshopt: {
      requestedMode: optimization.requestedMode,
      status: optimization.status,
      validationPassed: optimization.validation.passed,
      fallbackUsed: optimization.fallbackUsed,
      message: optimization.message,
    },
    warnings: formatReport.warnings,
  });
  await fs.promises.writeFile(dxfOptimizationReportPath, JSON.stringify(optReport, null, 2) + "\n");

  return {
    displayGlbPath,
    manifestPath,
    statsPath,
    materialDebugPath,
    formatReportPath,
    dxfOptimizationReportPath,
    conversionLogPath: logPath,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("DXF conversion cancelled.", "AbortError");
}
