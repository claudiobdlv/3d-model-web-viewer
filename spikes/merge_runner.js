import { mergeGlbs, validateMergedGlb } from '../apps/worker/dist/utils/mergeGlbs.js';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("Usage: node merge_runner.js output.glb input1.glb input2.glb ...");
  process.exit(1);
}

const outputPath = path.resolve(args[0]);
const inputPaths = args.slice(1).map(p => path.resolve(p));

console.log(`Merging ${inputPaths.length} GLBs into ${outputPath}...`);
mergeGlbs(inputPaths, outputPath)
  .then(async (stats) => {
    console.log("Merge completed successfully!");
    console.log("Stats:", JSON.stringify(stats, null, 2));

    console.log("Running validation gates...");
    const report = await validateMergedGlb(inputPaths, outputPath);
    console.log("Validation Report:", JSON.stringify(report, null, 2));
    if (!report.passed) {
      console.error("Validation failed!");
      process.exit(1);
    }
    console.log("Validation passed successfully!");
  })
  .catch((err) => {
    console.error("Merge failed:", err);
    process.exit(1);
  });
