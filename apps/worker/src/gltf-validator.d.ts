declare module "gltf-validator" {
  export function validateBytes(
    data: Uint8Array,
    options?: { uri?: string; maxIssues?: number; ignoredIssues?: string[] }
  ): Promise<{
    issues?: { numErrors?: number; numWarnings?: number; messages?: unknown[] };
    info?: Record<string, unknown>;
  }>;
}
