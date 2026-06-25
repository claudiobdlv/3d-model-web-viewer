import type { ConversionQuality } from "./quality.js";

export function workerJobPayload(job: {
  id: number;
  model_slug: string;
  source_filename: string;
  quality: ConversionQuality;
  revision_id?: number | null;
}) {
  return {
    id: job.id,
    modelSlug: job.model_slug,
    sourceFilename: job.source_filename,
    quality: job.quality,
    revisionId: job.revision_id ?? null,
    downloadUrl: `/api/worker/jobs/${job.id}/source`
  };
}
