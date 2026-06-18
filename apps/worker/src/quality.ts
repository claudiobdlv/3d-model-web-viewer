export type ConversionQuality = "low" | "medium" | "high";
export type NativeQualityPreset = "preview" | "balanced" | "high";

export const nativeDeflections: Record<NativeQualityPreset, { linear: number; angular: number }> = {
  preview: { linear: 0.85, angular: 0.65 },
  balanced: { linear: 0.45, angular: 0.5 },
  high: { linear: 0.12, angular: 0.22 }
};

const nativePresetByQuality: Record<ConversionQuality, NativeQualityPreset> = {
  low: "preview",
  medium: "balanced",
  high: "high"
};

export function resolveSemanticQuality(
  jobQuality: string | undefined,
  legacyFallback: string
): ConversionQuality {
  if (jobQuality === "low" || jobQuality === "medium" || jobQuality === "high") {
    return jobQuality;
  }

  if (legacyFallback === "fast" || legacyFallback === "preview") return "low";
  if (legacyFallback === "high" || legacyFallback === "detailed") return "high";
  return "medium";
}

export function nativeQualityPreset(quality: ConversionQuality): NativeQualityPreset {
  return nativePresetByQuality[quality];
}

export function occtJsQualityPreset(quality: ConversionQuality): "fast" | "balanced" | "detailed" {
  if (quality === "low") return "fast";
  if (quality === "high") return "detailed";
  return "balanced";
}
