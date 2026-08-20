import { EventEmitter } from "node:events";
import type { AppSettings, CombinedSnapshot, MonitorResult, QuotaSnapshot, ScrapeResult, ServiceType } from "@shared/types";
import { isDuplicateInCooldown } from "@shared/monitor-utils";
import { t } from "@shared/i18n";
import { alarmService } from "@main/alarm-service";
import { scrapeQuota } from "@main/scrapers";
import { sendDesktopNotification } from "@main/notifiers";
import { notificationStore, settingsStore, snapshotStore } from "@main/store";
import { SERVICE_LABELS } from "./config";

type TriggerType = "scheduled" | "manual" | "startup" | "credential";
type LowQuotaToggleKey = "enableCursorLowQuotaAlert" | "enableClaudeLowQuotaAlert";
type IntervalKey = "cursorIntervalMinutes" | "claudeIntervalMinutes";
type ThresholdKey = "cursorLowThresholdPercent" | "claudeLowThresholdPercent";

const nowIso = () => new Date().toISOString();

const toPercent = (remaining: number | null, total: number | null): number | null => {
  if (remaining === null || total === null || total <= 0) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round((remaining / total) * 100)));
};

const isLowQuota = (percent: number | null, threshold: number): boolean =>
  percent !== null ? percent <= threshold : false;

const lowQuotaToggleMap: Record<ServiceType, LowQuotaToggleKey> = {
  cursor: "enableCursorLowQuotaAlert",
  claude: "enableClaudeLowQuotaAlert"
};

const intervalKeyMap: Record<ServiceType, IntervalKey> = {
  cursor: "cursorIntervalMinutes",
  claude: "claudeIntervalMinutes"
};

const thresholdKeyMap: Record<ServiceType, ThresholdKey> = {
  cursor: "cursorLowThresholdPercent",
  claude: "claudeLowThresholdPercent"
};

const isToggleEnabled = (
  settings: AppSettings,
  toggleMap: Record<ServiceType, LowQuotaToggleKey>,
  service: ServiceType
): boolean => settings[toggleMap[service]];

const makeQuotaSnapshot = (
  service: ServiceType,
  scrapeResult: ScrapeResult,
  threshold: number
): QuotaSnapshot => {
  const { remaining, total, unit, resetsAt, resetLabel, weeklyResetAt, weeklyResetLabel, windows, message, isError, errorCode } = scrapeResult;
  const percent = toPercent(remaining, total);
  const low = isLowQuota(percent, threshold);
  const status = isError ? "error" : low ? "low" : remaining === null ? "unknown" : "ok";

  return {
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
      const threshold = settings[thresholdKeyMap[service]];
      const nextServiceSnapshot = makeQuotaSnapshot(service, scrapeResult, threshold);

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

      if (isLow && isToggleEnabled(settings, lowQuotaToggleMap, service)) {
        const key = `${service}|${nextServiceSnapshot.remaining}|${nextServiceSnapshot.total}|${nextServiceSnapshot.percent}|${nextServiceSnapshot.status}`;
        if (this.shouldNotify(`low:${service}`, key, settings)) {
          sendDesktopNotification({
            snapshot: combined,
            reason: t(lang, "reason.lowQuotaNotify", { service: SERVICE_LABELS[service], threshold })
          });
          notified = true;
        }
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
