import { EventEmitter } from "node:events";
import type {
  AppSettings,
  CombinedSnapshot,
  LowQuotaAlertSource,
  MonitorResult,
  QuotaSnapshot,
  QuotaWindow,
  ScrapeResult,
  ServiceType
} from "@shared/types";
import { isDuplicateInCooldown } from "@shared/monitor-utils";
import { buildExhaustedFlex, buildLowQuotaFlex } from "@shared/line-templates";
import { t } from "@shared/i18n";
import { alarmService } from "@main/alarm-service";
import { showAlarmPopup } from "@main/alarm-window";
import { sendLineBroadcast } from "@main/line-notifier";
import { scrapeQuota } from "@main/scrapers";
import { sendDesktopNotification } from "@main/notifiers";
import { notificationStore, settingsStore, snapshotStore } from "@main/store";
import { SERVICE_LABELS } from "./config";

type TriggerType = "scheduled" | "manual" | "startup" | "credential";
type IntervalKey = "cursorIntervalMinutes" | "claudeIntervalMinutes";

const nowIso = () => new Date().toISOString();

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

const toPercent = (remaining: number | null, total: number | null): number | null => {
  if (remaining === null || total === null || total <= 0) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round((remaining / total) * 100)));
};

const findWindow = (windows: QuotaWindow[], key: string): QuotaWindow | null =>
  windows.find((window) => window.key === key) ?? null;

const findClaudeWeeklyWindow = (windows: QuotaWindow[]): QuotaWindow | null =>
  findWindow(windows, "weekly_all") ?? findWindow(windows, "weekly_scoped") ?? findWindow(windows, "weekly");

// Claude Code windows store `percent` as remaining%; low means it's at or
// below the threshold, same semantics as the old top-level check.
const isRemainingLow = (remainingPercent: number | null, threshold: number): boolean =>
  remainingPercent !== null && remainingPercent <= threshold;

// Cursor's cursor_models/other_models windows store `percent` as used% (see
// collectors/cursor.ts), so "low remaining" means used% is at or above
// (100 - threshold).
const isUsedLow = (usedPercent: number | null, threshold: number): boolean =>
  usedPercent !== null && clampPercent(100 - usedPercent) <= threshold;

// One window's alert-relevant state. `remainingPercent` is always *remaining*
// (Cursor's used% is converted here), so downstream notifications and LINE
// templates never have to care which way round a collector counts.
interface WindowState {
  low: boolean;
  exhausted: boolean;
  remainingPercent: number | null;
  resetsAt: string | null;
}

const cursorWindowState = (window: QuotaWindow | null, threshold: number): WindowState => {
  const usedPercent = window?.percent ?? null;
  const remainingPercent = usedPercent === null ? null : clampPercent(100 - usedPercent);
  return {
    low: isUsedLow(usedPercent, threshold),
    exhausted: remainingPercent !== null && remainingPercent <= 0,
    remainingPercent,
    resetsAt: window?.resetsAt ?? null
  };
};

const claudeWindowState = (window: QuotaWindow | null, threshold: number): WindowState => {
  const remainingPercent = window?.percent ?? null;
  return {
    low: isRemainingLow(remainingPercent, threshold),
    exhausted: remainingPercent !== null && remainingPercent <= 0,
    remainingPercent,
    resetsAt: window?.resetsAt ?? null
  };
};

interface CursorLowFlags {
  advancedModels: WindowState;
  models: WindowState;
}

interface ClaudeLowFlags {
  session: WindowState;
  weekly: WindowState;
  // The 5-hour window starts counting from first use (not from exhaustion), so
  // hitting 0% remaining means the user is locked out until resetsAt — a
  // distinct state from "getting low", surfaced as its own alert. It recovers
  // on its own, so it is *not* treated as "quota used up"; only the weekly
  // window earns that.
  cooldownActive: boolean;
}

const evaluateCursorLowFlags = (windows: QuotaWindow[], settings: AppSettings): CursorLowFlags => ({
  models: cursorWindowState(findWindow(windows, "cursor_models"), settings.cursorModelsLowThresholdPercent),
  advancedModels: cursorWindowState(findWindow(windows, "other_models"), settings.cursorAdvancedModelsLowThresholdPercent)
});

const evaluateClaudeLowFlags = (windows: QuotaWindow[], settings: AppSettings): ClaudeLowFlags => {
  const session = claudeWindowState(findWindow(windows, "session"), settings.claudeSessionLowThresholdPercent);
  return {
    session,
    weekly: claudeWindowState(findClaudeWeeklyWindow(windows), settings.claudeWeeklyLowThresholdPercent),
    cooldownActive: session.exhausted
  };
};

const intervalKeyMap: Record<ServiceType, IntervalKey> = {
  cursor: "cursorIntervalMinutes",
  claude: "claudeIntervalMinutes"
};

const makeQuotaSnapshot = (
  service: ServiceType,
  scrapeResult: ScrapeResult,
  settings: AppSettings
): { snapshot: QuotaSnapshot; cursorFlags: CursorLowFlags | null; claudeFlags: ClaudeLowFlags | null } => {
  const { remaining, total, unit, resetsAt, resetLabel, weeklyResetAt, weeklyResetLabel, windows, message, isError, errorCode } =
    scrapeResult;
  const percent = toPercent(remaining, total);

  const cursorFlags = service === "cursor" ? evaluateCursorLowFlags(windows, settings) : null;
  const claudeFlags = service === "claude" ? evaluateClaudeLowFlags(windows, settings) : null;
  const anyLow = cursorFlags
    ? cursorFlags.advancedModels.low || cursorFlags.models.low
    : claudeFlags
      ? claudeFlags.session.low || claudeFlags.weekly.low
      : false;

  const status = isError ? "error" : anyLow ? "low" : remaining === null ? "unknown" : "ok";

  return {
    snapshot: {
      service,
      remaining,
      total,
      percent,
      unit,
      resetsAt,
      resetLabel,
      weeklyResetAt,
      weeklyResetLabel,
      windows,
      status,
      message,
      errorCode,
      fetchedAt: nowIso()
    },
    cursorFlags,
    claudeFlags
  };
};

const hasServiceChanged = (prev: QuotaSnapshot | null, next: QuotaSnapshot): boolean => {
  if (!prev) {
    return true;
  }
  return (
    prev.remaining !== next.remaining ||
    prev.total !== next.total ||
    prev.percent !== next.percent ||
    prev.unit !== next.unit ||
    prev.resetsAt !== next.resetsAt ||
    prev.weeklyResetAt !== next.weeklyResetAt ||
    prev.status !== next.status ||
    JSON.stringify(prev.windows) !== JSON.stringify(next.windows)
  );
};

const makeReason = (changed: boolean, lowServices: ServiceType[], lang: AppSettings["language"]): string => {
  if (changed && lowServices.length > 0) {
    const labels = lowServices.map((service) => SERVICE_LABELS[service]).join("、");
    return t(lang, "reason.changedAndLow", { labels });
  }
  if (lowServices.length > 0) {
    const labels = lowServices.map((service) => SERVICE_LABELS[service]).join("、");
    return t(lang, "reason.low", { labels });
  }
  if (changed) {
    return t(lang, "reason.changed");
  }
  return t(lang, "reason.noChange");
};

const SERVICES: ServiceType[] = ["cursor", "claude"];

export class MonitorEngine extends EventEmitter {
  private timers: Record<ServiceType, NodeJS.Timeout | null> = { cursor: null, claude: null };
  private isRunning: Record<ServiceType, boolean> = { cursor: false, claude: false };

  private shouldNotify(scope: string, key: string, settings: AppSettings): boolean {
    const cooldownMs = settings.notifyCooldownMinutes * 60_000;
    const nowMs = Date.now();
    const last = notificationStore.get(scope);
    if (isDuplicateInCooldown(last, key, cooldownMs, nowMs)) {
      return false;
    }
    notificationStore.set(scope, key, nowIso());
    return true;
  }

  start(): void {
    this.reschedule();
  }

  stop(): void {
    for (const service of SERVICES) {
      const timer = this.timers[service];
      if (timer) {
        clearInterval(timer);
        this.timers[service] = null;
      }
    }
    alarmService.stop();
  }

  reschedule(): void {
    this.stop();
    const settings = settingsStore.get();

    for (const service of SERVICES) {
      const intervalMs = settings[intervalKeyMap[service]] * 60_000;
      this.timers[service] = setInterval(() => {
        this.checkService(service, "scheduled").catch((error) => {
          this.emit("error", error);
        });
      }, intervalMs);
    }

    // Reapply alarms based on new settings
    alarmService.rearm("settings");
  }

  getLatestSnapshot(): CombinedSnapshot | null {
    return snapshotStore.get();
  }

  // Fires one low-quota-style alert independently: its own desktop
  // notification, its own LINE bubble, and, if enabled, its own alarm popup —
  // deduped per alert id so it doesn't repeat every poll while the underlying
  // state is unchanged.
  private fireLowQuotaAlert(options: {
    id: LowQuotaAlertSource;
    service: ServiceType;
    // "exhausted" picks the red LINE template; everything else is accented
    // with the service's own colour.
    kind: "low" | "exhausted";
    dedupeKey: string;
    label: string;
    reason: string;
    settings: AppSettings;
    combined: CombinedSnapshot;
    remainingPercent?: number | null;
    thresholdPercent?: number;
    resetAt?: string | null;
    countdownTarget?: string | null;
  }): boolean {
    const { id, service, kind, dedupeKey, label, reason, settings, combined, countdownTarget } = options;
    if (!this.shouldNotify(`lowquota:${id}`, dedupeKey, settings)) {
      return false;
    }

    sendDesktopNotification({ snapshot: combined, reason });

    const templateOptions = {
      service,
      serviceLabel: SERVICE_LABELS[service],
      windowLabel: label,
      remainingPercent: options.remainingPercent,
      thresholdPercent: options.thresholdPercent,
      resetAt: options.resetAt ?? countdownTarget ?? null,
      lang: settings.language
    };
    void sendLineBroadcast(
      kind === "exhausted" ? buildExhaustedFlex(templateOptions) : buildLowQuotaFlex(templateOptions)
    );

    if (settings.enableAlarmPopup) {
      showAlarmPopup({
        id,
        service,
        label,
        fireAt: nowIso(),
        soundEnabled: settings.alarmSoundEnabled,
        language: settings.language,
        countdownTarget: countdownTarget ?? null
      });
    }

    return true;
  }

  /**
   * Fires one window's alert, if it has one to fire.
   *
   * "Used up" supersedes "running low" for the same window: a spent window is
   * necessarily under its threshold too, and sending both is the same news
   * twice. A window with no exhausted id of its own (Claude Code's 5-hour
   * session, which has the cooldown alert instead) only ever fires the low one.
   */
  private fireWindowAlert(options: {
    service: ServiceType;
    state: WindowState;
    lowId: LowQuotaAlertSource;
    exhaustedId?: LowQuotaAlertSource;
    label: string;
    threshold: number;
    settings: AppSettings;
    combined: CombinedSnapshot;
    lang: AppSettings["language"];
    fallbackResetAt: string | null;
  }): boolean {
    const { service, state, lowId, exhaustedId, label, threshold, settings, combined, lang } = options;
    const resetAt = state.resetsAt ?? options.fallbackResetAt;
    const serviceLabel = SERVICE_LABELS[service];

    if (exhaustedId && state.exhausted) {
      return this.fireLowQuotaAlert({
        id: exhaustedId,
        service,
        kind: "exhausted",
        // Keyed by the reset time rather than the threshold: a window parked at
        // 0% would otherwise re-alert every notifyCooldownMinutes, while a new
        // cycle that runs dry again deserves its own alert.
        dedupeKey: resetAt ?? "exhausted",
        label,
        reason: t(lang, "reason.quotaExhaustedNotify", {
          service: serviceLabel,
          label,
          resetTime: resetAt ? new Date(resetAt).toLocaleString(lang === "zh" ? "zh-TW" : "en-US") : t(lang, "app.unknown")
        }),
        settings,
        combined,
        remainingPercent: 0,
        resetAt,
        countdownTarget: resetAt
      });
    }

    if (!state.low) {
      return false;
    }

    return this.fireLowQuotaAlert({
      id: lowId,
      service,
      kind: "low",
      dedupeKey: `${threshold}`,
      label,
      reason: t(lang, "reason.lowQuotaNotify", { service: `${serviceLabel}·${label}`, threshold }),
      settings,
      combined,
      remainingPercent: state.remainingPercent,
      thresholdPercent: threshold,
      resetAt
    });
  }

  private handleCursorLowAlerts(
    flags: CursorLowFlags,
    settings: AppSettings,
    combined: CombinedSnapshot,
    lang: AppSettings["language"]
  ): boolean {
    let notified = false;
    const fallbackResetAt = combined.cursor.resetsAt;

    if (settings.enableCursorAdvancedModelsLowAlert) {
      notified =
        this.fireWindowAlert({
          service: "cursor",
          state: flags.advancedModels,
          lowId: "cursor-advanced-models-low",
          exhaustedId: "cursor-advanced-models-exhausted",
          label: t(lang, "alertLabel.cursorAdvancedModels"),
          threshold: settings.cursorAdvancedModelsLowThresholdPercent,
          settings,
          combined,
          lang,
          fallbackResetAt
        }) || notified;
    }

    if (settings.enableCursorModelsLowAlert) {
      notified =
        this.fireWindowAlert({
          service: "cursor",
          state: flags.models,
          lowId: "cursor-models-low",
          exhaustedId: "cursor-models-exhausted",
          label: t(lang, "alertLabel.cursorModels"),
          threshold: settings.cursorModelsLowThresholdPercent,
          settings,
          combined,
          lang,
          fallbackResetAt
        }) || notified;
    }

    return notified;
  }

  private handleClaudeLowAlerts(
    flags: ClaudeLowFlags,
    settings: AppSettings,
    combined: CombinedSnapshot,
    lang: AppSettings["language"]
  ): boolean {
    let notified = false;
    const claudeSnapshot = combined.claude;

    if (settings.enableClaudeSessionLowAlert) {
      notified =
        this.fireWindowAlert({
          service: "claude",
          state: flags.session,
          lowId: "claude-session-low",
          label: t(lang, "alertLabel.claudeSession"),
          threshold: settings.claudeSessionLowThresholdPercent,
          settings,
          combined,
          lang,
          fallbackResetAt: claudeSnapshot.resetsAt
        }) || notified;
    }

    if (settings.enableClaudeWeeklyLowAlert) {
      notified =
        this.fireWindowAlert({
          service: "claude",
          state: flags.weekly,
          lowId: "claude-weekly-low",
          exhaustedId: "claude-weekly-exhausted",
          label: t(lang, "alertLabel.claudeWeekly"),
          threshold: settings.claudeWeeklyLowThresholdPercent,
          settings,
          combined,
          lang,
          fallbackResetAt: claudeSnapshot.weeklyResetAt ?? null
        }) || notified;
    }

    // Deduped by resetsAt (not by a fixed cooldown window), so a fresh
    // cooldown period always gets its own popup even if the previous one
    // notified recently, while re-polling during the *same* cooldown period
    // still re-reminds at the normal notifyCooldownMinutes cadence.
    if (settings.enableClaudeCooldownAlert && flags.cooldownActive && claudeSnapshot.resetsAt) {
      const label = t(lang, "alertLabel.claudeCooldown");
      notified =
        this.fireLowQuotaAlert({
          id: "claude-cooldown",
          service: "claude",
          // Service colour, not the red "used up" template: the 5-hour window
          // refills on its own at resetsAt, nothing is spent for good.
          kind: "low",
          dedupeKey: claudeSnapshot.resetsAt,
          remainingPercent: 0,
          resetAt: claudeSnapshot.resetsAt,
          label,
          reason: t(lang, "reason.claudeCooldownNotify", {
            resetTime: new Date(claudeSnapshot.resetsAt).toLocaleString()
          }),
          settings,
          combined,
          countdownTarget: claudeSnapshot.resetsAt
        }) || notified;
    }

    return notified;
  }

  private async checkService(service: ServiceType, trigger: TriggerType): Promise<MonitorResult> {
    if (this.isRunning[service]) {
      const current = snapshotStore.get();
      const lang = settingsStore.get().language;
      if (!current) {
        throw new Error(t(lang, "error.checkInProgressNoSnapshot"));
      }
      return {
        snapshot: current,
        changed: false,
        lowAlert: current[service].status === "low",
        notified: false,
        reason: t(lang, "reason.checkInProgress")
      };
    }

    this.isRunning[service] = true;

    try {
      const settings = settingsStore.get();
      const lang = settings.language;
      const previousSnapshot = snapshotStore.get();
      const previousServiceSnapshot = previousSnapshot ? previousSnapshot[service] : null;

      const scrapeResult = await scrapeQuota(service);
      const { snapshot: nextServiceSnapshot, cursorFlags, claudeFlags } = makeQuotaSnapshot(service, scrapeResult, settings);

      // Re-read the store *after* the scrape awaits, right before merging and
      // writing back — the other service's independent checkService() call may
      // have completed and written its own update while this one was in flight.
      // Merging from a snapshot captured before the await would clobber that
      // update; reading fresh here (with no further await before the write)
      // guarantees this write only replaces this service's own key.
      const latestCombined = snapshotStore.get();
      const otherService: ServiceType = service === "cursor" ? "claude" : "cursor";
      const otherServiceSnapshot = latestCombined ? latestCombined[otherService] : nextServiceSnapshot;

      const combined: CombinedSnapshot = {
        cursor: service === "cursor" ? nextServiceSnapshot : otherServiceSnapshot,
        claude: service === "claude" ? nextServiceSnapshot : otherServiceSnapshot,
        fetchedAt: nowIso()
      };

      const changed = hasServiceChanged(previousServiceSnapshot, nextServiceSnapshot);
      const isLow = nextServiceSnapshot.status === "low";
      const reason = makeReason(changed, isLow ? [service] : [], lang);
      let notified = false;

      if (changed) {
        const changeKey = JSON.stringify({
          remaining: nextServiceSnapshot.remaining,
          total: nextServiceSnapshot.total,
          percent: nextServiceSnapshot.percent,
          status: nextServiceSnapshot.status
        });
        if (this.shouldNotify(`change:${service}`, changeKey, settings)) {
          sendDesktopNotification({ snapshot: combined, reason: t(lang, "reason.changed") });
          notified = true;
        }
      }

      if (cursorFlags) {
        notified = this.handleCursorLowAlerts(cursorFlags, settings, combined, lang) || notified;
      }
      if (claudeFlags) {
        notified = this.handleClaudeLowAlerts(claudeFlags, settings, combined, lang) || notified;
      }

      snapshotStore.set(combined);
      this.emit("snapshot", combined);

      // Update alarms with the latest combined snapshot
      alarmService.rearm("poll");

      return {
        snapshot: combined,
        changed,
        lowAlert: isLow,
        notified,
        reason
      };
    } finally {
      this.isRunning[service] = false;
    }
  }

  /**
   * Runs one service's check on its own.
   *
   * The credential sweep uses this to give a rotated or expired credential an
   * immediate chance to prove itself before anyone is notified; running both
   * services there would double the API traffic for no reason.
   */
  async runServiceCheck(service: ServiceType, trigger: TriggerType): Promise<MonitorResult> {
    return this.checkService(service, trigger);
  }

  async runCheck(trigger: TriggerType): Promise<MonitorResult> {
    const [cursorResult, claudeResult] = await Promise.all([
      this.checkService("cursor", trigger),
      this.checkService("claude", trigger)
    ]);

    const lang = settingsStore.get().language;
    const snapshot = this.getLatestSnapshot() ?? cursorResult.snapshot;
    const noChangeText = t(lang, "reason.noChange");
    const reasons = [cursorResult.reason, claudeResult.reason].filter((reason) => reason && reason !== noChangeText);

    return {
      snapshot,
      changed: cursorResult.changed || claudeResult.changed,
      lowAlert: cursorResult.lowAlert || claudeResult.lowAlert,
      notified: cursorResult.notified || claudeResult.notified,
      reason: reasons.length > 0 ? reasons.join("；") : noChangeText
    };
  }
}
