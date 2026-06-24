import path from "node:path";
import type { StepPreScanResult } from "./stepPreScan.js";

export type DecisionInput = {
  filePath: string;
  fileSizeBytes: number;
  converterBackend: string;
};

export type DecisionConfig = {
  largeStepChunkingMode: "disabled" | "auto" | "direct-filter";
  largeStepAutoMinFileSizeMb: number;
  largeStepAutoPlannerFileSizeMb: number;
  largeStepAutoPrescanEnabled: boolean;
  largeStepForcePlanner: boolean;
  largeStepLeafCountThreshold: number;
  largeStepFaceCountThreshold: number;
  largeStepWorkScoreThreshold: number;
};

export type PlannerOutputSummary = {
  leafCount: number;
  faceCount: number;
  workScore: number;
  recommended: boolean;
};

export type DecisionResult = {
  mode: "disabled" | "auto" | "direct-filter";
  shouldRunPreScan: boolean;
  shouldRunPlanner: boolean;
  shouldChunk: boolean;
  skipReason?: "disabled" | "non-step" | "unsupported-backend" | "below-auto-min-size" | "planner-not-worth-it" | "prescan-not-complex";
  reasons: string[];
};

export function decideLargeStepChunking(
  input: DecisionInput,
  config: DecisionConfig,
  preScan?: StepPreScanResult,
  planner?: PlannerOutputSummary
): DecisionResult {
  const mode = config.largeStepChunkingMode;
  const reasons: string[] = [];

  // 1. Check disabled
  if (mode === "disabled") {
    reasons.push("Chunking mode is disabled");
    return { mode, shouldRunPreScan: false, shouldRunPlanner: false, shouldChunk: false, skipReason: "disabled", reasons };
  }

  // 2. Check file extension (.step or .stp)
  const ext = path.extname(input.filePath).toLowerCase();
  const isStep = ext === ".step" || ext === ".stp";
  if (!isStep) {
    reasons.push(`File extension "${ext}" is not STEP/STP`);
    return { mode, shouldRunPreScan: false, shouldRunPlanner: false, shouldChunk: false, skipReason: "non-step", reasons };
  }

  // 3. Check backend
  if (input.converterBackend !== "xcaf-baseline") {
    reasons.push(`Converter backend "${input.converterBackend}" is not supported for chunking`);
    return { mode, shouldRunPreScan: false, shouldRunPlanner: false, shouldChunk: false, skipReason: "unsupported-backend", reasons };
  }

  // 4. File size threshold checking
  const fileSizeMb = input.fileSizeBytes / (1024 * 1024);
  const belowMinSize = fileSizeMb < config.largeStepAutoMinFileSizeMb;

  if (belowMinSize && !config.largeStepForcePlanner) {
    reasons.push(`File size ${fileSizeMb.toFixed(2)} MB is below min threshold ${config.largeStepAutoMinFileSizeMb} MB`);
    return { mode, shouldRunPreScan: false, shouldRunPlanner: false, shouldChunk: false, skipReason: "below-auto-min-size", reasons };
  }

  // 5. In direct-filter mode
  if (mode === "direct-filter") {
    reasons.push("Direct-filter mode explicitly set");
    if (!planner) {
      // If we don't have planner output yet, we should run the planner
      return { mode, shouldRunPreScan: false, shouldRunPlanner: true, shouldChunk: false, reasons };
    }
    // We have planner output, evaluate thresholds
    const isWorthIt =
      planner.recommended ||
      planner.leafCount >= config.largeStepLeafCountThreshold ||
      planner.faceCount >= config.largeStepFaceCountThreshold ||
      planner.workScore >= config.largeStepWorkScoreThreshold;

    if (isWorthIt) {
      if (planner.recommended) reasons.push("Planner recommended chunking");
      if (planner.leafCount >= config.largeStepLeafCountThreshold) reasons.push(`Leaf count ${planner.leafCount} >= threshold ${config.largeStepLeafCountThreshold}`);
      if (planner.faceCount >= config.largeStepFaceCountThreshold) reasons.push(`Face count ${planner.faceCount} >= threshold ${config.largeStepFaceCountThreshold}`);
      if (planner.workScore >= config.largeStepWorkScoreThreshold) reasons.push(`Work score ${planner.workScore} >= threshold ${config.largeStepWorkScoreThreshold}`);
      return { mode, shouldRunPreScan: false, shouldRunPlanner: true, shouldChunk: true, reasons };
    } else {
      reasons.push(`Planner thresholds not met (recommended=${planner.recommended}, leaves=${planner.leafCount}, faces=${planner.faceCount}, workScore=${planner.workScore})`);
      return { mode, shouldRunPreScan: false, shouldRunPlanner: true, shouldChunk: false, skipReason: "planner-not-worth-it", reasons };
    }
  }

  // 6. In auto mode
  if (mode === "auto") {
    // If file size is forced or explicitly large
    const isLarge = fileSizeMb >= config.largeStepAutoPlannerFileSizeMb;

    if (isLarge || config.largeStepForcePlanner) {
      reasons.push(isLarge 
        ? `File size ${fileSizeMb.toFixed(2)} MB >= planner threshold ${config.largeStepAutoPlannerFileSizeMb} MB`
        : "Planner execution forced by config"
      );
      if (!planner) {
        return { mode, shouldRunPreScan: false, shouldRunPlanner: true, shouldChunk: false, reasons };
      }
    } else {
      // Medium file size (min <= size < planner_threshold)
      if (config.largeStepAutoPrescanEnabled) {
        if (!preScan) {
          reasons.push(`Medium file size ${fileSizeMb.toFixed(2)} MB: requesting pre-scan`);
          return { mode, shouldRunPreScan: true, shouldRunPlanner: false, shouldChunk: false, reasons };
        }
        if (!preScan.probablyComplex) {
          reasons.push(`Pre-scan says not complex: reasons=[${preScan.reasons.join(", ")}]`);
          return { mode, shouldRunPreScan: false, shouldRunPlanner: false, shouldChunk: false, skipReason: "prescan-not-complex", reasons };
        }
        // Complex, so run planner
        reasons.push(`Pre-scan says complex: reasons=[${preScan.reasons.join(", ")}]`);
        if (!planner) {
          return { mode, shouldRunPreScan: false, shouldRunPlanner: true, shouldChunk: false, reasons };
        }
      } else {
        // Pre-scan disabled, run planner directly
        reasons.push(`Pre-scan disabled: run planner directly for file size ${fileSizeMb.toFixed(2)} MB`);
        if (!planner) {
          return { mode, shouldRunPreScan: false, shouldRunPlanner: true, shouldChunk: false, reasons };
        }
      }
    }

    // Evaluate planner thresholds in auto mode
    const isWorthIt =
      planner.recommended ||
      planner.leafCount >= config.largeStepLeafCountThreshold ||
      planner.faceCount >= config.largeStepFaceCountThreshold ||
      planner.workScore >= config.largeStepWorkScoreThreshold;

    if (isWorthIt) {
      if (planner.recommended) reasons.push("Planner recommended chunking");
      if (planner.leafCount >= config.largeStepLeafCountThreshold) reasons.push(`Leaf count ${planner.leafCount} >= threshold ${config.largeStepLeafCountThreshold}`);
      if (planner.faceCount >= config.largeStepFaceCountThreshold) reasons.push(`Face count ${planner.faceCount} >= threshold ${config.largeStepFaceCountThreshold}`);
      if (planner.workScore >= config.largeStepWorkScoreThreshold) reasons.push(`Work score ${planner.workScore} >= threshold ${config.largeStepWorkScoreThreshold}`);
      return { mode, shouldRunPreScan: false, shouldRunPlanner: true, shouldChunk: true, reasons };
    } else {
      reasons.push(`Planner thresholds not met (recommended=${planner.recommended}, leaves=${planner.leafCount}, faces=${planner.faceCount}, workScore=${planner.workScore})`);
      return { mode, shouldRunPreScan: false, shouldRunPlanner: true, shouldChunk: false, skipReason: "planner-not-worth-it", reasons };
    }
  }

  // Fallback
  reasons.push(`Unknown mode ${mode}`);
  return { mode, shouldRunPreScan: false, shouldRunPlanner: false, shouldChunk: false, skipReason: "disabled", reasons };
}
