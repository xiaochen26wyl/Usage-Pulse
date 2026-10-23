import type { AppSettings, CombinedSnapshot, Language, QuotaSnapshot, ServiceType } from "./types";
import {
  TRAY_CLAUDE_LABEL_COLOR,
  TRAY_CODEX_LABEL_COLOR,
  TRAY_CURSOR_LABEL_COLOR,
  TRAY_WEEKLY_COLOR,
  TRAY_WEEKLY_LOW_COLOR,
  TRAY_WEEKLY_LOW_THRESHOLD_PERCENT
} from "./tray-value-color";

// Countdown units stay as the English single letters "d" / "h" / "m" in every
// UI language: the menu bar only has room for a glyph or two next to the
// number, and they read the same way in all four locales (zh/en/ja/ko).
export const COUNTDOWN_DAY_SUFFIX = "d";
export const COUNTDOWN_HOUR_SUFFIX = "h";
export const COUNTDOWN_MINUTE_SUFFIX = "m";
export const UNKNOWN_TRAY_VALUE = "?";

export const trayUnknownValueText = (lang: Language): string => (lang === "zh" ? "未知" : "N/A");

export const localizeTrayUnknownValue = (valueText: string, lang: Language): string =>
  valueText === UNKNOWN_TRAY_VALUE ? trayUnknownValueText(lang) : valueText;

// The plain top-level figure for a snapshot — what the tooltip shows and what
// the menu bar falls back to when no per-window value is available.
export const snapshotValueText = (snapshot: QuotaSnapshot): string => {
  if (snapshot.unit === "usd") {
    if (snapshot.remaining === null) {
      return UNKNOWN_TRAY_VALUE;
    }
    return `$${snapshot.remaining.toFixed(1)}`;
  }

  if (snapshot.unit === "percent") {
    const value = snapshot.remaining ?? snapshot.percent;
    if (value === null) {
      return UNKNOWN_TRAY_VALUE;
    }
    return `${Math.round(value)}%`;
  }

  return snapshot.remaining === null ? UNKNOWN_TRAY_VALUE : `${snapshot.remaining}`;
};

const findWindow = (snapshot: QuotaSnapshot, key: string): QuotaSnapshot["windows"][number] | null =>
  snapshot.windows.find((window) => window.key === key) ?? null;

// Once a quota window is exhausted, showing "0%" is dead information — the
// countdown to its reset is what's actually useful. Returns null when the
// window carries no reset time or the reset is already due.
export const formatCountdown = (resetsAt: string | null | undefined, nowMs: number): string | null => {
  if (!resetsAt) {
    return null;
  }
  const resetMs = new Date(resetsAt).getTime();
  if (Number.isNaN(resetMs)) {
    return null;
  }
  const msRemaining = resetMs - nowMs;
  if (msRemaining <= 0) {
    return null;
  }
  const hoursRemaining = msRemaining / (60 * 60 * 1000);
  if (hoursRemaining >= 1) {
    return `${hoursRemaining.toFixed(1)}${COUNTDOWN_HOUR_SUFFIX}`;
  }
  return `${Math.max(1, Math.round(msRemaining / 60000))}${COUNTDOWN_MINUTE_SUFFIX}`;
};

// Same idea as formatCountdown, but for Cursor's billing-cycle reset, which
// can be weeks out — so it counts down in whole days until under a day is
// left, then hands off to the h/m formatting above.
export const formatCountdownWithDays = (resetsAt: string | null | undefined, nowMs: number): string | null => {
  if (!resetsAt) {
    return null;
  }
  const resetMs = new Date(resetsAt).getTime();
  if (Number.isNaN(resetMs)) {
    return null;
  }
  const daysRemaining = (resetMs - nowMs) / (24 * 60 * 60 * 1000);
  if (daysRemaining >= 1) {
    return `${Math.round(daysRemaining)}${COUNTDOWN_DAY_SUFFIX}`;
  }
  return formatCountdown(resetsAt, nowMs);
};

// Cursor's cursor_models / other_models windows store `percent` as *used*
// (see collectors/cursor.ts); the menu bar always speaks in remaining%.
const cursorRemainingPercent = (snapshot: QuotaSnapshot, key: string): number | null => {
  const usedPercent = findWindow(snapshot, key)?.percent ?? null;
  if (usedPercent === null) {
    return null;
  }
  return Math.min(100, Math.max(0, 100 - usedPercent));
};

// Menu-bar priority for Cursor: Cursor's own models (cursor_models, the
// plan-included Grok/Composer allowance) first, since that's the quota that
// actually depletes as you use the product. Once it's exhausted, usage spills
// into the pay-as-you-go advanced-models window (other_models) and the tray
// switches to that. Once *both* are spent, show a countdown to the billing
// cycle reset instead of a dead "0%".
export const cursorTrayValueText = (snapshot: QuotaSnapshot, nowMs: number): string => {
  const modelsRemaining = cursorRemainingPercent(snapshot, "cursor_models");
  if (modelsRemaining !== null && Math.round(modelsRemaining) > 0) {
    return `${Math.round(modelsRemaining)}%`;
  }

  const advancedRemaining = cursorRemainingPercent(snapshot, "other_models");
  if (advancedRemaining !== null && Math.round(advancedRemaining) > 0) {
    return `${Math.round(advancedRemaining)}%`;
  }

  if (modelsRemaining !== null || advancedRemaining !== null) {
    return formatCountdownWithDays(snapshot.resetsAt, nowMs) ?? "0%";
  }

  return snapshotValueText(snapshot);
};

// Mirrors claudeCountdownTargetAt for Cursor: a reset time to tick against
// while a countdown is on screen, or null while only plain percentages are.
// With both windows present the menu bar shows both figures, so either one
// being spent puts a countdown on screen; with a single window it is the old
// "everything spent" rule.
export const cursorCountdownTargetAt = (snapshot: QuotaSnapshot): string | null => {
  const modelsRemaining = cursorRemainingPercent(snapshot, "cursor_models");
  const advancedRemaining = cursorRemainingPercent(snapshot, "other_models");
  const isSpent = (remaining: number | null): boolean => remaining === null || Math.round(remaining) <= 0;
  const hasData = modelsRemaining !== null || advancedRemaining !== null;
  const showsCountdown =
    modelsRemaining !== null && advancedRemaining !== null
      ? isSpent(modelsRemaining) || isSpent(advancedRemaining)
      : isSpent(modelsRemaining) && isSpent(advancedRemaining);
  if (!hasData || !showsCountdown) {
    return null;
  }
  return snapshot.resetsAt ?? null;
};

const cursorWindowText = (remaining: number, snapshot: QuotaSnapshot, nowMs: number): string =>
  Math.round(remaining) <= 0 ? (formatCountdownWithDays(snapshot.resetsAt, nowMs) ?? "0%") : `${Math.round(remaining)}%`;

// Menu-bar figures for Cursor when both model windows exist: Cursor's own
// models (Auto) as the main figure, advanced models as the second one. A spent
// window shows the billing-cycle countdown instead of a dead "0%". With only
// one window the main figure keeps cursorTrayValueText's fallback chain and
// there is no second figure.
export const cursorTrayColumnValueText = (snapshot: QuotaSnapshot, nowMs: number): string => {
  const modelsRemaining = cursorRemainingPercent(snapshot, "cursor_models");
  if (modelsRemaining !== null && cursorRemainingPercent(snapshot, "other_models") !== null) {
    return cursorWindowText(modelsRemaining, snapshot, nowMs);
  }
  return cursorTrayValueText(snapshot, nowMs);
};

export const cursorSecondaryTrayValueText = (snapshot: QuotaSnapshot, nowMs: number): string | null => {
  const advancedRemaining = cursorRemainingPercent(snapshot, "other_models");
  if (advancedRemaining === null || cursorRemainingPercent(snapshot, "cursor_models") === null) {
    return null;
  }
  return cursorWindowText(advancedRemaining, snapshot, nowMs);
};

export const cursorSecondaryRemainingPercent = (snapshot: QuotaSnapshot): number | null =>
  cursorSecondaryTrayValueText(snapshot, 0) === null ? null : cursorRemainingPercent(snapshot, "other_models");

// Menu-bar priority for Claude Code: the 5-hour session window first. Claude
// Code's top-level `remaining` is the max of the session and weekly windows,
// so read the session window directly rather than falling back to it. Once the
// session is spent, show the countdown to its reset instead of a flat "0%".
export const claudeTrayValueText = (snapshot: QuotaSnapshot, nowMs: number): string => {
  const session = findWindow(snapshot, "session");
  if (session && session.remaining !== null) {
    if (Math.round(session.remaining) <= 0) {
      return formatCountdown(session.resetsAt, nowMs) ?? "0%";
    }
    return `${Math.round(session.remaining)}%`;
  }
  return snapshotValueText(snapshot);
};

// While the session window is spent the menu bar shows a live countdown, and a
// countdown that only moves when the next poll lands is worse than useless.
// Returns the ISO reset time the tray should tick against, or null when the
// Claude slot is showing a plain percentage.
export const claudeCountdownTargetAt = (snapshot: QuotaSnapshot): string | null => {
  const session = findWindow(snapshot, "session");
  if (!session || session.remaining === null || Math.round(session.remaining) > 0) {
    return null;
  }
  return session.resetsAt ?? null;
};

// Same three-key fallback chain as monitor-engine.ts's findClaudeWeeklyWindow
// (duplicated deliberately: shared/ must not depend on main/).
export const findClaudeWeeklyWindow = (snapshot: QuotaSnapshot): QuotaSnapshot["windows"][number] | null =>
  findWindow(snapshot, "weekly_all") ?? findWindow(snapshot, "weekly_scoped") ?? findWindow(snapshot, "weekly");

// Mirrors claudeTrayValueText, but for the weekly window. Weekly resets can be
// days out, so the exhausted fallback counts down in days rather than hours.
export const claudeWeeklyTrayValueText = (snapshot: QuotaSnapshot, nowMs: number): string => {
  const weekly = findClaudeWeeklyWindow(snapshot);
  if (weekly && weekly.remaining !== null) {
    if (Math.round(weekly.remaining) <= 0) {
      return formatCountdownWithDays(weekly.resetsAt, nowMs) ?? "0%";
    }
    return `${Math.round(weekly.remaining)}%`;
  }
  return snapshotValueText(snapshot);
};

export const findCodexWeeklyWindow = (snapshot: QuotaSnapshot): QuotaSnapshot["windows"][number] | null =>
  findWindow(snapshot, "weekly");

export const codexTrayValueText = claudeTrayValueText;
export const codexCountdownTargetAt = claudeCountdownTargetAt;
export const codexWeeklyTrayValueText = (snapshot: QuotaSnapshot, nowMs: number): string => {
  const weekly = findCodexWeeklyWindow(snapshot);
  if (weekly && weekly.remaining !== null) {
    if (Math.round(weekly.remaining) <= 0) {
      return formatCountdownWithDays(weekly.resetsAt, nowMs) ?? "0%";
    }
    return `${Math.round(weekly.remaining)}%`;
  }
  return snapshotValueText(snapshot);
};

// ---- Menu-bar columns ----------------------------------------------------
// Each enabled service is one column (name over its live value); Claude Code
// and Codex may carry a weekly figure drawn right beside their column, with no
// name above it, in the service's own colour so it reads as theirs.

export const TRAY_SERVICE_LABELS: Record<ServiceType, string> = {
  cursor: "Cursor",
  claude: "Claude",
  codex: "Codex"
};

export const TRAY_SERVICE_COLORS: Record<ServiceType, string> = {
  cursor: TRAY_CURSOR_LABEL_COLOR,
  claude: TRAY_CLAUDE_LABEL_COLOR,
  codex: TRAY_CODEX_LABEL_COLOR
};

// Second figure beside a column: weekly remaining for Claude Code / Codex,
// advanced models for Cursor. `remaining` drives its colour.
export interface TrayWeeklyValue {
  value: string;
  remaining: number;
}
export type TrayWeeklyValues = Partial<Record<ServiceType, TrayWeeklyValue>>;

export interface TrayColumn {
  label: string;
  labelColor: string;
  value: string;
  weekly: { value: string; color: string } | null;
}

export const trayWeeklyColor = (remaining: number): string =>
  Math.round(remaining) <= TRAY_WEEKLY_LOW_THRESHOLD_PERCENT ? TRAY_WEEKLY_LOW_COLOR : TRAY_WEEKLY_COLOR;

export const trayColumns = (
  services: ServiceType[],
  valueFor: (service: ServiceType) => string,
  weekly: TrayWeeklyValues = {}
): TrayColumn[] =>
  services.map((service) => {
    const second = weekly[service];
    return {
      label: TRAY_SERVICE_LABELS[service],
      labelColor: TRAY_SERVICE_COLORS[service],
      value: valueFor(service),
      weekly: second ? { value: second.value, color: trayWeeklyColor(second.remaining) } : null
    };
  });

// Gated on the second window actually existing: the *WeeklyTrayValueText
// helpers fall back to the top-level figure when it's missing, which would put
// the session number in the weekly slot.
export const trayWeeklyValues = (
  snapshot: CombinedSnapshot,
  settings: Pick<
    AppSettings,
    "showWeeklyInTray" | "enableCursorMonitoring" | "enableClaudeMonitoring" | "enableCodexMonitoring"
  >,
  nowMs: number
): TrayWeeklyValues => {
  const values: TrayWeeklyValues = {};
  if (!settings.showWeeklyInTray) {
    return values;
  }
  const cursorRemaining = cursorSecondaryRemainingPercent(snapshot.cursor);
  const cursorText = cursorSecondaryTrayValueText(snapshot.cursor, nowMs);
  if (settings.enableCursorMonitoring && cursorRemaining !== null && cursorText !== null) {
    values.cursor = { value: cursorText, remaining: cursorRemaining };
  }
  const claudeWeekly = findClaudeWeeklyWindow(snapshot.claude);
  if (settings.enableClaudeMonitoring && claudeWeekly && claudeWeekly.remaining !== null) {
    values.claude = { value: claudeWeeklyTrayValueText(snapshot.claude, nowMs), remaining: claudeWeekly.remaining };
  }
  const codexWeekly = findCodexWeeklyWindow(snapshot.codex);
  if (settings.enableCodexMonitoring && codexWeekly && codexWeekly.remaining !== null) {
    values.codex = { value: codexWeeklyTrayValueText(snapshot.codex, nowMs), remaining: codexWeekly.remaining };
  }
  return values;
};

// Weekly figures move slowly, so the menu bar only refreshes them every 10
// minutes instead of on every poll / countdown redraw. Display-only: this never
// triggers a fetch.
export const TRAY_WEEKLY_REFRESH_MS = 10 * 60 * 1000;

export interface TrayWeeklyCache {
  values: TrayWeeklyValues;
  computedAtMs: number;
  signature: string;
}

export const trayWeeklySignature = (
  settings: Pick<
    AppSettings,
    "showWeeklyInTray" | "enableCursorMonitoring" | "enableClaudeMonitoring" | "enableCodexMonitoring" | "language"
  >
): string =>
  [
    settings.showWeeklyInTray,
    settings.enableCursorMonitoring,
    settings.enableClaudeMonitoring,
    settings.enableCodexMonitoring,
    settings.language
  ].join("|");

const sameKeys = (a: TrayWeeklyValues, b: TrayWeeklyValues): boolean =>
  Object.keys(a).sort().join(",") === Object.keys(b).sort().join(",");

// Refresh when there's no cache, 10 minutes have passed, a relevant setting
// changed, or a service gained/lost its weekly window (e.g. its first fetch
// landed) — so a figure never sits missing for 10 minutes after startup.
export const nextTrayWeeklyCache = (
  cache: TrayWeeklyCache | null,
  fresh: TrayWeeklyValues,
  nowMs: number,
  signature: string
): TrayWeeklyCache => {
  if (
    cache &&
    cache.signature === signature &&
    nowMs - cache.computedAtMs < TRAY_WEEKLY_REFRESH_MS &&
    nowMs >= cache.computedAtMs &&
    sameKeys(cache.values, fresh)
  ) {
    return cache;
  }
  return { values: fresh, computedAtMs: nowMs, signature };
};
