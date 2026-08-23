import test from "node:test";
import assert from "node:assert/strict";
import {
  clampWaterReminderMinutes,
  DEFAULT_WATER_CUP_SIZE_ML,
  DEFAULT_WATER_REMINDER_MINUTES,
  isWaterCupSizeMl,
  normalizeWaterCupSize
} from "../src/shared/water";

test("clampWaterReminderMinutes keeps the default and bounds", () => {
  assert.equal(clampWaterReminderMinutes(undefined), DEFAULT_WATER_REMINDER_MINUTES);
  assert.equal(clampWaterReminderMinutes("nope"), DEFAULT_WATER_REMINDER_MINUTES);
  assert.equal(clampWaterReminderMinutes(50), 50);
  assert.equal(clampWaterReminderMinutes(1), 5);
  assert.equal(clampWaterReminderMinutes(240), 180);
  assert.equal(clampWaterReminderMinutes(49.6), 50);
});

test("normalizeWaterCupSize only allows 250 / 500 / 1000", () => {
  assert.equal(isWaterCupSizeMl(250), true);
  assert.equal(isWaterCupSizeMl(500), true);
  assert.equal(isWaterCupSizeMl(1000), true);
  assert.equal(isWaterCupSizeMl(300), false);
  assert.equal(normalizeWaterCupSize(250), 250);
  assert.equal(normalizeWaterCupSize("1000"), 1000);
  assert.equal(normalizeWaterCupSize(750), DEFAULT_WATER_CUP_SIZE_ML);
  assert.equal(normalizeWaterCupSize(null), DEFAULT_WATER_CUP_SIZE_ML);
});
