import test from "node:test";
import assert from "node:assert/strict";
import { t } from "../src/shared/i18n";

test("t() resolves the same keys in zh and en", () => {
  const zhText = t("zh", "section.settings");
  const enText = t("en", "section.settings");
  assert.equal(zhText, "提醒設定");
  assert.equal(enText, "Reminder Settings");
});

test("t() interpolates {placeholder} params", () => {
  assert.equal(t("en", "settings.lowThreshold", { percent: 20 }), "Low quota alert threshold: 20%");
  assert.equal(t("zh", "settings.lowThreshold", { percent: 20 }), "低額度預警閾值：20%");
});

test("t() leaves unknown placeholders untouched", () => {
  assert.equal(t("en", "reason.lowQuotaNotify", { service: "Cursor" }), "Cursor quota is below {threshold}%");
});
