#!/usr/bin/env tsx
// Local-only, anonymized DXF structure inspector. It does not contact the app,
// database, upload API, or production storage, and writes only below .tmp/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDxf } from "../src/dxf/parseDxf.js";

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function sum(summary: Record<string, number>): number {
  return Object.values(summary).reduce((total, count) => total + count, 0);
}

async function main(): Promise<void> {
  const inputArg = process.argv[2];
  if (!inputArg) {
    console.error("Usage: npm run dxf:inspect -- <input.dxf> [output.json]");
    process.exitCode = 1;
    return;
  }

  const inputPath = path.resolve(inputArg);
  if (path.extname(inputPath).toLowerCase() !== ".dxf" || !fs.existsSync(inputPath)) {
    throw new Error("Input must be an existing .dxf file.");
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const tempRoot = path.join(repoRoot, ".tmp");
  const outputPath = path.resolve(process.argv[3] ?? path.join(tempRoot, "formatiq-inspection", "dxf-inspection.json"));
  if (!isInside(tempRoot, outputPath)) throw new Error("Inspection output must stay inside the repository .tmp directory.");

  const parsed = parseDxf(inputPath);
  const topSupported = parsed.entities.supported.filter((entity) => entity.triangleCount > 0).length;
  const blockSupported = Object.values(parsed.blocks).flatMap((block) => block.supported).filter((entity) => entity.triangleCount > 0).length;
  const allSupported = [...parsed.entities.supported, ...Object.values(parsed.blocks).flatMap((block) => block.supported)];
  const allAcis = [...parsed.entities.acis, ...Object.values(parsed.blocks).flatMap((block) => block.acis)];
  const allInserts = [...parsed.entities.inserts, ...Object.values(parsed.blocks).flatMap((block) => block.inserts)];
  const unsupported = parsed.diagnostics.unsupportedGeometry;
  const meshCount = allSupported.filter((entity) => entity.type === "MESH").length;
  const triangleCount = allSupported.reduce((total, entity) => total + entity.triangleCount, 0);
  const reason = triangleCount > 0
    ? "Supported polygon mesh geometry is present."
    : allAcis.length > 0
      ? "ACIS solid entities are present without a supported polygon mesh; ACIS conversion is intentionally unsupported."
      : meshCount > 0
        ? "MESH entities are present but contain no usable level-0 triangles; inspect mesh diagnostics."
        : unsupported.surfaceEntityCount > 0 || unsupported.proxyEntityCount > 0 || (unsupported.curveOrWireEntityCount > 0 && unsupported.hasNonZeroZ)
          ? "The file contains 3D surface/curve/wire/proxy geometry but no face or polygon-mesh records that can be triangulated safely."
          : sum(parsed.diagnostics.unsupportedEntitySummary) > 0
            ? "The file contains only 2D or other non-mesh entities; no usable 3D polygon mesh is present."
            : "No geometry entities were found.";

  const inspection = {
    schemaVersion: 1,
    source: "anonymized-local-dxf",
    dxfVersion: parsed.dxfVersion,
    fileSizeBytes: (await fs.promises.stat(inputPath)).size,
    topLevelEntityTypeCounts: parsed.diagnostics.topLevelEntityTypeCounts,
    blockEntityTypeCounts: parsed.diagnostics.blockEntityTypeCounts,
    skippedEntitySummary: parsed.diagnostics.unsupportedEntitySummary,
    topLevelSkippedEntitySummary: parsed.diagnostics.topLevelSkippedEntitySummary,
    blockSkippedEntitySummary: parsed.diagnostics.blockSkippedEntitySummary,
    unsupportedEntitiesWithCoordinates: parsed.diagnostics.unsupportedEntitiesWithCoordinates,
    unsupportedEntitiesWithNonZeroZ: parsed.diagnostics.unsupportedEntitiesWithNonZeroZ,
    polylineFlagDistribution: parsed.diagnostics.polylineFlagDistribution,
    vertexFlagDistribution: parsed.diagnostics.vertexFlagDistribution,
    unsupportedGeometry: parsed.diagnostics.unsupportedGeometry,
    acisCount: allAcis.length,
    meshCount,
    blockCount: Object.keys(parsed.blocks).length,
    insertCount: allInserts.length,
    supportedEntityCount: allSupported.length,
    triangleCount,
    geometryInsideBlocksOnly: topSupported === 0 && blockSupported > 0,
    reasonForZeroTriangles: triangleCount === 0 ? reason : null,
  };

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, `${JSON.stringify(inspection, null, 2)}\n`);
  console.log(JSON.stringify(inspection, null, 2));
  console.log(`Inspection written below .tmp/: ${path.relative(tempRoot, outputPath)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
