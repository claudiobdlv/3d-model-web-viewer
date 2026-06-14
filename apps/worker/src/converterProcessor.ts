import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type ConverterProcessorInput = {
  slug: string;
  sourcePath: string;
  outputDir: string;
  converterCli: string;
  quality: string;
};

export type ConverterProcessorOutput = {
  displayGlbPath: string;
  manifestPath: string;
  statsPath: string;
  materialDebugPath: string;
  conversionLogPath: string;
};

export async function convertStepJob(input: ConverterProcessorInput): Promise<ConverterProcessorOutput> {
  const jobDir = path.join(input.outputDir, input.slug);
  fs.mkdirSync(jobDir, { recursive: true });

  await runConverter({
    converterCli: input.converterCli,
    sourcePath: input.sourcePath,
    outputDir: jobDir,
    quality: input.quality
  });

  const rawGlbPath = path.join(jobDir, "display.raw.glb");
  const displayGlbPath = path.join(jobDir, "display.glb");
  const statsPath = path.join(jobDir, "stats.json");
  const materialDebugPath = path.join(jobDir, "material-debug.json");
  const conversionLogPath = path.join(jobDir, "conversion.log");

  await assertFile(rawGlbPath, "converter did not produce display.raw.glb");
  await fs.promises.copyFile(rawGlbPath, displayGlbPath);
  await assertFile(statsPath, "converter did not produce stats.json");
  await assertFile(materialDebugPath, "converter did not produce material-debug.json");
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
        quality: input.quality
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
    conversionLogPath
  };
}

function runConverter(input: {
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

async function assertFile(filePath: string, message: string): Promise<void> {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile() || stat.size === 0) {
    throw new Error(message);
  }
}
