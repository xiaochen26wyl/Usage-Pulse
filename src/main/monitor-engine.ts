import { EventEmitter } from "node:events";
import type { AppSettings, CombinedSnapshot, MonitorResult, QuotaSnapshot, ScrapeResult, ServiceType } from "@shared/types";
import { getLowQuotaServices, isDuplicateInCooldown } from "@shared/monitor-utils";
import { scrapeQuota } from "@main/scrapers";
import { sendDesktopNotification } from "@main/notifiers";
import { notificationStore, settingsStore, snapshotStore } from "@main/store";
import { SERVICE_LABELS } from "./config";

type TriggerType = "scheduled" | "manual" | "startup";
type LowQuotaToggleKey = "enableCursorLowQuotaAlert" | "enableClaudeLowQuotaAlert";
type ResetToggleKey = "enableCursorResetAlarm" | "enableClaudeResetAlarm";

const nowIso = () => new Date().toISOString();

const toPercent = (remaining: number | null, total: number | null): number | null => {
  if (remaining === null || total === null || total <= 0) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round((remaining / total) * 100)));
};

const isLowQuota = (percent: number | null, settings: AppSettings): boolean =>
  percent !== null ? percent <= settings.lowThresholdPercent : false;

const lowQuotaToggleMap: Record<ServiceType, LowQuotaToggleKey> = {
  cursor: "enableCursorLowQuotaAlert",
  claude: "enableClaudeLowQuotaAlert"
};

const resetToggleMap: Record<ServiceType, ResetToggleKey> = {
  cursor: "enableCursorResetAlarm",
  claude: "enableClaudeResetAlarm"
};

const isToggleEnabled = (
  settings: AppSettings,
  toggleMap: Record<ServiceType, LowQuotaToggleKey | ResetToggleKey>,
  service: ServiceType
): boolean => settings[toggleMap[service]];

const makeQuotaSnapshot = (
  service: ServiceType,
  scrapeResult: ScrapeResult,
  settings: AppSettings
): QuotaSnapshot => {
  const { remaining, total, unit, resetsAt, resetLabel, weeklyResetAt, weeklyResetLabel, windows, message } = scrapeResult;
  const percent = toPercent(remaining, total);
  const low = isLowQuota(percent, settings);
  const hasError = /失敗|error/i.test(message);
  const status = hasError ? "error" : low ? "low" : remaining === null ? "unknown" : "ok";

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
    fetchedAt: nowIso()
  };
};

const hasChanged = (prev: CombinedSnapshot | null, next: CombinedSnapshot): boolean => {
  if (!prev) {
    return true;
  }
  return (
    prev.cursor.remaining !== next.cursor.remaining ||
    prev.cursor.total !== next.cursor.total ||
    prev.cursor.percent !== next.cursor.percent ||
    prev.cursor.unit !== next.cursor.unit ||
    prev.cursor.resetsAt !== next.cursor.resetsAt ||
    prev.cursor.weeklyResetAt !== next.cursor.weeklyResetAt ||
    JSON.stringify(prev.cursor.windows) !== JSON.stringify(next.cursor.windows) ||
    prev.claude.remaining !== next.claude.remaining ||
    prev.claude.total !== next.claude.total ||
    prev.claude.percent !== next.claude.percent ||
    prev.claude.unit !== next.claude.unit ||
    prev.claude.resetsAt !== next.claude.resetsAt ||
    prev.claude.weeklyResetAt !== next.claude.weeklyResetAt ||
    JSON.stringify(prev.claude.windows) !== JSON.stringify(next.claude.windows) ||
    prev.cursor.status !== next.cursor.status ||
    prev.claude.status !== next.claude.status
  );
};

const makeReason = (changed: boolean, lowServices: ServiceType[]): string => {
  if (changed && lowServices.length > 0) {
    const labels = lowServices.map((service) => SERVICE_LABELS[service]).join("、");
    return `配額變化，且 ${labels} 進入低額度預警`;
  }
  if (lowServices.length > 0) {
    const labels = lowServices.map((service) => SERVICE_LABELS[service]).join("、");
    return `${labels} 進入低額度預警`;
  }
  if (changed) {
    return "配額數值發生變化";
  }
  return "無變化";
};

export class MonitorEngine extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private resetAlarmTimers = new Map<string, NodeJS.Timeout>();

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
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const [, t] of this.resetAlarmTimers.entries()) {
      clearTimeout(t);
    }
    this.resetAlarmTimers.clear();
  }

  reschedule(): void {
    this.stop();
    const settings = settingsStore.get();
    const intervalMs = settings.intervalMinutes * 60_000;
    this.timer = setInterval(() => {
      this.runCheck("scheduled").catch((error) => {
        this.emit("error", error);
      });
    }, intervalMs);

    // Reapply alarms based on new settings
    const current = snapshotStore.get();
    if (current) {
      this.updateAlarms(current, settings).catch(e => console.error("[Usage-Pulse] Failed to reapply alarms", e));
    }
  }

  getLatestSnapshot(): CombinedSnapshot | null {
    return snapshotStore.get();
  }

  private async updateAlarms(snapshot: CombinedSnapshot, settings: AppSettings) {
    for (const timer of this.resetAlarmTimers.values()) {
      clearTimeout(timer);
    }
    this.resetAlarmTimers.clear();

    if (!settings.enableResetAlarm) {
      return;
    }

    const resetTargets = [
      {
        id: "cursor-billing",
        service: "cursor" as const,
        resetAt: snapshot.cursor.resetsAt,
        label: snapshot.cursor.resetLabel || "計費週期"
      },
      {
        id: "claude-session",
        service: "claude" as const,
        resetAt: snapshot.claude.resetsAt,
        label: snapshot.claude.resetLabel || "5 小時視窗"
      },
      {
        id: "claude-weekly",
        service: "claude" as const,
        resetAt: snapshot.claude.weeklyResetAt,
        label: snapshot.claude.weeklyResetLabel || "每週配額"
      }
    ];

    for (const target of resetTargets) {
      if (!isToggleEnabled(settings, resetToggleMap, target.service) || !target.resetAt) {
        continue;
      }

      const fireAtMs = Date.parse(target.resetAt);
      if (Number.isNaN(fireAtMs) || fireAtMs <= Date.now()) {
        continue;
      }

      const timer = setTimeout(() => {
        const latest = snapshotStore.get() ?? snapshot;
        const scope = `reset:${target.id}`;
        const key = `${target.id}|${target.resetAt}`;
        if (!this.shouldNotify(scope, key, settings)) {
          return;
        }
        sendDesktopNotification({
          snapshot: latest,
          reason: `${SERVICE_LABELS[target.service]} ${target.label} 已到重置時間`
        });
      }, fireAtMs - Date.now());

      this.resetAlarmTimers.set(target.id, timer);
    }
  }

  async runCheck(trigger: TriggerType): Promise<MonitorResult> {
    if (this.isRunning) {
      const current = snapshotStore.get();
      if (!current) {
        throw new Error("目前有檢查作業執行中，且尚未有可用快照。");
      }
      return {
        snapshot: current,
        changed: false,
        lowAlert: getLowQuotaServices(current).length > 0,
        notified: false,
        reason: "檢查作業執行中"
      };
    }

    this.isRunning = true;

    try {
      const settings = settingsStore.get();
      const previous = snapshotStore.get();
      const [cursorResult, claudeResult] = await Promise.all([
        scrapeQuota("cursor"),
        scrapeQuota("claude")
      ]);

      const snapshot: CombinedSnapshot = {
        cursor: makeQuotaSnapshot("cursor", cursorResult, settings),
        claude: makeQuotaSnapshot("claude", claudeResult, settings),
        fetchedAt: nowIso()
      };

      const changed = hasChanged(previous, snapshot);
      const lowServices = getLowQuotaServices(snapshot);
      const lowAlert = lowServices.length > 0;
      const reason = makeReason(changed, lowServices);
      let notified = false;

      if (changed) {
        const changeKey = JSON.stringify({
          cursor: {
            remaining: snapshot.cursor.remaining,
            total: snapshot.cursor.total,
            percent: snapshot.cursor.percent,
            status: snapshot.cursor.status
          },
          claude: {
            remaining: snapshot.claude.remaining,
            total: snapshot.claude.total,
            percent: snapshot.claude.percent,
            status: snapshot.claude.status
          }
        });
        if (this.shouldNotify("change", changeKey, settings)) {
          sendDesktopNotification({ snapshot, reason: "配額數值發生變化" });
          notified = true;
        }
      }

      for (const service of lowServices) {
        if (!isToggleEnabled(settings, lowQuotaToggleMap, service)) {
          continue;
        }
        const target = snapshot[service];
        const key = `${service}|${target.remaining}|${target.total}|${target.percent}|${target.status}`;
        if (!this.shouldNotify(`low:${service}`, key, settings)) {
          continue;
        }
        sendDesktopNotification({
          snapshot,
          reason: `${SERVICE_LABELS[service]} 額度低於 ${settings.lowThresholdPercent}%`
        });
        notified = true;
      }

      snapshotStore.set(snapshot);
      this.emit("snapshot", snapshot);

      // Update alarms with new snapshot
      await this.updateAlarms(snapshot, settings);

      return {
        snapshot,
        changed,
        lowAlert,
        notified,
        reason
      };
    } finally {
      this.isRunning = false;
    }
  }
}
