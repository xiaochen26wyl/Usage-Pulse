import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVICE_ACCENT } from "../src/shared/line-templates";
import {
  resolveTrayValueColor,
  TRAY_CLAUDE_LABEL_COLOR,
  TRAY_CURSOR_LABEL_COLOR,
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

test("tray label colors match app CSS and Claude LINE accent", () => {
  const cssPath = join(dirname(fileURLToPath(import.meta.url)), "../src/renderer/styles.css");
  const css = readFileSync(cssPath, "utf8");
  assert.match(css, new RegExp(`--color-cursor:\\s*${TRAY_CURSOR_LABEL_COLOR}`, "i"));
  assert.match(css, new RegExp(`--color-claude:\\s*${TRAY_CLAUDE_LABEL_COLOR}`, "i"));
  assert.equal(TRAY_CLAUDE_LABEL_COLOR.toLowerCase(), SERVICE_ACCENT.claude.toLowerCase());
});
