import test from "node:test";
import assert from "node:assert/strict";
import { localeForLanguage, t } from "../src/shared/i18n";
import type { Language } from "../src/shared/types";

const langs: Language[] = ["zh", "en", "ja", "ko"];

test("t() resolves the same keys in zh and en", () => {
  const zhText = t("zh", "section.settings");
  const enText = t("en", "section.settings");
  assert.equal(zhText, "提醒設定");
  assert.equal(enText, "Reminder Settings");
});

test("t() interpolates {placeholder} params", () => {
  assert.equal(t("en", "settings.lowThreshold", { percent: 20 }), "Low quota alert threshold: 20%");
  assert.equal(t("zh", "settings.lowThreshold", { percent: 20 }), "低額度預警閾值：20%");
  assert.equal(t("ja", "settings.lowThreshold", { percent: 20 }), "低クォータ警告しきい値：20%");
  assert.equal(t("ko", "settings.lowThreshold", { percent: 20 }), "낮은 할당량 경고 임계값: 20%");
  assert.equal(t("zh", "alarm.popup.title.cooldown", { service: "Codex" }), "Codex 5小時冷卻");
  assert.equal(t("zh", "alarm.popup.title.sessionLow", { service: "Codex" }), "Codex 5小時即將用完");
  assert.equal(t("zh", "alarm.popup.title.sessionReset", { service: "Claude Code" }), "Claude Code 5小時已重置");
  assert.equal(t("zh", "alarm.popup.nextAvailable", { time: "14:22" }), "下次可用 14:22");
  assert.equal(t("zh", "alarm.popup.nowAvailable"), "現在可用");
  assert.equal(t("zh", "alarm.autoDismiss", { seconds: 30 }), "彈窗 30 秒後自動關閉");
  assert.equal(t("zh", "water.popup.drink"), "我喝了。");
});

test("t() leaves unknown placeholders untouched", () => {
  assert.equal(t("en", "reason.lowQuotaNotify", { service: "Cursor" }), "Cursor quota is below {threshold}%");
});

test("all languages resolve section.settings to a non-empty distinct string", () => {
  const values = langs.map((lang) => t(lang, "section.settings"));
  for (const value of values) {
    assert.ok(value.length > 0);
  }
  assert.equal(new Set(values).size, langs.length);
});

test("en/ja/ko keep English Support/Developer labels", () => {
  assert.equal(t("en", "footer.support"), "Support: XiaoChen");
  assert.equal(t("ja", "footer.support"), "Support: XiaoChen");
  assert.equal(t("ko", "footer.support"), "Support: XiaoChen");
  assert.equal(t("en", "footer.developer"), "Developer: W.Y. LI");
  assert.equal(t("ja", "footer.developer"), "Developer: W.Y. LI");
  assert.equal(t("ko", "footer.developer"), "Developer: W.Y. LI");
  assert.match(t("zh", "footer.support"), /客服/);
  assert.match(t("zh", "footer.developer"), /開發者/);
});

test("footer.license mentions non-commercial default in every language", () => {
  assert.match(t("zh", "footer.license"), /非商業/);
  assert.match(t("en", "footer.license"), /non-commercial/i);
  assert.match(t("ja", "footer.license"), /非商用/);
  assert.match(t("ko", "footer.license"), /비상업/);
});

test("the Keychain re-detect keys resolve to a non-empty, distinct string in every language", () => {
  const keys = [
    "setupToken.keychainFound",
    "setupToken.keychainWriteFailed",
    "button.refreshQuota",
    "button.refreshQuota.tooltip",
    "button.redetect.tooltip",
    "setupToken.quotaUpdated"
  ] as const;
  for (const key of keys) {
    const values = langs.map((lang) => t(lang, key));
    for (const value of values) {
      assert.ok(value.length > 0, `${key} is empty`);
      assert.notEqual(value, key, `${key} did not resolve to a translation`);
    }
    assert.equal(new Set(values).size, langs.length, `${key} is not distinct across languages`);
  }
});

test("the manual token setup keys resolve to a non-empty, distinct string in every language", () => {
  const keys = [
    "manualToken.prompt",
    "manualToken.copyCommand",
    "manualToken.copied",
    "manualToken.inputPlaceholder",
    "manualToken.submit",
    "manualToken.invalidFormat",
    "manualToken.saved",
    "claudeLogin.hint",
    "claudeLogin.exited"
  ] as const;
  for (const key of keys) {
    const values = langs.map((lang) => t(lang, key));
    for (const value of values) {
      assert.ok(value.length > 0, `${key} is empty`);
      assert.notEqual(value, key, `${key} did not resolve to a translation`);
    }
    assert.equal(new Set(values).size, langs.length, `${key} is not distinct across languages`);
  }
});

test("the quit-status keys resolve to a non-empty, distinct string in every language", () => {
  const keys = ["line.tpl.quitTitle", "line.tpl.altQuit", "window.label.cursorOverall"] as const;
  for (const key of keys) {
    const values = langs.map((lang) => t(lang, key));
    for (const value of values) {
      assert.ok(value.length > 0, `${key} is empty`);
      assert.notEqual(value, key, `${key} did not resolve to a translation`);
    }
    assert.equal(new Set(values).size, langs.length, `${key} is not distinct across languages`);
  }
});

test("localeForLanguage maps each UI language", () => {
  assert.equal(localeForLanguage("zh"), "zh-TW");
  assert.equal(localeForLanguage("en"), "en-US");
  assert.equal(localeForLanguage("ja"), "ja-JP");
  assert.equal(localeForLanguage("ko"), "ko-KR");
});
