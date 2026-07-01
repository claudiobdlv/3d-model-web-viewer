import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { NodeIO, PropertyType } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression } from "@gltf-transform/extensions";
import { dedup, prune, quantize, reorder } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import {
  inspectGlbCompression,
  validateOptimizedGlb,
  type GlbCompressionInspection,
  type GlbValidationResult
} from "./glbValidation.js";

export type GlbOptimizationMode = "disabled" | "meshopt";
export type GlbOptimizationResult = {
  requestedMode: GlbOptimizationMode;
  status: "applied" | "failed" | "disabled" | "skipped-not-smaller";
  tool: "@gltf-transform direct APIs + meshoptimizer";
  toolVersion: "4.4.0 / 1.0.1";
  quantization: { position: 16; normal: 12; texcoord: 14; generic: 16; color: 8 };
  rawSizeBytes: number;
  candidateSizeBytes: number | null;
  displaySizeBytes: number;
  bytesSaved: number;
  reductionPercent: number;
  compressionRatio: number;
  requiresMeshoptDecoder: boolean;
  validation: GlbValidationResult | { passed: false; message: string };
  compression: GlbCompressionInspection;
  hashes: { rawSha256: string; finalSha256: string };
  fallbackUsed: boolean;
  fallbackReason: string | null;
  message: string;
};

const quantization = { position: 16, normal: 12, texcoord: 14, generic: 16, color: 8 } as const;

export async function optimizeDisplayGlb(input: {
  requestedMode: GlbOptimizationMode;
  rawGlbPath: string;
  displayGlbPath: string;
  conversionLogPath: string;
}): Promise<GlbOptimizationResult> {
  const rawSizeBytes = (await fs.promises.stat(input.rawGlbPath)).size;
  if (input.requestedMode === "disabled") {
    await fs.promises.copyFile(input.rawGlbPath, input.displayGlbPath);
    const result = await makeResult({
      requestedMode: input.requestedMode,
      status: "disabled",
      rawSizeBytes,
      candidateSizeBytes: null,
      displaySizeBytes: rawSizeBytes,
      requiresMeshoptDecoder: false,
      validation: { passed: false, message: "not run because optimization is disabled" },
      fallbackUsed: false,
      fallbackReason: null,
      message: "Meshopt optimization disabled; published raw GLB."
    }, input.rawGlbPath, input.displayGlbPath);
    await appendLog(input.conversionLogPath, result);
    return result;
  }

  const candidatePath = path.join(path.dirname(input.displayGlbPath), "display.meshopt.glb.tmp");
  try {
    await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
    const io = new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });
    const document = await io.read(input.rawGlbPath);
    // Explicit equivalent of the proven CLI `meshopt --level medium` spike.
    // Built-in cleanup is disabled; the only cleanup below is accessor-only.
    await document.transform(
      reorder({ encoder: MeshoptEncoder, target: "size" }),
      quantize({
        pattern: /.*/,
        patternTargets: /.*/,
        quantizePosition: quantization.position,
        quantizeNormal: quantization.normal,
        quantizeTexcoord: quantization.texcoord,
        quantizeGeneric: quantization.generic,
        quantizeColor: quantization.color,
        normalizeWeights: true,
        cleanup: false
      }),
      // Remove replaced accessor resources and deduplicate repeated accessor
      // payloads. No node, mesh, primitive, skin, material, or hierarchy is
      // pruned/deduplicated, and all semantic gates run before publication.
      prune({
        propertyTypes: [PropertyType.ACCESSOR],
        keepAttributes: true,
        keepIndices: true,
        keepLeaves: true,
        keepSolidTextures: true
      }),
      dedup({ propertyTypes: [PropertyType.ACCESSOR], keepUniqueNames: true })
    );
    document.createExtension(EXTMeshoptCompression)
      .setRequired(true)
      .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
    await fs.promises.writeFile(candidatePath, await io.writeBinary(document));

    const candidateSizeBytes = (await fs.promises.stat(candidatePath)).size;
    const validation = await validateOptimizedGlb(input.rawGlbPath, candidatePath);
    if (candidateSizeBytes >= rawSizeBytes) {
      await fs.promises.copyFile(input.rawGlbPath, input.displayGlbPath);
      const fallbackReason = `candidate was not smaller (${candidateSizeBytes} >= ${rawSizeBytes})`;
      const result = await makeResult({
        requestedMode: input.requestedMode,
        status: "skipped-not-smaller",
        rawSizeBytes,
        candidateSizeBytes,
        displaySizeBytes: rawSizeBytes,
        requiresMeshoptDecoder: false,
        validation,
        fallbackUsed: true,
        fallbackReason,
        message: `Validated Meshopt candidate was not smaller (${candidateSizeBytes} >= ${rawSizeBytes}); published raw GLB.`
      }, input.rawGlbPath, input.displayGlbPath);
      await appendLog(input.conversionLogPath, result);
      await fs.promises.rm(candidatePath, { force: true });
      return result;
    }

    await fs.promises.copyFile(candidatePath, input.displayGlbPath);
    const result = await makeResult({
      requestedMode: input.requestedMode,
      status: "applied",
      rawSizeBytes,
      candidateSizeBytes,
      displaySizeBytes: candidateSizeBytes,
      requiresMeshoptDecoder: true,
      validation,
      fallbackUsed: false,
      fallbackReason: null,
      message: `Meshopt candidate passed validation and reduced GLB by ${percent(rawSizeBytes, candidateSizeBytes)}%; published optimized display.glb.`
    }, input.rawGlbPath, input.displayGlbPath);
    await appendLog(input.conversionLogPath, result);
    await fs.promises.rm(candidatePath, { force: true });
    return result;
  } catch (error) {
    await fs.promises.copyFile(input.rawGlbPath, input.displayGlbPath);
    const message = error instanceof Error ? error.message : "unknown optimization error";
    const result = await makeResult({
      requestedMode: input.requestedMode,
      status: "failed",
      rawSizeBytes,
      candidateSizeBytes: await fileSize(candidatePath),
      displaySizeBytes: rawSizeBytes,
      requiresMeshoptDecoder: false,
      validation: { passed: false, message },
      fallbackUsed: true,
      fallbackReason: message,
      message: `Meshopt optimization failed; published raw GLB. Reason: ${message}`
    }, input.rawGlbPath, input.displayGlbPath);
    await appendLog(input.conversionLogPath, result);
    await fs.promises.rm(candidatePath, { force: true }).catch(() => {});
    return result;
  }
}

async function makeResult(
  values: Omit<GlbOptimizationResult, "tool" | "toolVersion" | "quantization" | "bytesSaved" | "reductionPercent" | "compressionRatio" | "compression" | "hashes">,
  rawGlbPath: string,
  displayGlbPath: string
): Promise<GlbOptimizationResult> {
  const displayBytes = await fs.promises.readFile(displayGlbPath);
  const rawBytes = displayGlbPath === rawGlbPath ? displayBytes : await fs.promises.readFile(rawGlbPath);
  const bytesSaved = Math.max(0, values.rawSizeBytes - values.displaySizeBytes);
  return {
    ...values,
    tool: "@gltf-transform direct APIs + meshoptimizer",
    toolVersion: "4.4.0 / 1.0.1",
    quantization,
    bytesSaved,
    reductionPercent: values.rawSizeBytes > 0 ? Number(((bytesSaved / values.rawSizeBytes) * 100).toFixed(2)) : 0,
    compressionRatio: values.displaySizeBytes > 0 ? Number((values.rawSizeBytes / values.displaySizeBytes).toFixed(3)) : 0,
    compression: inspectGlbCompression(displayBytes),
    hashes: {
      rawSha256: createHash("sha256").update(rawBytes).digest("hex"),
      finalSha256: createHash("sha256").update(displayBytes).digest("hex")
    }
  };
}

async function appendLog(logPath: string, result: GlbOptimizationResult): Promise<void> {
  const lines = [
    "",
    "GLB optimization:",
    `  requestedMode=${result.requestedMode}`,
    `  status=${result.status}`,
    `  rawSizeBytes=${result.rawSizeBytes}`,
    `  candidateSizeBytes=${result.candidateSizeBytes ?? "not-produced"}`,
    `  displaySizeBytes=${result.displaySizeBytes}`,
    `  bytesSaved=${result.bytesSaved}`,
    `  reductionPercent=${result.reductionPercent}`,
    `  fallbackUsed=${result.fallbackUsed}`,
    `  fallbackReason=${result.fallbackReason ?? "none"}`,
    `  requiresMeshoptDecoder=${result.requiresMeshoptDecoder}`,
    `  finalUsesMeshoptCompression=${result.compression.used}`,
    `  extensionsRequired=${result.compression.extensionsRequired.join(",") || "none"}`,
    `  quantization=POSITION:${result.quantization.position},NORMAL:${result.quantization.normal},TEXCOORD:${result.quantization.texcoord},GENERIC:${result.quantization.generic},COLOR:${result.quantization.color}`,
    `  validation=${result.validation.passed ? "passed" : "failed/not-run"}`,
    `  message=${result.message}`,
    ""
  ];
  await fs.promises.appendFile(logPath, lines.join("\n"));
}

async function fileSize(filePath: string): Promise<number | null> {
  return fs.promises.stat(filePath).then((stat) => stat.size).catch(() => null);
}

function percent(raw: number, display: number): string {
  return ((1 - display / raw) * 100).toFixed(1);
}
