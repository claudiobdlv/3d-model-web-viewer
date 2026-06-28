#!/usr/bin/env tsx
// FormatIQ DXF — local development CLI (NOT production).
// Converts a DXF file to GLB artifacts in a temp output directory.
//
// Usage:
//   npx tsx scripts/convert-dxf-fixture.ts <path/to/file.dxf> [outdir]
//
// Does NOT touch the app database or production storage.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convertDxfToGlb } from "../src/dxf/convertDxfToGlb.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const [, , inputArg, outputArg] = process.argv;

  if (!inputArg) {
    console.error("Usage: tsx scripts/convert-dxf-fixture.ts <file.dxf> [outdir]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputArg);
  if (!fs.existsSync(inputPath)) {
    console.error(`Error: input file not found: ${inputPath}`);
    process.exit(1);
  }

  const outputDir = outputArg
    ? path.resolve(outputArg)
    : await fs.promises.mkdtemp(path.join(os.tmpdir(), "dxf-convert-"));

  const slug = path.basename(inputPath, path.extname(inputPath));

  console.log(`Input:     ${inputPath}`);
  console.log(`Output:    ${path.join(outputDir, slug)}`);
  console.log("");

  try {
    const result = await convertDxfToGlb({ sourcePath: inputPath, outputDir, slug });
    console.log("Artifacts written:");
    for (const [key, filePath] of Object.entries(result)) {
      const stat = fs.statSync(filePath).size;
      console.log(`  ${key.padEnd(30)} ${filePath}  (${stat} bytes)`);
    }
    // Print conversion log
    const log = await fs.promises.readFile(result.conversionLogPath, "utf8");
    console.log("\nConversion log:\n" + log);
  } catch (err: unknown) {
    console.error("Conversion failed:", err instanceof Error ? err.message : String(err));
    // Print format-report if it was written
    const reportPath = path.join(outputDir, slug, "format-report.json");
    if (fs.existsSync(reportPath)) {
      const report = JSON.parse(await fs.promises.readFile(reportPath, "utf8"));
      console.error("\nFormat report:");
      console.error(JSON.stringify(report, null, 2));
    }
    process.exit(1);
  }
}

main();
