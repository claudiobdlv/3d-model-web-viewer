import fs from "node:fs";
import os from "node:os";

export type ResourceSnapshot = {
  timestamp: string;
  memoryCurrentBytes?: number;
  memoryMaxBytes?: number;
  memoryUsedFraction?: number;
  memoryFreeBytes?: number;
  swapCurrentBytes?: number;
  swapDeltaBytes?: number;
  loadAverage?: number[];
  safeToLaunchMore: boolean;
  emergencyPressure: boolean;
  reasons: string[];
};

export type ResourceMonitorConfig = {
  largeStepMaxWorkerMemoryFraction: number;
  largeStepMinFreeMemoryMb: number;
  largeStepMaxSwapGrowthMb: number;
  largeStepEmergencyMemoryFraction: number;
};

export function readCgroupBytes(filePath: string): number | null {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf8").trim();
      if (content === "max") {
        return null;
      }
      const bytes = Number(content);
      return Number.isSafeInteger(bytes) ? bytes : null;
    }
  } catch (err) {
    // Ignore and fallback
  }
  return null;
}

export function getResourceSnapshot(
  config: ResourceMonitorConfig,
  initialSwapBytes?: number
): ResourceSnapshot {
  const timestamp = new Date().toISOString();

  // Try reading cgroup v2
  const cgroupMemCurrent = readCgroupBytes("/sys/fs/cgroup/memory.current");
  const cgroupMemMax = readCgroupBytes("/sys/fs/cgroup/memory.max");
  const cgroupSwapCurrent = readCgroupBytes("/sys/fs/cgroup/memory.swap.current");

  // Determine current memory usage
  let memoryCurrentBytes: number;
  if (cgroupMemCurrent !== null) {
    memoryCurrentBytes = cgroupMemCurrent;
  } else {
    memoryCurrentBytes = os.totalmem() - os.freemem();
  }

  // Determine max memory limit
  let memoryMaxBytes: number;
  if (cgroupMemMax !== null) {
    memoryMaxBytes = cgroupMemMax;
  } else {
    memoryMaxBytes = os.totalmem();
  }

  const memoryUsedFraction = memoryMaxBytes > 0 ? memoryCurrentBytes / memoryMaxBytes : 0;
  const memoryFreeBytes = Math.max(0, memoryMaxBytes - memoryCurrentBytes);

  // Swap usage
  const swapCurrentBytes = cgroupSwapCurrent !== null ? cgroupSwapCurrent : 0;
  const swapDeltaBytes = initialSwapBytes !== undefined ? Math.max(0, swapCurrentBytes - initialSwapBytes) : 0;

  const loadAverage = os.loadavg();

  // Decision variables
  const reasons: string[] = [];

  const maxMemFraction = config.largeStepMaxWorkerMemoryFraction;
  const minFreeMemBytes = config.largeStepMinFreeMemoryMb * 1024 * 1024;
  const maxSwapGrowthBytes = config.largeStepMaxSwapGrowthMb * 1024 * 1024;
  const emergencyMemFraction = config.largeStepEmergencyMemoryFraction;

  // Emergency checks
  let emergencyPressure = false;
  if (memoryUsedFraction >= emergencyMemFraction) {
    emergencyPressure = true;
    reasons.push(`Emergency: Memory fraction ${memoryUsedFraction.toFixed(4)} >= threshold ${emergencyMemFraction}`);
  }
  if (swapDeltaBytes >= maxSwapGrowthBytes) {
    emergencyPressure = true;
    reasons.push(`Emergency: Swap growth ${swapDeltaBytes} >= threshold ${maxSwapGrowthBytes}`);
  }

  // Safe to launch checks
  let safeToLaunchMore = true;

  if (memoryUsedFraction >= maxMemFraction) {
    safeToLaunchMore = false;
    reasons.push(`Memory used fraction ${memoryUsedFraction.toFixed(4)} >= threshold ${maxMemFraction}`);
  }
  if (memoryFreeBytes < minFreeMemBytes) {
    safeToLaunchMore = false;
    reasons.push(`Free memory ${(memoryFreeBytes / (1024 * 1024)).toFixed(2)} MB < threshold ${config.largeStepMinFreeMemoryMb} MB`);
  }
  if (swapDeltaBytes > maxSwapGrowthBytes) {
    safeToLaunchMore = false;
    reasons.push(`Swap growth ${(swapDeltaBytes / (1024 * 1024)).toFixed(2)} MB > threshold ${config.largeStepMaxSwapGrowthMb} MB`);
  }
  if (emergencyPressure) {
    safeToLaunchMore = false;
  }

  return {
    timestamp,
    memoryCurrentBytes,
    memoryMaxBytes,
    memoryUsedFraction,
    memoryFreeBytes,
    swapCurrentBytes,
    swapDeltaBytes,
    loadAverage,
    safeToLaunchMore,
    emergencyPressure,
    reasons
  };
}
