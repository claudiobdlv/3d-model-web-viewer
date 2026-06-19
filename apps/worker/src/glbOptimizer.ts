import fs from "node:fs";
import path from "node:path";
import { NodeIO, PropertyType } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression } from "@gltf-transform/extensions";
import { dedup, prune, quantize, reorder } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import { validateOptimizedGlb, type GlbValidationResult } from "./glbValidation.js";

export type GlbOptimizationMode = "disabled" | "meshopt";
export type GlbOptimizationResult = {
  requestedMode: GlbOptimizationMode;
  status: "applied" | "failed" | "disabled" | "skipped-not-smaller";
  tool: "@gltf-transform direct APIs + meshoptimizer";
  toolVersion: "4.4.0 / 1.0.1";
  quantization: { position: 16; normal: 12; texcoord: 14; generic: 16; color: 8 };
  rawSizeBytes: number;
  displaySizeBytes: number;
  requiresMeshoptDecoder: boolean;
  validation: GlbValidationResult | { passed: false; message: string };
  fallbackUsed: boolean;
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
    const result = makeResult({
      requestedMode: input.requestedMode,
      status: "disabled",
      rawSizeBytes,
      displaySizeBytes: rawSizeBytes,
      requiresMeshoptDecoder: false,
      validation: { passed: false, message: "not run because optimization is disabled" },
      fallbackUsed: false,
      message: "Meshopt optimization disabled; published raw GLB."
    });
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
      const result = makeResult({
        requestedMode: input.requestedMode,
        status: "skipped-not-smaller",
        rawSizeBytes,
        displaySizeBytes: rawSizeBytes,
        requiresMeshoptDecoder: false,
        validation,
        fallbackUsed: true,
        message: `Validated Meshopt candidate was not smaller (${candidateSizeBytes} >= ${rawSizeBytes}); published raw GLB.`
      });
      await appendLog(input.conversionLogPath, result);
      return result;
    }

    await fs.promises.copyFile(candidatePath, input.displayGlbPath);
    const result = makeResult({
      requestedMode: input.requestedMode,
      status: "applied",
      rawSizeBytes,
      displaySizeBytes: candidateSizeBytes,
      requiresMeshoptDecoder: true,
      validation,
      fallbackUsed: false,
      message: `Meshopt candidate passed validation and reduced GLB by ${percent(rawSizeBytes, candidateSizeBytes)}%; published optimized display.glb.`
    });
    await appendLog(input.conversionLogPath, result);
    return result;
  } catch (error) {
    await fs.promises.copyFile(input.rawGlbPath, input.displayGlbPath);
    const message = error instanceof Error ? error.message : "unknown optimization error";
    const result = makeResult({
      requestedMode: input.requestedMode,
      status: "failed",
      rawSizeBytes,
      displaySizeBytes: rawSizeBytes,
      requiresMeshoptDecoder: false,
      validation: { passed: false, message },
      fallbackUsed: true,
      message: `Meshopt optimization failed; published raw GLB. Reason: ${message}`
    });
    await appendLog(input.conversionLogPath, result);
    return result;
  }
}

function makeResult(values: Omit<GlbOptimizationResult, "tool" | "toolVersion" | "quantization">): GlbOptimizationResult {
  return {
    ...values,
    tool: "@gltf-transform direct APIs + meshoptimizer",
    toolVersion: "4.4.0 / 1.0.1",
    quantization
  };
}

async function appendLog(logPath: string, result: GlbOptimizationResult): Promise<void> {
  const lines = [
    "",
    "GLB optimization:",
    `  requestedMode=${result.requestedMode}`,
    `  status=${result.status}`,
    `  rawSizeBytes=${result.rawSizeBytes}`,
    `  displaySizeBytes=${result.displaySizeBytes}`,
    `  fallbackUsed=${result.fallbackUsed}`,
    `  requiresMeshoptDecoder=${result.requiresMeshoptDecoder}`,
    `  quantization=POSITION:${result.quantization.position},NORMAL:${result.quantization.normal},TEXCOORD:${result.quantization.texcoord},GENERIC:${result.quantization.generic},COLOR:${result.quantization.color}`,
    `  validation=${result.validation.passed ? "passed" : "failed/not-run"}`,
    `  message=${result.message}`,
    ""
  ];
  await fs.promises.appendFile(logPath, lines.join("\n"));
}

function percent(raw: number, display: number): string {
  return ((1 - display / raw) * 100).toFixed(1);
}
