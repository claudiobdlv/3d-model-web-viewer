import assert from "node:assert/strict";
import test from "node:test";
import { parseConversionQuality } from "./quality.js";

test("omitted conversion quality defaults to medium", () => {
  assert.equal(parseConversionQuality(undefined), "medium");
});

test("low, medium, and high conversion qualities are accepted", () => {
  assert.equal(parseConversionQuality("low"), "low");
  assert.equal(parseConversionQuality("medium"), "medium");
  assert.equal(parseConversionQuality("high"), "high");
});

test("invalid conversion quality is rejected with a clear message", () => {
  assert.throws(
    () => parseConversionQuality("ultra"),
    /Invalid quality\. Accepted values are low, medium, and high\./
  );
});
