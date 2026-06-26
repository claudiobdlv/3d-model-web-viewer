export const meshiqAdaptiveSmoothingOptions = ["off", "standard", "strong"] as const;

export type MeshiqAdaptiveSmoothing = (typeof meshiqAdaptiveSmoothingOptions)[number];

export function parseMeshiqAdaptiveSmoothing(value: unknown): MeshiqAdaptiveSmoothing {
  if (value === undefined || value === null || value === "") {
    return "off";
  }

  if (
    typeof value === "string" &&
    meshiqAdaptiveSmoothingOptions.includes(value as MeshiqAdaptiveSmoothing)
  ) {
    return value as MeshiqAdaptiveSmoothing;
  }

  throw new Error("Invalid MeshIQ adaptive smoothing. Accepted values are off, standard, and strong.");
}

export function normalizeMeshiqAdaptiveSmoothing(value: unknown): MeshiqAdaptiveSmoothing {
  try {
    return parseMeshiqAdaptiveSmoothing(value);
  } catch {
    return "off";
  }
}
