import type {
  AlarmSource,
  AlarmTarget,
  AppSettings,
  CombinedSnapshot,
  Language,
  ServiceType
} from "./types";
import { t } from "./i18n";

// setTimeout silently fires immediately once the delay exceeds a signed 32-bit
// int, so long waits are clamped here and re-armed by the caller on each tick.
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

// A firing this close behind schedule is just timer jitter, not a missed
// alarm, so it rings normally instead of being dropped as expired.
export const DUE_GRACE_MS = 60_000;

// The alarm popup always closes itself after this long — not user-configurable.
export const ALARM_POPUP_AUTO_DISMISS_MINUTES = 1;

export type FireClass = "pending" | "due" | "expired";

type ResetToggleKey = "enableCursorResetAlarm" | "enableClaudeResetAlarm";

const resetToggleMap: Record<ServiceType, ResetToggleKey> = {
  cursor: "enableCursorResetAlarm",
  claude: "enableClaudeResetAlarm"
};

export const clampTimeoutMs = (ms: number): number => {
  if (!Number.isFinite(ms)) {
    return 0;
  }
  return Math.max(0, Math.min(ms, MAX_TIMEOUT_MS));
};

/**
 * Where a scheduled firing sits relative to now.
 *
 * Anything more than DUE_GRACE_MS in the past is treated as expired rather
 * than replayed — there is no catch-up window to fall back on.
 */
export const classifyFire = (fireAt: string, nowMs: number): FireClass => {
  const fireAtMs = Date.parse(fireAt);
  if (Number.isNaN(fireAtMs)) {
    return "expired";
  }

  const lateMs = nowMs - fireAtMs;
  if (lateMs < 0) {
    return "pending";
  }
  if (lateMs <= DUE_GRACE_MS) {
    return "due";
  }
  return "expired";
};

// Shared by the main window (settings countdowns) and the alarm popup
// (cooldown countdown) so both render the same "Dd HH:MM:SS" format.
export const formatCountdown = (iso: string | null, nowMs: number, lang: Language): string => {
  if (!iso) return t(lang, "app.unknown");
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return t(lang, "app.unknown");

  const diff = date.getTime() - nowMs;
  if (diff <= 0) return t(lang, "app.alreadyReset");

  const seconds = Math.floor(diff / 1000) % 60;
  const minutes = Math.floor(diff / 60000) % 60;
  const hours = Math.floor(diff / 3600000) % 24;
  const days = Math.floor(diff / 86400000);

  if (days > 0) return t(lang, "app.countdown.days", { days, hours, minutes });
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

export const collectAlarmTargets = (
  snapshot: CombinedSnapshot,
  settings: AppSettings,
  lang: Language
): AlarmTarget[] => {
  const specs: Array<{ id: AlarmSource; service: ServiceType; resetAt: string | null | undefined; label: string }> = [
    {
      id: "cursor-billing",
      service: "cursor",
      resetAt: snapshot.cursor.resetsAt,
      label: snapshot.cursor.resetLabel || t(lang, "fallback.billingCycle")
    },
    {
      id: "claude-session",
      service: "claude",
      resetAt: snapshot.claude.resetsAt,
      label: snapshot.claude.resetLabel || t(lang, "window.label.session")
    },
    {
      id: "claude-weekly",
      service: "claude",
      resetAt: snapshot.claude.weeklyResetAt,
      label: snapshot.claude.weeklyResetLabel || t(lang, "window.label.weekly")
    }
  ];

  const targets: AlarmTarget[] = [];
  for (const spec of specs) {
    if (!settings[resetToggleMap[spec.service]] || !spec.resetAt) {
      continue;
    }
    if (Number.isNaN(Date.parse(spec.resetAt))) {
      continue;
    }
    targets.push({ id: spec.id, service: spec.service, fireAt: spec.resetAt, label: spec.label });
  }
  return targets;
};

export const nextTarget = (targets: AlarmTarget[], nowMs: number): AlarmTarget | null => {
  let best: AlarmTarget | null = null;
  let bestMs = Number.POSITIVE_INFINITY;

  for (const target of targets) {
    const fireAtMs = Date.parse(target.fireAt);
    if (Number.isNaN(fireAtMs) || fireAtMs <= nowMs) {
      continue;
    }
    if (fireAtMs < bestMs) {
      best = target;
      bestMs = fireAtMs;
    }
  }
  return best;
};
