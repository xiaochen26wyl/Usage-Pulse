import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVICE_ACCENT } from "../src/shared/line-templates";
import {
  TRAY_BACKGROUND_COLOR,
  TRAY_CLAUDE_LABEL_COLOR,
  TRAY_CODEX_LABEL_COLOR,
  TRAY_CURSOR_LABEL_COLOR,
  TRAY_VALUE_COLOR,
  TRAY_WEEKLY_COLOR,
  TRAY_WEEKLY_LOW_COLOR
} from "../src/shared/tray-value-color";

const luminance = (hex: string): number => {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("tray label colors match app CSS and LINE accents", () => {
  const cssPath = join(dirname(fileURLToPath(import.meta.url)), "../src/renderer/styles.css");
  const css = readFileSync(cssPath, "utf8");
  assert.match(css, new RegExp(`--color-cursor:\\s*${TRAY_CURSOR_LABEL_COLOR}`, "i"));
  assert.match(css, new RegExp(`--color-claude:\\s*${TRAY_CLAUDE_LABEL_COLOR}`, "i"));
  assert.match(css, new RegExp(`--color-codex:\\s*${TRAY_CODEX_LABEL_COLOR}`, "i"));
  assert.equal(TRAY_CLAUDE_LABEL_COLOR.toLowerCase(), SERVICE_ACCENT.claude.toLowerCase());
  assert.equal(TRAY_CODEX_LABEL_COLOR.toLowerCase(), SERVICE_ACCENT.codex.toLowerCase());
});

test("tray background is the popover panel grey", () => {
  const cssPath = join(dirname(fileURLToPath(import.meta.url)), "../src/renderer/styles.css");
  const css = readFileSync(cssPath, "utf8");
  assert.match(css, new RegExp(`\\.panel\\s*{[^}]*background:\\s*${TRAY_BACKGROUND_COLOR}`, "i"));
});

test("every menu-bar text colour is legible on the tray background", () => {
  for (const color of [
    TRAY_CURSOR_LABEL_COLOR,
    TRAY_CLAUDE_LABEL_COLOR,
    TRAY_CODEX_LABEL_COLOR,
    TRAY_VALUE_COLOR,
    TRAY_WEEKLY_COLOR
  ]) {
    assert.ok(contrast(color, TRAY_BACKGROUND_COLOR) >= 4.5, `${color} is below 4.5:1`);
  }
  // The red warning is deliberately a little softer.
  assert.ok(contrast(TRAY_WEEKLY_LOW_COLOR, TRAY_BACKGROUND_COLOR) >= 4.0);
});
