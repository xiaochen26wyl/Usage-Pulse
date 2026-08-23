import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveTrayValueColor,
  TRAY_VALUE_COLOR_BLACK,
  TRAY_VALUE_COLOR_WHITE
} from "../src/shared/tray-value-color";

test("resolveTrayValueColor forces white / black", () => {
  assert.equal(resolveTrayValueColor("white", false), TRAY_VALUE_COLOR_WHITE);
  assert.equal(resolveTrayValueColor("white", true), TRAY_VALUE_COLOR_WHITE);
  assert.equal(resolveTrayValueColor("black", false), TRAY_VALUE_COLOR_BLACK);
  assert.equal(resolveTrayValueColor("black", true), TRAY_VALUE_COLOR_BLACK);
});

test("resolveTrayValueColor follows system appearance", () => {
  assert.equal(resolveTrayValueColor("system", true), TRAY_VALUE_COLOR_WHITE);
  assert.equal(resolveTrayValueColor("system", false), TRAY_VALUE_COLOR_BLACK);
});
