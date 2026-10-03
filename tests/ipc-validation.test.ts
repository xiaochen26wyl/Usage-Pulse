import test from "node:test";
import assert from "node:assert/strict";
import {
  asAlarmHeight,
  asClipboardText,
  asHistoryService,
  asServiceType,
  asSettingsPatch
} from "../src/main/ipc-validation";
import { isSupportLink, THREADS_URL } from "../src/shared/support-links";

test("asServiceType accepts only the three real services", () => {
  assert.equal(asServiceType("cursor"), "cursor");
  assert.equal(asServiceType("claude"), "claude");
  assert.equal(asServiceType("codex"), "codex");
});

test("asServiceType rejects values that would become a store write path", () => {
  // `service` is interpolated into `credentials.${service}`, which electron-store
  // reads as a dot path — so anything unexpected here used to be a write
  // primitive aimed at the rest of the config file.
  assert.equal(asServiceType("__proto__"), null);
  assert.equal(asServiceType("settings"), null);
  assert.equal(asServiceType("settings.lineChannelAccessToken"), null);
  assert.equal(asServiceType("Cursor"), null);
  assert.equal(asServiceType(""), null);
  assert.equal(asServiceType(undefined), null);
  assert.equal(asServiceType({ toString: () => "cursor" }), null);
});

test("asSettingsPatch keeps known keys with the declared type", () => {
  const patch = asSettingsPatch({ language: "en", enableClaudeLineNotification: false, notifyCooldownMinutes: 30 });
  assert.deepEqual(patch, { language: "en", enableClaudeLineNotification: false, notifyCooldownMinutes: 30 });
});

test("asSettingsPatch drops the removed global popup / LINE switches and the water settings", () => {
  const patch = asSettingsPatch({ enableAlarmPopup: false, enableLineNotification: false, enableWaterReminder: true });
  assert.deepEqual(patch, {});
});

test("asSettingsPatch keeps the per-service popup and LINE switches", () => {
  const patch = asSettingsPatch({ enableCodexAlarmPopup: false, enableCursorLineNotification: false });
  assert.deepEqual(patch, { enableCodexAlarmPopup: false, enableCursorLineNotification: false });
});

test("asSettingsPatch keeps Codex settings keys", () => {
  const patch = asSettingsPatch({ enableCodexMonitoring: false, enableCodexResetAlarm: false });
  assert.deepEqual(patch, { enableCodexMonitoring: false, enableCodexResetAlarm: false });
});

test("asSettingsPatch drops unknown keys and mistyped values", () => {
  const patch = asSettingsPatch({
    language: "en",
    somethingInvented: "yes",
    __proto__: { polluted: true },
    enableClaudeLineNotification: "true",
    notifyCooldownMinutes: Number.NaN
  });
  assert.deepEqual(patch, { language: "en" });
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("asSettingsPatch refuses non-objects", () => {
  assert.deepEqual(asSettingsPatch(null), {});
  assert.deepEqual(asSettingsPatch("language=en"), {});
  assert.deepEqual(asSettingsPatch([["language", "en"]]), {});
});

test("asClipboardText allows the CLI command the UI copies, but no control characters", () => {
  assert.equal(asClipboardText("claude auth login"), "claude auth login");
  assert.equal(asClipboardText("claude\nrm -rf ~"), null);
  assert.equal(asClipboardText("x".repeat(257)), null);
  assert.equal(asClipboardText(42), null);
});

test("asAlarmHeight accepts a finite pixel height inside the popup range", () => {
  assert.equal(asAlarmHeight(176), 176);
  assert.equal(asAlarmHeight(198.4), 198);
  assert.equal(asAlarmHeight(79), null);
  assert.equal(asAlarmHeight(481), null);
  assert.equal(asAlarmHeight(Number.NaN), null);
  assert.equal(asAlarmHeight("180"), null);
});

test("isSupportLink admits only the footer links", () => {
  assert.equal(isSupportLink(THREADS_URL), true);
  assert.equal(isSupportLink("https://example.com/"), false);
  assert.equal(isSupportLink(`${THREADS_URL}?x=1`), false);
  assert.equal(isSupportLink("file:///etc/passwd"), false);
  assert.equal(isSupportLink(undefined), false);
});

test("asHistoryService accepts only the two services that have clearable history", () => {
  assert.equal(asHistoryService("claude"), "claude");
  assert.equal(asHistoryService("codex"), "codex");
  // Cursor's conversations share a file with its credential: never deletable.
  assert.equal(asHistoryService("cursor"), null);
  assert.equal(asHistoryService("__proto__"), null);
  assert.equal(asHistoryService("Claude"), null);
  assert.equal(asHistoryService(undefined), null);
  assert.equal(asHistoryService({ toString: () => "claude" }), null);
});
