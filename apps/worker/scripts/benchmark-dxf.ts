#!/usr/bin/env tsx
// Manual-only synthetic FormatIQ benchmark. Generated DXFs and all outputs stay
// under the repository's ignored .tmp directory.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convertDxfToGlb } from "../src/dxf/convertDxfToGlb.js";

const pair = (code: number, value: string | number): string => `${code}\n${value}\n`;
const face = (handle: string, layer = "0", offset = 0): string =>
  pair(0, "3DFACE") + pair(5, handle) + pair(8, layer) + pair(62, 256) +
  pair(10, offset) + pair(20, 0) + pair(30, 0) +
  pair(11, offset + 1) + pair(21, 0) + pair(31, 0) +
  pair(12, offset) + pair(22, 1) + pair(32, 0) +
  pair(13, offset) + pair(23, 1) + pair(33, 0);

function insert(blockName: string, handle: string, x = 0, y = 0): string {
  return pair(0, "INSERT") + pair(5, handle) + pair(8, "0") + pair(2, blockName) + pair(10, x) + pair(20, y) + pair(30, 0);
}

function block(name: string, body: string): string {
  return pair(0, "BLOCK") + pair(8, "0") + pair(2, name) + pair(10, 0) + pair(20, 0) + pair(30, 0) + pair(70, 0) + body + pair(0, "ENDBLK");
}

function document(layers: string, blocks: string, entities: string): string {
  return pair(0, "SECTION") + pair(2, "HEADER") + pair(9, "$ACADVER") + pair(1, "AC1024") + pair(0, "ENDSEC") +
    pair(0, "SECTION") + pair(2, "TABLES") + pair(0, "TABLE") + pair(2, "LAYER") +
    pair(0, "LAYER") + pair(2, "0") + pair(62, 7) + layers + pair(0, "ENDTAB") + pair(0, "ENDSEC") +
    pair(0, "SECTION") + pair(2, "BLOCKS") + blocks + pair(0, "ENDSEC") +
    pair(0, "SECTION") + pair(2, "ENTITIES") + entities + pair(0, "ENDSEC") + pair(0, "EOF");
}

function repeatedInsertCase(count: number): string {
  const entities = Array.from({ length: count }, (_, index) => insert("UNIT", `I${index}`, index % 100, Math.floor(index / 100))).join("");
  return document("", block("UNIT", face("F1")), entities);
}

function nestedCase(topCount: number, depth: number): string {
  let blocks = block("N0", face("NF"));
  for (let level = 1; level <= depth; level++) blocks += block(`N${level}`, insert(`N${level - 1}`, `NI${level}`));
  const entities = Array.from({ length: topCount }, (_, index) => insert(`N${depth}`, `T${index}`, index % 50, Math.floor(index / 50))).join("");
  return document("", blocks, entities);
}

function mInsertCase(rows: number, columns: number): string {
  const entity = insert("GRID", "MG") + pair(70, columns) + pair(71, rows) + pair(44, 2) + pair(45, 2);
  return document("", block("GRID", face("GF")), entity);
}

function materialCase(count: number): string {
  const layers = Array.from({ length: count }, (_, index) =>
    pair(0, "LAYER") + pair(2, `MAT_${index}`) + pair(62, (index % 255) + 1)
  ).join("");
  const entities = Array.from({ length: count }, (_, index) => face(`MF${index}`, `MAT_${index}`, index * 2)).join("");
  return document(layers, "", entities);
}

function meshCase(segmentCount: number): string {
  let mesh = pair(0, "MESH") + pair(5, "CURVED") + pair(8, "0") + pair(71, 2) + pair(72, 0) + pair(91, 0);
  mesh += pair(92, segmentCount + 1) + pair(10, 0) + pair(20, 0) + pair(30, 0);
  for (let index = 0; index < segmentCount; index++) {
    const angle = (index / segmentCount) * Math.PI * 2;
    mesh += pair(10, Math.cos(angle).toFixed(8)) + pair(20, Math.sin(angle).toFixed(8)) + pair(30, (Math.sin(angle * 8) * 0.05).toFixed(8));
  }
  mesh += pair(93, segmentCount * 4);
  for (let index = 0; index < segmentCount; index++) {
    mesh += pair(90, 3) + pair(90, 0) + pair(90, index + 1) + pair(90, ((index + 1) % segmentCount) + 1);
  }
  mesh += pair(94, 0) + pair(95, 0);
  return document("", "", mesh);
}

async function main(): Promise<void> {
  const quick = process.argv.includes("--quick");
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const root = path.join(repoRoot, ".tmp", "formatiq-benchmarks", stamp);
  const sourceDir = path.join(root, "generated");
  const outputDir = path.join(root, "outputs");
  await fs.promises.mkdir(sourceDir, { recursive: true });
  await fs.promises.mkdir(outputDir, { recursive: true });

  const cases = [
    { name: "repeated-inserts", content: repeatedInsertCase(quick ? 200 : 2_000) },
    { name: "nested-blocks", content: nestedCase(quick ? 50 : 500, 6) },
    { name: "minsert-grid", content: mInsertCase(quick ? 10 : 80, quick ? 10 : 80) },
    { name: "many-materials", content: materialCase(quick ? 32 : 300) },
    { name: "curved-mesh", content: meshCase(quick ? 200 : 4_000) },
  ];
  const rows: Record<string, unknown>[] = [];

  for (const benchmark of cases) {
    const sourcePath = path.join(sourceDir, `${benchmark.name}.dxf`);
    await fs.promises.writeFile(sourcePath, benchmark.content);
    const memoryBefore = process.memoryUsage();
    const started = Date.now();
    let failure: string | null = null;
    try {
      await convertDxfToGlb({ sourcePath, outputDir, slug: benchmark.name, glbOptimizationMode: "meshopt" });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    const elapsedMs = Date.now() - started;
    const memoryAfter = process.memoryUsage();
    const reportPath = path.join(outputDir, benchmark.name, "dxf-optimization-report.json");
    const report = await fs.promises.readFile(reportPath, "utf8").then(JSON.parse).catch(() => null);
    const stats = await fs.promises.readFile(path.join(outputDir, benchmark.name, "stats.json"), "utf8").then(JSON.parse).catch(() => null);
    const benchmarkStats = {
      caseName: benchmark.name,
      sourceBytes: Buffer.byteLength(benchmark.content),
      elapsedMs,
      heapUsedBefore: memoryBefore.heapUsed,
      heapUsedAfter: memoryAfter.heapUsed,
      heapDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
      rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
      quick,
    };
    if (report) {
      report.syntheticBenchmark = benchmarkStats;
      await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
      await fs.promises.appendFile(
        path.join(outputDir, benchmark.name, "conversion.log"),
        `[DXF] Benchmark summary: ${benchmark.name}; total=${elapsedMs}ms; heapDelta=${benchmarkStats.heapDeltaBytes}; output=${report.glb?.displaySizeBytes ?? 0} bytes\n`
      );
    }
    rows.push({
      case: benchmark.name,
      status: failure ? "failed" : "ok",
      parseMs: report?.timing?.parseMs ?? null,
      traversalMs: report?.timing?.traversalMs ?? null,
      optimizationMs: report?.timing?.meshOptimizationMs ?? null,
      glbBuildMs: report?.timing?.glbBuildMs ?? null,
      meshoptMs: report?.timing?.meshoptMs ?? null,
      totalMs: report?.timing?.totalMs ?? elapsedMs,
      heapDeltaBytes: benchmarkStats.heapDeltaBytes,
      outputGlbBytes: report?.glb?.displaySizeBytes ?? 0,
      triangles: stats?.triangleCount ?? report?.geometry?.outputTriangleCount ?? 0,
      materials: report?.materials?.uniqueMaterials ?? 0,
      failure,
    });
  }

  console.table(rows);
  await fs.promises.writeFile(path.join(root, "benchmark-summary.json"), JSON.stringify({ quick, generatedAt: new Date().toISOString(), rows }, null, 2) + "\n");
  console.log(`Benchmark artifacts: ${root}`);
  if (rows.some((row) => row.status === "failed")) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
