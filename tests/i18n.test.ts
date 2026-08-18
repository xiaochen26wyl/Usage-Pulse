import test from "node:test";
import assert from "node:assert/strict";
import { t } from "../src/shared/i18n";

test("t() resolves the same keys in zh and en", () => {
  const zhText = t("zh", "section.settings");
  const enText = t("en", "section.settings");
  assert.equal(zhText, "設定");
  assert.equal(enText, "Settings");
});

test("t() interpolates {placeholder} params", () => {
  assert.equal(t("en", "settings.checkInterval", { minutes: 10 }), "Check interval: 10 min");
  assert.equal(t("zh", "settings.checkInterval", { minutes: 10 }), "檢查頻率：10 分鐘");
});

test("t() leaves unknown placeholders untouched", () => {
  assert.equal(t("en", "reason.lowQuotaNotify", { service: "Cursor" }), "Cursor quota is below {threshold}%");
});
