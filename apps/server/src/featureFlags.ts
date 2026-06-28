const baseUploadExtensions = new Set([".step", ".stp", ".glb", ".gltf"]);

export function isDxfUploadEnabled(): boolean {
  return process.env.FORMATIQ_DXF_UPLOAD_ENABLED?.trim().toLowerCase() === "true";
}

export function isUploadExtensionAllowed(extension: string): boolean {
  return baseUploadExtensions.has(extension) || (extension === ".dxf" && isDxfUploadEnabled());
}

export function uploadExtensionError(extension: string): string {
  if (extension === ".dxf" && !isDxfUploadEnabled()) {
    return "DXF upload is disabled. Set FORMATIQ_DXF_UPLOAD_ENABLED=true to enable controlled DXF testing.";
  }
  return isDxfUploadEnabled()
    ? "Only .step, .stp, .glb, .gltf, and .dxf files are accepted."
    : "Only .step, .stp, .glb, and .gltf files are accepted.";
}
