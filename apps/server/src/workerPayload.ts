import path from "node:path";
import type { ConversionQuality } from "./quality.js";
import { normalizeMeshiqAdaptiveSmoothing, type MeshiqAdaptiveSmoothing } from "./meshiq.js";

export function workerJobPayload(job: {
  id: number;
  model_slug: string;
  source_filename: string;
  source_ext?: string;
  quality: ConversionQuality;
  meshiq_adaptive_smoothing?: MeshiqAdaptiveSmoothing | null;
  revision_id?: number | null;
}) {
  return {
    id: job.id,
    modelSlug: job.model_slug,
    sourceFilename: job.source_filename,
    sourceExtension: job.source_ext ?? path.extname(job.source_filename).toLowerCase(),
    quality: job.quality,
    meshiqAdaptiveSmoothing: normalizeMeshiqAdaptiveSmoothing(job.meshiq_adaptive_smoothing),
    revisionId: job.revision_id ?? null,
    downloadUrl: `/api/worker/jobs/${job.id}/source`
  };
}
