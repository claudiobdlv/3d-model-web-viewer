#!/usr/bin/env tsx
// Local-only FormatIQ compatibility harness. It reads private DXFs from an
// ignored folder and writes conversion artifacts to another ignored folder.
// It never contacts the app server, database, production storage, or upload API.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convertDxfToGlb } from "../src/dxf/convertDxfToGlb.js";

type SummaryRow = {
  filename: string;
  status: string;
  entityCounts: string;
  acisCount: number;
  meshCount: number;
  blockCount: number;
  insertCount: number;
  triangleCount: number;
  materialCount: number;
  rawGlbBytes: number;
  displayGlbBytes: number;
  conversionMs: number;
  warnings: string;
};

function safeSlug(filename: string, index: number): string {
  const stem = path.basename(filename, path.extname(filename)).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "");
  return `${String(index + 1).padStart(3, "0")}-${stem || "sample"}`;
}

async function readJson(filePath: string): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const samplesDir = path.resolve(process.argv[2] ?? path.join(repoRoot, ".tmp", "formatiq-private-samples"));
  const outputDir = path.resolve(process.argv[3] ?? path.join(repoRoot, ".tmp", "formatiq-compatibility-results"));
  await fs.promises.mkdir(samplesDir, { recursive: true });
  await fs.promises.mkdir(outputDir, { recursive: true });

  const filenames = (await fs.promises.readdir(samplesDir))
    .filter((name) => path.extname(name).toLowerCase() === ".dxf")
    .sort((a, b) => a.localeCompare(b));
  if (filenames.length === 0) {
    console.log(`No .dxf files found in ${samplesDir}`);
    console.log("Place private samples there locally; the directory is git-ignored.");
    return;
  }

  const rows: SummaryRow[] = [];
  for (const [index, filename] of filenames.entries()) {
    const sourcePath = path.join(samplesDir, filename);
    const slug = safeSlug(filename, index);
    const started = Date.now();
    let failure = "";
    try {
      await convertDxfToGlb({ sourcePath, outputDir, slug, glbOptimizationMode: "meshopt" });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    const jobDir = path.join(outputDir, slug);
    const report = await readJson(path.join(jobDir, "format-report.json"));
    const stats = await readJson(path.join(jobDir, "stats.json"));
    const optimization = await readJson(path.join(jobDir, "dxf-optimization-report.json"));
    const rawStat = await fs.promises.stat(path.join(jobDir, "display.raw.glb")).catch(() => null);
    const displayStat = await fs.promises.stat(path.join(jobDir, "display.glb")).catch(() => null);
    const entityCounts = report?.entityCounts ?? {};
    rows.push({
      filename,
      status: report?.conversionStatus ?? (failure ? "failed" : "unknown"),
      entityCounts: Object.entries(entityCounts).filter(([, count]) => Number(count) > 0).map(([type, count]) => `${type}:${count}`).join(" "),
      acisCount: Number(report?.acisEntityCount ?? 0),
      meshCount: Number(entityCounts.MESH ?? 0),
      blockCount: Number(report?.blockCount ?? 0),
      insertCount: Number(optimization?.blocks?.totalInstanceCount ?? report?.insertCount ?? 0),
      triangleCount: Number(stats?.triangleCount ?? report?.mesh?.triangleCount ?? 0),
      materialCount: Number(stats?.materialCount ?? 0),
      rawGlbBytes: rawStat?.size ?? 0,
      displayGlbBytes: displayStat?.size ?? 0,
      conversionMs: Date.now() - started,
      warnings: [...(report?.warnings ?? []), ...(failure ? [failure] : [])].join(" | "),
    });
  }

  console.table(rows);
  const summaryPath = path.join(outputDir, "compatibility-summary.json");
  await fs.promises.writeFile(summaryPath, JSON.stringify({ samplesDir, outputDir, generatedAt: new Date().toISOString(), rows }, null, 2) + "\n");
  console.log(`Summary: ${summaryPath}`);
  if (rows.some((row) => !["ok", "partial-with-warnings"].includes(row.status))) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
