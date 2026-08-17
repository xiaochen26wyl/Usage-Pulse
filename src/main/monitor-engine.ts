import { EventEmitter } from "node:events";
import type { AppSettings, CombinedSnapshot, MonitorResult, QuotaSnapshot, ScrapeResult, ServiceType } from "@shared/types";
import { scrapeQuota } from "@main/scrapers";
import { sendDesktopNotification, sendLineFlexMessage } from "@main/notifiers";
import { notificationStore, settingsStore, snapshotStore } from "@main/store";
import { getSystemAlarmManager } from "./system-alarm";

type TriggerType = "scheduled" | "manual" | "startup";

const nowIso = () => new Date().toISOString();

const toPercent = (remaining: number | null, total: number | null): number | null => {
  if (remaining === null || total === null || total <= 0) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round((remaining / total) * 100)));
};

const isLowQuota = (percent: number | null, settings: AppSettings): boolean =>
  percent !== null ? percent <= settings.lowThresholdPercent : false;

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

const hasLowAlert = (snapshot: CombinedSnapshot): boolean =>
  snapshot.cursor.status === "low";

const makeReason = (changed: boolean, lowAlert: boolean): string => {
  if (lowAlert && changed) {
    return "配額變化，且進入低額度預警";
  }
  if (lowAlert) {
    return "進入低額度預警";
  }
  if (changed) {
    return "配額數值發生變化";
  }
  return "無變化";
};

export class MonitorEngine extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private resetAlarmTimers: Map<string, NodeJS.Timeout> = new Map();

  start(): void {
    this.reschedule();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const [key, t] of this.resetAlarmTimers.entries()) {
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
    const alarmManager = getSystemAlarmManager();
    const claude = snapshot.claude;
    
    const setOrClear = async (
      id: string, 
      title: string, 
      resetAt: string | null | undefined, 
      remainingInfo: string,
      label: string
    ) => {
      // clear existing internal timer
      if (this.resetAlarmTimers.has(id)) {
        clearTimeout(this.resetAlarmTimers.get(id));
        this.resetAlarmTimers.delete(id);
      }

      if (settings.enableResetAlarm && resetAt) {
        const timeToFire = new Date(resetAt).getTime() - Date.now();
        if (timeToFire > 0) {
          const body = `${label} 已重置。目前剩餘：${remainingInfo}`;
          if (alarmManager) {
            await alarmManager.upsert(id, resetAt, title, body);
          }

          // setup internal timer for LINE and fallback desktop
          const timerId = setTimeout(() => {
            if (settings.enableResetAlarmLine) {
              sendLineFlexMessage(settings, {
                snapshot,
                reason: `${label} 重置鬧鐘到點`
              }).catch(e => console.error("[Usage-Pulse] LINE alarm error", e));
            }
            if (!alarmManager) {
              sendDesktopNotification({ snapshot, reason: `${label} 重置鬧鐘到點` });
            }
          }, timeToFire);
          this.resetAlarmTimers.set(id, timerId);
        }
      } else {
        if (alarmManager) {
          await alarmManager.remove(id, title);
        }
      }
    };

    const sessionInfo = claude.percent !== null ? `${Math.round(claude.percent)}%` : "N/A";
    await setOrClear("claude-session", "Usage-Pulse Claude Session", claude.resetsAt, sessionInfo, "Claude 5 小時視窗");
    await setOrClear("claude-weekly", "Usage-Pulse Claude Weekly", claude.weeklyResetAt, sessionInfo, "Claude 週配額");

    // Low quota alarm check (immediate, not scheduled)
    if (settings.enableLowQuotaAlarm && claude.status === "low") {
      const key = `claude-low-alarm|${claude.remaining}|${claude.percent}`;
      const last = notificationStore.get();
      const cooldownMs = settings.notifyCooldownMinutes * 60_000;
      const lastAtMs = last.at ? Date.parse(last.at) : 0;
      const duplicateInCooldown = last.key === key && lastAtMs > 0 && Date.now() - lastAtMs < cooldownMs;

      if (!duplicateInCooldown) {
        const reason = "Claude 額度低於設定閾值";
        sendDesktopNotification({ snapshot, reason });
        if (settings.enableLowQuotaAlarmLine) {
          sendLineFlexMessage(settings, { snapshot, reason }).catch(e => console.error("[Usage-Pulse] LINE low alarm error", e));
        }
        notificationStore.set(key, nowIso());
      }
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
        lowAlert: hasLowAlert(current),
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
      const lowAlert = hasLowAlert(snapshot);
      const reason = makeReason(changed, lowAlert);
      let notified = false;

      if (changed || lowAlert) {
        const key = JSON.stringify({
          c: {
            remaining: snapshot.cursor.remaining,
            total: snapshot.cursor.total,
            percent: snapshot.cursor.percent,
            status: snapshot.cursor.status
          },
          a: {
            remaining: snapshot.claude.remaining,
            total: snapshot.claude.total,
            percent: snapshot.claude.percent,
            status: snapshot.claude.status
          },
          reason
        });
        const last = notificationStore.get();
        const cooldownMs = settings.notifyCooldownMinutes * 60_000;
        const lastAtMs = last.at ? Date.parse(last.at) : 0;
        const duplicateInCooldown =
          last.key === key && lastAtMs > 0 && Date.now() - lastAtMs < cooldownMs;

        if (!duplicateInCooldown) {
          sendDesktopNotification({ snapshot, reason });
          try {
            await sendLineFlexMessage(settings, { snapshot, reason });
          } catch (error) {
            const message = error instanceof Error ? error.message : "LINE 發送失敗";
            this.emit("error", new Error(message));
          }
          notificationStore.set(key, nowIso());
          notified = true;
        }
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
