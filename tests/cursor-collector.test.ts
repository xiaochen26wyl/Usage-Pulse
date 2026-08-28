import test from "node:test";
import assert from "node:assert/strict";
import { clampPercentFromRatio } from "../src/shared/monitor-utils";

test("clampPercentFromRatio treats a value above 1 as an already-scaled percent", () => {
  // Regression: Cursor's API has returned autoPercentUsed as 49 for an
  // account that had genuinely used 49% of its Cursor-models quota — treating
  // that as a 0-1 ratio and multiplying by 100 saturated the reading at the
  // 100 clamp, showing "100% used" for real usage as low as ~1%.
  assert.equal(clampPercentFromRatio(49), 49);
  assert.equal(clampPercentFromRatio(11.2), 11);
});

test("clampPercentFromRatio clamps a negative ratio to 0", () => {
  assert.equal(clampPercentFromRatio(-0.2), 0);
});

test("clampPercentFromRatio rounds a normal 0-1 ratio to a percent", () => {
  assert.equal(clampPercentFromRatio(0.42), 42);
  assert.equal(clampPercentFromRatio(1), 100);
  assert.equal(clampPercentFromRatio(0), 0);
});

test("clampPercentFromRatio clamps an already-scaled percent above 100 to 100", () => {
  assert.equal(clampPercentFromRatio(140), 100);
});
