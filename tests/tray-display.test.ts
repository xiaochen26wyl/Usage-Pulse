import test from "node:test";
import assert from "node:assert/strict";
import type { QuotaSnapshot, QuotaWindow } from "../src/shared/types";
import {
  claudeCountdownTargetAt,
  claudeTrayValueText,
  claudeWeeklyTrayValueText,
  codexCountdownTargetAt,
  codexTrayValueText,
  codexWeeklyTrayValueText,
  cursorCountdownTargetAt,
  cursorTrayValueText,
  findClaudeWeeklyWindow,
  formatCountdown,
  formatCountdownWithDays,
  snapshotValueText
} from "../src/shared/tray-display";

const NOW = Date.parse("2026-08-24T12:00:00.000Z");

const makeSnapshot = (
  service: QuotaSnapshot["service"],
  windows: Partial<QuotaWindow>[],
  overrides: Partial<QuotaSnapshot> = {}
): QuotaSnapshot => ({
  service,
  remaining: null,
  total: null,
  percent: null,
  unit: service === "cursor" ? "usd" : "percent",
  resetsAt: null,
  windows: windows.map((window) => ({
    key: window.key ?? "",
    label: window.label ?? "",
    remaining: window.remaining ?? null,
    total: window.total ?? null,
    percent: window.percent ?? null,
    resetsAt: window.resetsAt ?? null
  })),
  status: "ok",
  message: "",
  fetchedAt: new Date(NOW).toISOString(),
  ...overrides
});

const cursorSnapshot = (
  modelsUsed: number | null,
  advancedUsed: number | null,
  resetsAt: string | null = null
): QuotaSnapshot => {
  const windows: Partial<QuotaWindow>[] = [{ key: "billing_cycle", remaining: 12.34, total: 20 }];
  if (modelsUsed !== null) {
    windows.push({ key: "cursor_models", percent: modelsUsed });
  }
  if (advancedUsed !== null) {
    windows.push({ key: "other_models", percent: advancedUsed });
  }
  return makeSnapshot("cursor", windows, { remaining: 12.34, total: 20, resetsAt });
};

const claudeSnapshot = (sessionRemaining: number | null, resetsAt: string | null): QuotaSnapshot =>
  makeSnapshot("claude", [{ key: "session", remaining: sessionRemaining, percent: sessionRemaining, resetsAt }], {
    remaining: 80,
    percent: 80
  });

const claudeWeeklySnapshot = (
  weeklyKey: string,
  weeklyRemaining: number | null,
  resetsAt: string | null
): QuotaSnapshot =>
  makeSnapshot("claude", [{ key: weeklyKey, remaining: weeklyRemaining, percent: weeklyRemaining, resetsAt }], {
    remaining: 80,
    percent: 80
  });

test("cursor tray value shows cursor models while they last", () => {
  // cursor_models stores used%, so 58% used reads as 42% remaining.
  assert.equal(cursorTrayValueText(cursorSnapshot(58, 85), NOW), "42%");
});

test("cursor tray value falls back to advanced models once cursor models are spent", () => {
  assert.equal(cursorTrayValueText(cursorSnapshot(100, 85), NOW), "15%");
  // 99.7% used rounds to 0% remaining — treat it as spent and switch over.
  assert.equal(cursorTrayValueText(cursorSnapshot(99.7, 40), NOW), "60%");
});

test("cursor tray value counts down (in days) once both model windows are spent", () => {
  const resetsAt = new Date(NOW + 12 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(cursorTrayValueText(cursorSnapshot(100, 100, resetsAt), NOW), "12d");
});

test("cursor tray value shows 0% when both model windows are spent and no reset is known", () => {
  assert.equal(cursorTrayValueText(cursorSnapshot(100, 100), NOW), "0%");
});

test("cursor tray value falls back to the billing figure without model windows", () => {
  assert.equal(cursorTrayValueText(cursorSnapshot(null, null), NOW), "$12.3");
});

test("cursor tray value uses advanced models when cursor models are missing", () => {
  assert.equal(cursorTrayValueText(cursorSnapshot(null, 30), NOW), "70%");
});

test("claude tray value shows the 5-hour session percentage", () => {
  assert.equal(claudeTrayValueText(claudeSnapshot(63, null), NOW), "63%");
});

test("claude tray value counts down once the session window is spent", () => {
  const resetsAt = new Date(NOW + 3.2 * 60 * 60 * 1000).toISOString();
  assert.equal(claudeTrayValueText(claudeSnapshot(0, resetsAt), NOW), "3.2h");

  const soon = new Date(NOW + 45 * 60 * 1000).toISOString();
  assert.equal(claudeTrayValueText(claudeSnapshot(0, soon), NOW), "45m");
});

test("claude tray value keeps 0% when no reset time is known", () => {
  assert.equal(claudeTrayValueText(claudeSnapshot(0, null), NOW), "0%");
  assert.equal(claudeTrayValueText(claudeSnapshot(0, "not-a-date"), NOW), "0%");
  const past = new Date(NOW - 60 * 1000).toISOString();
  assert.equal(claudeTrayValueText(claudeSnapshot(0, past), NOW), "0%");
});

test("claude tray value falls back to the snapshot figure without a session window", () => {
  assert.equal(claudeTrayValueText(makeSnapshot("claude", [], { remaining: 80, percent: 80 }), NOW), "80%");
});

test("claude weekly tray value shows the weekly percentage", () => {
  assert.equal(claudeWeeklyTrayValueText(claudeWeeklySnapshot("weekly_all", 47, null), NOW), "47%");
});

test("claude weekly tray value counts down in days once the weekly window is spent", () => {
  const resetsAt = new Date(NOW + 4.2 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(claudeWeeklyTrayValueText(claudeWeeklySnapshot("weekly_all", 0, resetsAt), NOW), "4d");

  const soon = new Date(NOW + 23 * 60 * 60 * 1000).toISOString();
  assert.equal(claudeWeeklyTrayValueText(claudeWeeklySnapshot("weekly_all", 0, soon), NOW), "23.0h");
});

test("claude weekly tray value falls back to the snapshot figure without a weekly window", () => {
  assert.equal(claudeWeeklyTrayValueText(makeSnapshot("claude", [], { remaining: 80, percent: 80 }), NOW), "80%");
});

test("findClaudeWeeklyWindow prefers weekly_all, then weekly_scoped, then weekly", () => {
  const allOnly = claudeWeeklySnapshot("weekly_all", 10, null);
  assert.equal(findClaudeWeeklyWindow(allOnly)?.key, "weekly_all");

  const scopedOnly = claudeWeeklySnapshot("weekly_scoped", 10, null);
  assert.equal(findClaudeWeeklyWindow(scopedOnly)?.key, "weekly_scoped");

  const plainOnly = claudeWeeklySnapshot("weekly", 10, null);
  assert.equal(findClaudeWeeklyWindow(plainOnly)?.key, "weekly");

  const none = makeSnapshot("claude", []);
  assert.equal(findClaudeWeeklyWindow(none), null);
});

test("formatCountdown switches units at one hour and never shows 0m", () => {
  assert.equal(formatCountdown(new Date(NOW + 60 * 60 * 1000).toISOString(), NOW), "1.0h");
  assert.equal(formatCountdown(new Date(NOW + 59.9 * 60 * 1000).toISOString(), NOW), "60m");
  assert.equal(formatCountdown(new Date(NOW + 5 * 1000).toISOString(), NOW), "1m");
  assert.equal(formatCountdown(null, NOW), null);
});

test("claudeCountdownTargetAt only reports a target while the session is spent", () => {
  const resetsAt = new Date(NOW + 60 * 60 * 1000).toISOString();
  assert.equal(claudeCountdownTargetAt(claudeSnapshot(0, resetsAt)), resetsAt);
  assert.equal(claudeCountdownTargetAt(claudeSnapshot(20, resetsAt)), null);
  assert.equal(claudeCountdownTargetAt(claudeSnapshot(0, null)), null);
});

test("formatCountdownWithDays switches to days at 24 hours and hands off to h/m under that", () => {
  assert.equal(formatCountdownWithDays(new Date(NOW + 24 * 60 * 60 * 1000).toISOString(), NOW), "1d");
  assert.equal(formatCountdownWithDays(new Date(NOW + 12.3 * 24 * 60 * 60 * 1000).toISOString(), NOW), "12d");
  assert.equal(formatCountdownWithDays(new Date(NOW + 23 * 60 * 60 * 1000).toISOString(), NOW), "23.0h");
  assert.equal(formatCountdownWithDays(null, NOW), null);
});

test("cursorCountdownTargetAt only reports a target once both model windows are spent", () => {
  const resetsAt = new Date(NOW + 12 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(cursorCountdownTargetAt(cursorSnapshot(100, 100, resetsAt)), resetsAt);
  assert.equal(cursorCountdownTargetAt(cursorSnapshot(20, 100, resetsAt)), null);
  assert.equal(cursorCountdownTargetAt(cursorSnapshot(null, null, resetsAt)), null);
});

test("snapshotValueText keeps the plain per-service figure for tooltips", () => {
  assert.equal(snapshotValueText(cursorSnapshot(58, 85)), "$12.3");
  assert.equal(snapshotValueText(claudeSnapshot(63, null)), "80%");
  assert.equal(snapshotValueText(makeSnapshot("cursor", [])), "?");
});

test("codex tray value mirrors the Claude remaining-percent window", () => {
  const snapshot = makeSnapshot(
    "codex",
    [{ key: "session", remaining: 63, percent: 63, resetsAt: new Date(NOW + 60 * 60 * 1000).toISOString() }],
    { remaining: 63, percent: 63 }
  );
  assert.equal(codexTrayValueText(snapshot, NOW), "63%");
  assert.equal(codexCountdownTargetAt(snapshot), null);
});

test("codex weekly tray value uses the weekly window and day countdown when spent", () => {
  const resetsAt = new Date(NOW + 2 * 24 * 60 * 60 * 1000).toISOString();
  const snapshot = makeSnapshot("codex", [{ key: "weekly", remaining: 0, percent: 0, resetsAt }], {
    remaining: 0,
    percent: 0
  });
  assert.equal(codexWeeklyTrayValueText(snapshot, NOW), "2d");
});
