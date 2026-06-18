import assert from "node:assert/strict";
import test from "node:test";
import { nativeDeflections, nativeQualityPreset, resolveSemanticQuality } from "./quality.js";

test("semantic quality maps to native XCAF presets", () => {
  assert.equal(nativeQualityPreset("low"), "preview");
  assert.equal(nativeQualityPreset("medium"), "balanced");
  assert.equal(nativeQualityPreset("high"), "high");
  assert.deepEqual(nativeDeflections.preview, { linear: 0.85, angular: 0.65 });
  assert.deepEqual(nativeDeflections.balanced, { linear: 0.45, angular: 0.5 });
  assert.deepEqual(nativeDeflections.high, { linear: 0.12, angular: 0.22 });
});

test("job quality wins and legacy converter quality remains a fallback", () => {
  assert.equal(resolveSemanticQuality("low", "high"), "low");
  assert.equal(resolveSemanticQuality(undefined, "fast"), "low");
  assert.equal(resolveSemanticQuality(undefined, "balanced"), "medium");
  assert.equal(resolveSemanticQuality(undefined, "detailed"), "high");
});
