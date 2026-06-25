import assert from "node:assert/strict";
import test from "node:test";
import { workerJobPayload } from "./workerPayload.js";

test("worker job payload includes immutable stored quality", () => {
  assert.deepEqual(
    workerJobPayload({ id: 42, model_slug: "quality-test", source_filename: "part.step", quality: "high", revision_id: 7 }),
    {
      id: 42,
      modelSlug: "quality-test",
      sourceFilename: "part.step",
      quality: "high",
      revisionId: 7,
      downloadUrl: "/api/worker/jobs/42/source"
    }
  );
});
