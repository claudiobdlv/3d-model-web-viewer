export const conversionQualities = ["low", "medium", "high"] as const;

export type ConversionQuality = (typeof conversionQualities)[number];

export function parseConversionQuality(value: unknown): ConversionQuality {
  if (value === undefined || value === null || value === "") {
    return "medium";
  }

  if (typeof value === "string" && conversionQualities.includes(value as ConversionQuality)) {
    return value as ConversionQuality;
  }

  throw new Error("Invalid quality. Accepted values are low, medium, and high.");
}
