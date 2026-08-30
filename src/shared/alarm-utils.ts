import type {
  AlarmSource,
  AlarmTarget,
  AppSettings,
  CombinedSnapshot,
  Language,
  ServiceType
} from "./types";
import { t } from "./i18n";
import { resolveClaudeBillingAt } from "./claude-billing";
import { isTrusted } from "./snapshot-trust";

// setTimeout silently fires immediately once the delay exceeds a signed 32-bit
// int, so long waits are clamped here and re-armed by the caller on each tick.
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

// A firing this close behind schedule is just timer jitter, not a missed
// alarm, so it rings normally instead of being dropped as expired.
export const DUE_GRACE_MS = 60_000;

// The alarm popup always closes itself after this long — not user-configurable.
export const ALARM_POPUP_AUTO_DISMISS_SECONDS = 30;

export type FireClass = "pending" | "due" | "expired";

type ResetToggleKey =
  | "enableCursorResetAlarm"
  | "enableClaudeResetAlarm"
  | "enableClaudeWeeklyResetAlarm"
  | "enableClaudeBillingAlarm"
  | "enableCodexResetAlarm"
  | "enableCodexWeeklyResetAlarm";

const resetToggleMap: Record<AlarmSource, ResetToggleKey> = {
  "cursor-billing": "enableCursorResetAlarm",
  "claude-session": "enableClaudeResetAlarm",
  "claude-weekly": "enableClaudeWeeklyResetAlarm",
  "claude-billing": "enableClaudeBillingAlarm",
  "codex-session": "enableCodexResetAlarm",
  "codex-weekly": "enableCodexWeeklyResetAlarm"
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

/**
 * The reset times worth arming an alarm for.
 *
 * `lastGoodResets` carries the last reset time each source was seen with while
 * its snapshot was still trustworthy. A credential outage blanks `resetsAt`,
 * and without this fallback that would quietly disarm a real pending alarm —
 * the reset would come and go with nothing to show for it. A degraded snapshot
 * therefore keeps arming from what we last knew rather than from nothing.
 */
export const collectAlarmTargets = (
  snapshot: CombinedSnapshot,
  settings: AppSettings,
  lang: Language,
  lastGoodResets: Partial<Record<AlarmSource, string>> = {},
  nowMs = Date.now()
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
    },
    {
      id: "claude-billing",
      service: "claude",
      resetAt: resolveClaudeBillingAt(
        snapshot.claude.billingAnchorAt,
        snapshot.claude.billingResetAt,
        settings.claudeBillingCadence,
        nowMs
      ),
      label: snapshot.claude.billingResetLabel || t(lang, "fallback.claudeBilling")
    },
    {
      id: "codex-session",
      service: "codex",
      resetAt: snapshot.codex.resetsAt,
      label: snapshot.codex.resetLabel || t(lang, "window.label.session")
    },
    {
      id: "codex-weekly",
      service: "codex",
      resetAt: snapshot.codex.weeklyResetAt,
      label: snapshot.codex.weeklyResetLabel || t(lang, "window.label.weekly")
    }
  ];

  const targets: AlarmTarget[] = [];
  for (const spec of specs) {
    if (!settings[resetToggleMap[spec.id]]) {
      continue;
    }
    const trusted = isTrusted(snapshot[spec.service]);
    const resetAt = spec.resetAt || (trusted ? null : lastGoodResets[spec.id] ?? null);
    if (!resetAt || Number.isNaN(Date.parse(resetAt))) {
      continue;
    }
    targets.push({ id: spec.id, service: spec.service, fireAt: resetAt, label: spec.label });
  }
  return targets;
};

/**
 * Whether a firing that is now due may actually ring.
 *
 * An alarm only rings for a `fireAt` it watched go from pending to due. A reset
 * time first seen when it was already in the past is a hole in our own
 * observation — the app was closed, the credential was unreadable — not a reset
 * that just happened. Ringing for one is how a freshly recovered credential
 * used to announce a reset out of thin air.
 *
 * Sleep and restart catch-up is unaffected: the previous session recorded the
 * firing as pending before the machine went down.
 */
export const mayFire = (fireAt: string, observedFireAt: string | null | undefined): boolean =>
  Boolean(observedFireAt) && observedFireAt === fireAt;

export type AlarmAction = "schedule" | "fire" | "skip";

/**
 * What rearm() should do with one target right now.
 *
 * "due" (within DUE_GRACE_MS) and "expired" (later than that) used to be
 * handled differently — only "due" ever checked mayFire, so anything noticed
 * more than 60 seconds late (a laptop asleep across a reset, most commonly)
 * was silently dropped even when it had legitimately been watched go from
 * pending to due. Collapsing them here means both are judged the same way:
 * ring only for the exact fireAt this app watched arm while still in the
 * future, however late it was finally noticed.
 */
export const decideAlarmAction = (
  fireAt: string,
  nowMs: number,
  observedPendingFireAt: string | null | undefined
): AlarmAction => {
  if (classifyFire(fireAt, nowMs) === "pending") {
    return "schedule";
  }
  return mayFire(fireAt, observedPendingFireAt) ? "fire" : "skip";
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
