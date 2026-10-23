import test from "node:test";
import assert from "node:assert/strict";
import {
  ALERT_KEYS,
  LEGACY_ALERT_SETTING_KEYS,
  defaultAlertChannels,
  isAlertEnabled,
  isAlertLine,
  isAlertPopup,
  isLineEnabled,
  isLineInUse,
  normalizeAlertChannels,
  resolveAlertChannels
} from "../src/shared/notify-channels";
import type { AlertChannel, AlertKey } from "../src/shared/types";

const settingsOf = (
  patch: Partial<Record<AlertKey, AlertChannel>> = {},
  monitoring: { cursor?: boolean; claude?: boolean; codex?: boolean } = {}
) => ({
  alertChannels: { ...defaultAlertChannels(), ...patch },
  enableCursorMonitoring: monitoring.cursor ?? true,
  enableClaudeMonitoring: monitoring.claude ?? true,
  enableCodexMonitoring: monitoring.codex ?? true
});

const off: AlertChannel = { popup: false, line: false };

const allLineOffFor = (prefix: string): Partial<Record<AlertKey, AlertChannel>> =>
  Object.fromEntries(
    ALERT_KEYS.filter((key) => key.startsWith(prefix)).map((key) => [key, { popup: true, line: false }])
  );

test("defaults tick the popup everywhere and leave LINE off only for the 5-hour reset reminders", () => {
  const channels = defaultAlertChannels();
  for (const key of ALERT_KEYS) {
    assert.equal(channels[key].popup, true, key);
    assert.equal(channels[key].line, key !== "claude-session" && key !== "codex-session", key);
  }
});

test("a reminder with neither box ticked is off, and either box alone keeps it on", () => {
  const settings = settingsOf({
    "claude-session-low": off,
    "claude-weekly-low": { popup: false, line: true },
    "codex-session-low": { popup: true, line: false }
  });
  assert.equal(isAlertEnabled(settings, "claude-session-low"), false);
  assert.equal(isAlertEnabled(settings, "claude-weekly-low"), true);
  assert.equal(isAlertEnabled(settings, "codex-session-low"), true);
  assert.equal(isAlertPopup(settings, "claude-weekly-low"), false);
  assert.equal(isAlertLine(settings, "claude-weekly-low"), true);
});

test("isLineEnabled is true while any reminder of the service has LINE ticked", () => {
  const settings = settingsOf(allLineOffFor("claude-"));
  assert.equal(isLineEnabled(settings, "claude"), false);
  assert.equal(isLineEnabled(settings, "cursor"), true);
  assert.equal(isLineEnabled(settingsOf({ ...allLineOffFor("claude-"), "claude-billing": { popup: false, line: true } }), "claude"), true);
});

test("isLineInUse is true when any monitored service sends LINE", () => {
  assert.equal(isLineInUse(settingsOf()), true);
  assert.equal(isLineInUse(settingsOf({ ...allLineOffFor("cursor-"), ...allLineOffFor("claude-") })), true);
});

test("isLineInUse is false when no monitored service sends LINE", () => {
  const none = { ...allLineOffFor("cursor-"), ...allLineOffFor("claude-"), ...allLineOffFor("codex-") };
  assert.equal(isLineInUse(settingsOf(none)), false);
});

test("isLineInUse ignores LINE left ticked for a service that is not monitored", () => {
  const onlyCodex = { ...allLineOffFor("cursor-"), ...allLineOffFor("claude-") };
  assert.equal(isLineInUse(settingsOf(onlyCodex, { codex: false })), false);
});

test("normalizeAlertChannels fills missing or malformed entries from the fallback", () => {
  const fallback = defaultAlertChannels();
  fallback["claude-weekly-low"] = off;
  const result = normalizeAlertChannels(
    { "claude-session-low": { popup: false }, "codex-weekly": "yes", unknown: { popup: true, line: true } },
    fallback
  );
  assert.deepEqual(result["claude-session-low"], { popup: false, line: true });
  assert.deepEqual(result["codex-weekly"], defaultAlertChannels()["codex-weekly"]);
  assert.deepEqual(result["claude-weekly-low"], off);
  assert.equal(Object.keys(result).length, ALERT_KEYS.length);
  assert.deepEqual(normalizeAlertChannels(null), defaultAlertChannels());
  assert.deepEqual(normalizeAlertChannels([1, 2]), defaultAlertChannels());
});

test("resolveAlertChannels defaults every reminder when nothing was stored", () => {
  assert.deepEqual(resolveAlertChannels({}), defaultAlertChannels());
});

test("resolveAlertChannels prefers stored alertChannels over any legacy field", () => {
  const stored = { ...defaultAlertChannels(), "cursor-billing": off };
  assert.deepEqual(resolveAlertChannels({ alertChannels: stored, enableCursorResetAlarm: true }), stored);
});

test("resolveAlertChannels keeps a reminder that was switched off, off", () => {
  const resolved = resolveAlertChannels({ enableClaudeSessionLowAlert: false, enableCodexBillingAlarm: false });
  assert.deepEqual(resolved["claude-session-low"], off);
  assert.deepEqual(resolved["codex-billing"], off);
  assert.deepEqual(resolved["claude-weekly-low"], defaultAlertChannels()["claude-weekly-low"]);
});

test("resolveAlertChannels carries the per-service popup / LINE checkboxes onto each reminder", () => {
  const resolved = resolveAlertChannels({ enableClaudeAlarmPopup: false, enableCodexLineNotification: false });
  assert.deepEqual(resolved["claude-weekly-low"], { popup: false, line: true });
  assert.deepEqual(resolved["codex-weekly"], { popup: true, line: false });
  assert.deepEqual(resolved["cursor-billing"], { popup: true, line: true });
});

test("resolveAlertChannels falls back to the oldest global switches, and a service flag wins over them", () => {
  const resolved = resolveAlertChannels({
    enableAlarmPopup: false,
    enableLineNotification: false,
    enableClaudeAlarmPopup: true
  });
  assert.deepEqual(resolved["claude-session-low"], { popup: true, line: false });
  assert.deepEqual(resolved["cursor-models-low"], off);
});

test("resolveAlertChannels keeps the 5-hour reset reminders off LINE, as they always were", () => {
  const resolved = resolveAlertChannels({ enableClaudeLineNotification: true, enableCodexLineNotification: true });
  assert.equal(resolved["claude-session"].line, false);
  assert.equal(resolved["codex-session"].line, false);
  assert.equal(resolved["claude-session-low"].line, true);
});

test("resolveAlertChannels lets the weekly reset follow the 5-hour switch it used to share", () => {
  assert.equal(resolveAlertChannels({ enableClaudeResetAlarm: false })["claude-weekly"].popup, false);
  assert.equal(
    resolveAlertChannels({ enableClaudeResetAlarm: false, enableClaudeWeeklyResetAlarm: true })["claude-weekly"].popup,
    true
  );
});

test("resolveAlertChannels ignores non-boolean legacy values", () => {
  const resolved = resolveAlertChannels({ enableAlarmPopup: "no", enableClaudeLineNotification: 0 });
  assert.equal(resolved["cursor-models-low"].popup, true);
  assert.equal(resolved["claude-weekly-low"].line, true);
});

test("the legacy key list covers every flag the per-reminder model replaced", () => {
  assert.equal(LEGACY_ALERT_SETTING_KEYS.length, new Set(LEGACY_ALERT_SETTING_KEYS).size);
  for (const key of ["enableClaudeSessionLowAlert", "enableCursorResetAlarm", "enableCodexLineNotification", "enableAlarmPopup"]) {
    assert.ok(LEGACY_ALERT_SETTING_KEYS.includes(key), key);
  }
});
