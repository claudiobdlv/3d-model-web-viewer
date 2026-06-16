import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type ConverterProcessorInput = {
  slug: string;
  sourcePath: string;
  outputDir: string;
  converterBackend: "occt-js" | "xcaf-baseline";
  converterCli: string;
  xcafConverterBin: string;
  xcafColourMode: "xcaf-baseline" | "step-presentation";
  quality: string;
};

export type ConverterProcessorOutput = {
  displayGlbPath: string;
  manifestPath: string;
  statsPath: string;
  materialDebugPath: string;
  conversionLogPath: string;
  xcafReportPath?: string;
};

export async function convertStepJob(input: ConverterProcessorInput): Promise<ConverterProcessorOutput> {
  const jobDir = path.join(input.outputDir, input.slug);
  fs.mkdirSync(jobDir, { recursive: true });

  console.log(`Converter backend: ${input.converterBackend}`);
  console.log(`Converter input path: ${input.sourcePath}`);
  console.log(`Converter output path: ${jobDir}`);
  console.log(`Converter quality: ${input.quality}`);

  if (input.converterBackend === "occt-js") {
    await runOcctJsConverter({
      converterCli: input.converterCli,
      sourcePath: input.sourcePath,
      outputDir: jobDir,
      quality: input.quality
    });
  } else {
    await runXcafBaselineConverter({
      xcafConverterBin: input.xcafConverterBin,
      sourcePath: input.sourcePath,
      outputDir: jobDir,
      quality: input.quality,
      xcafColourMode: input.xcafColourMode
    });
  }

  const rawGlbPath = path.join(jobDir, "display.raw.glb");
  const displayGlbPath = path.join(jobDir, "display.glb");
  const statsPath = path.join(jobDir, "stats.json");
  const materialDebugPath = path.join(jobDir, "material-debug.json");
  const conversionLogPath = path.join(jobDir, "conversion.log");
  const xcafReportPath = path.join(jobDir, "xcaf-report.json");

  if (input.converterBackend === "occt-js") {
    await assertFile(rawGlbPath, "occt-js converter did not produce display.raw.glb");
    await fs.promises.copyFile(rawGlbPath, displayGlbPath);
    await assertFile(materialDebugPath, "occt-js converter did not produce material-debug.json");
  } else {
    await assertFile(displayGlbPath, "xcaf-baseline converter did not produce display.glb");
    await assertFile(xcafReportPath, "xcaf-baseline converter did not produce xcaf-report.json");
    await writeXcafCompatibilityFiles({
      reportPath: xcafReportPath,
      statsPath,
      materialDebugPath,
      sourcePath: input.sourcePath,
      displayGlbPath,
      quality: input.quality
    });
  }

  await assertFile(statsPath, "converter did not produce stats.json");
  await assertFile(conversionLogPath, "converter did not produce conversion.log");

  const now = new Date().toISOString();
  const manifestPath = path.join(jobDir, "manifest.json");
  await fs.promises.writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        slug: input.slug,
        status: "ready",
        displayFile: "display.glb",
        generatedBy: "converter-worker",
        generatedAt: now,
        quality: input.quality,
        converterBackend: input.converterBackend
      },
      null,
      2
    )}\n`
  );

  return {
    displayGlbPath,
    manifestPath,
    statsPath,
    materialDebugPath,
    conversionLogPath,
    xcafReportPath: input.converterBackend === "xcaf-baseline" ? xcafReportPath : undefined
  };
}

function runOcctJsConverter(input: {
  converterCli: string;
  sourcePath: string;
  outputDir: string;
  quality: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        input.converterCli,
        "--input",
        input.sourcePath,
        "--outdir",
        input.outputDir,
        "--quality",
        input.quality
      ],
      {
        stdio: ["ignore", "inherit", "inherit"]
      }
    );

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`converter exited with code ${code ?? "unknown"}`));
    });
  });
}

async function runXcafBaselineConverter(input: {
  xcafConverterBin: string;
  sourcePath: string;
  outputDir: string;
  quality: string;
  xcafColourMode: "xcaf-baseline" | "step-presentation";
}): Promise<void> {
  const stat = await fs.promises.stat(input.xcafConverterBin).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new Error(`xcaf-baseline converter binary is missing: ${input.xcafConverterBin}`);
  }

  const nativeQuality = input.quality === "fast"
    ? "preview"
    : input.quality === "detailed"
      ? "high"
      : input.quality;

  console.log(`XCAF colour mode: ${input.xcafColourMode}`);
  console.log("Converter colour space: raw");
  console.log(`Native XCAF binary: ${input.xcafConverterBin}`);
  console.log(`Native XCAF quality: ${nativeQuality}`);

  await spawnProcess(input.xcafConverterBin, [
    input.sourcePath,
    input.outputDir,
    nativeQuality,
    "--colour-mode",
    input.xcafColourMode,
    "--colour-space",
    "raw"
  ]);

  const conversionLogPath = path.join(input.outputDir, "conversion.log");
  const existingLog = await fs.promises.readFile(conversionLogPath, "utf8").catch(() => "");
  const header = [
    `Converter backend: xcaf-baseline`,
    `Input path: ${input.sourcePath}`,
    `Output path: ${input.outputDir}`,
    `Quality: ${input.quality}`,
    `Native quality: ${nativeQuality}`,
    `XCAF colour mode: ${input.xcafColourMode}`,
    `Colour space: raw`,
    `Material rules: disabled for xcaf-baseline`,
    ""
  ].join("\n");
  await fs.promises.writeFile(conversionLogPath, `${header}${existingLog}`);
}

function spawnProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "inherit", "inherit"]
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function writeXcafCompatibilityFiles(input: {
  reportPath: string;
  statsPath: string;
  materialDebugPath: string;
  sourcePath: string;
  displayGlbPath: string;
  quality: string;
}): Promise<void> {
  const report = JSON.parse(await fs.promises.readFile(input.reportPath, "utf8")) as {
    openCascadeVersion?: string;
    summary?: Record<string, unknown>;
    quality?: { preset?: string };
    colourMode?: { mode?: string };
    colourSpace?: { mode?: string };
    finalGlbColourAudit?: unknown;
    colouredPrimitivesBySource?: unknown;
    rawStepStyleResolver?: unknown;
    componentsStayedDefaultGrey?: unknown;
  };
  const sourceStat = await fs.promises.stat(input.sourcePath);
  const glbStat = await fs.promises.stat(input.displayGlbPath);

  const stats = {
    success: true,
    converterBackend: "xcaf-baseline",
    sourceFileName: path.basename(input.sourcePath),
    sourceFileSizeBytes: sourceStat.size,
    outputGlbSizeBytes: glbStat.size,
    qualityPreset: input.quality,
    nativeQualityPreset: report.quality?.preset,
    openCascadeVersion: report.openCascadeVersion,
    colourMode: report.colourMode?.mode,
    colourSpace: report.colourSpace?.mode,
    triangleCount: report.summary?.triangles ?? 0,
    nodeCount: report.summary?.nodeCount ?? 0,
    meshCount: report.summary?.meshesPrimitivesExported ?? report.summary?.primitiveCount ?? 0,
    materialCount: report.summary?.materialCount ?? 0,
    processingSeconds: report.summary?.conversionSeconds ?? 0,
    xcafSummary: report.summary ?? {},
    warningMessages: [],
    errorMessages: []
  };

  const materialDebug = {
    converterBackend: "xcaf-baseline",
    materialRules: "disabled",
    colourMode: report.colourMode,
    colourSpace: report.colourSpace,
    finalGlbColourAudit: report.finalGlbColourAudit ?? [],
    colouredPrimitivesBySource: report.colouredPrimitivesBySource ?? {},
    rawStepStyleResolver: report.rawStepStyleResolver ?? {},
    componentsStayedDefaultGrey: report.componentsStayedDefaultGrey ?? [],
    xcafReportFile: "xcaf-report.json"
  };

  await fs.promises.writeFile(input.statsPath, `${JSON.stringify(stats, null, 2)}\n`);
  await fs.promises.writeFile(input.materialDebugPath, `${JSON.stringify(materialDebug, null, 2)}\n`);
}

async function assertFile(filePath: string, message: string): Promise<void> {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile() || stat.size === 0) {
    throw new Error(message);
  }
}
