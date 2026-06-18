import type { ConversionQuality } from "./quality.js";

export function workerJobPayload(job: {
  id: number;
  model_slug: string;
  source_filename: string;
  quality: ConversionQuality;
}) {
  return {
    id: job.id,
    modelSlug: job.model_slug,
    sourceFilename: job.source_filename,
    quality: job.quality,
    downloadUrl: `/api/worker/jobs/${job.id}/source`
  };
}
