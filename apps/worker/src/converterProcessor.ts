import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  nativeDeflections,
  nativeQualityPreset,
  occtJsQualityPreset,
  type ConversionQuality,
  type NativeQualityPreset
} from "./quality.js";

import type { GlbOptimizationMode } from "./glbOptimizer.js";

export type ConverterProcessorInput = {
  slug: string;
  sourcePath: string;
  outputDir: string;
  converterBackend: "occt-js" | "xcaf-baseline";
  converterCli: string;
  xcafConverterBin: string;
  xcafColourMode: "xcaf-baseline" | "step-presentation";
  quality: ConversionQuality;
  glbOptimizationMode: GlbOptimizationMode;
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
  const nativePreset = nativeQualityPreset(input.quality);
  console.log(`Semantic quality: ${input.quality}`);
  console.log(`Native preset: ${nativePreset}`);

  if (input.converterBackend === "occt-js") {
    await runOcctJsConverter({
      converterCli: input.converterCli,
      sourcePath: input.sourcePath,
      outputDir: jobDir,
      quality: occtJsQualityPreset(input.quality)
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

  let nativeQualityDetails: NativeQualityDetails = {
    preset: nativePreset,
    linearDeflection: nativeDeflections[nativePreset].linear,
    angularDeflection: nativeDeflections[nativePreset].angular,
    relative: true
  };

  if (input.converterBackend === "occt-js") {
    await assertFile(rawGlbPath, "occt-js converter did not produce display.raw.glb");
    await assertFile(materialDebugPath, "occt-js converter did not produce material-debug.json");
  } else {
    await assertFile(displayGlbPath, "xcaf-baseline converter did not produce display.glb");
    await assertFile(xcafReportPath, "xcaf-baseline converter did not produce xcaf-report.json");
    nativeQualityDetails = await writeXcafCompatibilityFiles({
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

  let optimizationResult: any = null;

  if (input.glbOptimizationMode === "meshopt") {
    if (input.converterBackend === "xcaf-baseline") {
      await fs.promises.rename(displayGlbPath, rawGlbPath);
    }
    try {
      const { optimizeDisplayGlb } = await import("./glbOptimizer.js");
      optimizationResult = await optimizeDisplayGlb({
        requestedMode: "meshopt",
        rawGlbPath,
        displayGlbPath,
        conversionLogPath
      });
    } catch (optError) {
      console.error("GLB optimizer threw exception:", optError);
      await fs.promises.copyFile(rawGlbPath, displayGlbPath);
      const rawSize = (await fs.promises.stat(rawGlbPath)).size;
      optimizationResult = {
        requestedMode: "meshopt",
        status: "failed",
        tool: "@gltf-transform direct APIs + meshoptimizer",
        toolVersion: "4.4.0 / 1.0.1",
        quantization: { position: 16, normal: 12, texcoord: 14, generic: 16, color: 8 },
        rawSizeBytes: rawSize,
        displaySizeBytes: rawSize,
        requiresMeshoptDecoder: false,
        validation: { passed: false, message: optError instanceof Error ? optError.message : String(optError) },
        fallbackUsed: true,
        message: `Optimizer exception: ${optError instanceof Error ? optError.message : String(optError)}`
      };
      await fs.promises.appendFile(conversionLogPath, `\nGLB optimization exception: ${optError}\n`);
    }
  } else {
    if (input.converterBackend === "occt-js") {
      await fs.promises.copyFile(rawGlbPath, displayGlbPath);
    }
    const rawSize = (await fs.promises.stat(displayGlbPath)).size;
    optimizationResult = {
      requestedMode: "disabled",
      status: "disabled",
      tool: "@gltf-transform direct APIs + meshoptimizer",
      toolVersion: "4.4.0 / 1.0.1",
      quantization: { position: 16, normal: 12, texcoord: 14, generic: 16, color: 8 },
      rawSizeBytes: rawSize,
      displaySizeBytes: rawSize,
      requiresMeshoptDecoder: false,
      validation: { passed: false, message: "not run because optimization is disabled" },
      fallbackUsed: false,
      message: "Meshopt optimization disabled; published raw GLB."
    };
  }

  const reductionPercent = optimizationResult.rawSizeBytes > 0
    ? Number(((1 - optimizationResult.displaySizeBytes / optimizationResult.rawSizeBytes) * 100).toFixed(2))
    : 0;

  // Update stats.json to reflect the final display.glb size (optimized or fallback/disabled size) and include optimization metadata
  const statsContent = await fs.promises.readFile(statsPath, "utf8");
  const statsObj = JSON.parse(statsContent);
  statsObj.outputGlbSizeBytes = optimizationResult.displaySizeBytes;
  statsObj.optimization = {
    requestedMode: optimizationResult.requestedMode,
    status: optimizationResult.status,
    rawSizeBytes: optimizationResult.rawSizeBytes,
    displaySizeBytes: optimizationResult.displaySizeBytes,
    reductionPercent,
    tool: optimizationResult.tool,
    toolVersion: optimizationResult.toolVersion,
    quantization: optimizationResult.quantization,
    validation: optimizationResult.validation,
    fallbackUsed: optimizationResult.fallbackUsed,
    message: optimizationResult.message
  };
  await fs.promises.writeFile(statsPath, JSON.stringify(statsObj, null, 2) + "\n");

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
        nativeQualityPreset: nativeQualityDetails.preset,
        nativeDeflection: {
          linear: nativeQualityDetails.linearDeflection,
          angular: nativeQualityDetails.angularDeflection,
          relative: nativeQualityDetails.relative
        },
        converterBackend: input.converterBackend,
        optimization: {
          requestedMode: optimizationResult.requestedMode,
          status: optimizationResult.status,
          rawSizeBytes: optimizationResult.rawSizeBytes,
          displaySizeBytes: optimizationResult.displaySizeBytes,
          reductionPercent,
          tool: optimizationResult.tool,
          toolVersion: optimizationResult.toolVersion,
          quantization: optimizationResult.quantization,
          validation: optimizationResult.validation,
          fallbackUsed: optimizationResult.fallbackUsed,
          message: optimizationResult.message
        }
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
  quality: ConversionQuality;
  xcafColourMode: "xcaf-baseline" | "step-presentation";
}): Promise<void> {
  const stat = await fs.promises.stat(input.xcafConverterBin).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new Error(`xcaf-baseline converter binary is missing: ${input.xcafConverterBin}`);
  }

  const nativeQuality = nativeQualityPreset(input.quality);
  const deflection = nativeDeflections[nativeQuality];

  console.log(`XCAF colour mode: ${input.xcafColourMode}`);
  console.log("Converter colour space: raw");
  console.log(`Native XCAF binary: ${input.xcafConverterBin}`);
  console.log(`Semantic quality: ${input.quality}`);
  console.log(`Native XCAF quality: ${nativeQuality}`);
  console.log(`Native deflection: linear=${deflection.linear}, angular=${deflection.angular}, relative=true`);

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
    `Semantic quality: ${input.quality}`,
    `Native preset: ${nativeQuality}`,
    `Native deflection: linear=${deflection.linear}, angular=${deflection.angular}, relative=true`,
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
  quality: ConversionQuality;
}): Promise<NativeQualityDetails> {
  const report = JSON.parse(await fs.promises.readFile(input.reportPath, "utf8")) as {
    openCascadeVersion?: string;
    summary?: Record<string, unknown>;
    quality?: {
      preset?: NativeQualityPreset;
      linearDeflection?: number;
      angularDeflection?: number;
      relative?: boolean;
    };
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
    semanticQuality: input.quality,
    qualityPreset: input.quality,
    nativeQualityPreset: report.quality?.preset,
    nativeLinearDeflection: report.quality?.linearDeflection,
    nativeAngularDeflection: report.quality?.angularDeflection,
    nativeRelativeDeflection: report.quality?.relative,
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

  const fallbackPreset = nativeQualityPreset(input.quality);
  return {
    preset: report.quality?.preset ?? fallbackPreset,
    linearDeflection: report.quality?.linearDeflection ?? nativeDeflections[fallbackPreset].linear,
    angularDeflection: report.quality?.angularDeflection ?? nativeDeflections[fallbackPreset].angular,
    relative: report.quality?.relative ?? true
  };
}

type NativeQualityDetails = {
  preset: NativeQualityPreset;
  linearDeflection: number;
  angularDeflection: number;
  relative: boolean;
};

async function assertFile(filePath: string, message: string): Promise<void> {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile() || stat.size === 0) {
    throw new Error(message);
  }
}
