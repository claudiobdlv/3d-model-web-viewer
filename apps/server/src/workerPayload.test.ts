import assert from "node:assert/strict";
import test from "node:test";
import { workerJobPayload } from "./workerPayload.js";

test("worker job payload includes immutable stored quality", () => {
  assert.deepEqual(
    workerJobPayload({
      id: 42,
      model_slug: "quality-test",
      source_filename: "part.step",
      quality: "high",
      meshiq_adaptive_smoothing: "strong",
      revision_id: 7
    }),
    {
      id: 42,
      modelSlug: "quality-test",
      sourceFilename: "part.step",
      sourceExtension: ".step",
      quality: "high",
      meshiqAdaptiveSmoothing: "strong",
      revisionId: 7,
      downloadUrl: "/api/worker/jobs/42/source"
    }
  );
});

test("worker job payload treats old or null MeshIQ values as off", () => {
  assert.equal(
    workerJobPayload({
      id: 43,
      model_slug: "old-row",
      source_filename: "old.step",
      quality: "medium",
      meshiq_adaptive_smoothing: null,
      revision_id: null
    }).meshiqAdaptiveSmoothing,
    "off"
  );
});

test("worker job payload carries DXF extension for backend dispatch", () => {
  assert.equal(
    workerJobPayload({
      id: 44,
      model_slug: "format-test",
      source_filename: "generic.dxf",
      source_ext: ".dxf",
      quality: "medium"
    }).sourceExtension,
    ".dxf"
  );
});
