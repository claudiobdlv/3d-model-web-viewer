import { convertStepJob } from "./converterProcessor.js";
import path from "node:path";
import fs from "node:fs";

async function main() {
  const sourcePath = "/app/worker-output/screw.stp";
  if (!fs.existsSync(sourcePath)) {
    console.error(`Source file not found at ${sourcePath}`);
    process.exit(1);
  }

  const result = await convertStepJob({
    slug: "screw-test-progress",
    sourcePath,
    outputDir: "/app/worker-output",
    converterBackend: "xcaf-baseline",
    converterCli: "",
    xcafConverterBin: "/app/bin/xcaf-step-to-glb",
    xcafColourMode: "xcaf-baseline",
    quality: "medium",
    glbOptimizationMode: "disabled",
    onProgress: (percent, label) => {
      console.log(`[PROGRESS CALLBACK] ${percent}% - ${label}`);
    }
  });
  console.log("Result:", JSON.stringify(result, null, 2));
}

main().catch(console.error);
