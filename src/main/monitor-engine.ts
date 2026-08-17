import { EventEmitter } from "node:events";
import type { AppSettings, CombinedSnapshot, MonitorResult, QuotaSnapshot, ServiceType } from "@shared/types";
import { scrapeQuota } from "@main/scrapers";
import { sendDesktopNotification, sendLineFlexMessage } from "@main/notifiers";
import { notificationStore, settingsStore, snapshotStore } from "@main/store";

type TriggerType = "scheduled" | "manual" | "startup";

const nowIso = () => new Date().toISOString();

const toPercent = (remaining: number | null, total: number | null): number | null => {
  if (remaining === null || total === null || total <= 0) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round((remaining / total) * 100)));
};

const isLowQuota = (
  remaining: number | null,
  percent: number | null,
  settings: AppSettings
): boolean => {
  if (percent !== null) {
    return percent <= settings.lowThresholdPercent;
  }
  if (remaining !== null) {
    return remaining <= 3;
  }
  return false;
};

const makeQuotaSnapshot = (
  service: ServiceType,
  remaining: number | null,
  total: number | null,
  message: string,
  settings: AppSettings
): QuotaSnapshot => {
  const percent = toPercent(remaining, total);
  const low = isLowQuota(remaining, percent, settings);
  const hasError = /失敗|error/i.test(message);
  const status = hasError ? "error" : low ? "low" : remaining === null ? "unknown" : "ok";

  return {
    service,
    remaining,
    total,
    percent,
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
    prev.claude.remaining !== next.claude.remaining ||
    prev.claude.total !== next.claude.total ||
    prev.cursor.status !== next.cursor.status ||
    prev.claude.status !== next.claude.status
  );
};

const hasLowAlert = (snapshot: CombinedSnapshot): boolean =>
  snapshot.cursor.status === "low" || snapshot.claude.status === "low";

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

  start(): void {
    this.reschedule();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
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
  }

  getLatestSnapshot(): CombinedSnapshot | null {
    return snapshotStore.get();
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
        cursor: makeQuotaSnapshot(
          "cursor",
          cursorResult.remaining,
          cursorResult.total,
          cursorResult.message,
          settings
        ),
        claude: makeQuotaSnapshot(
          "claude",
          claudeResult.remaining,
          claudeResult.total,
          claudeResult.message,
          settings
        ),
        fetchedAt: nowIso()
      };

      const changed = hasChanged(previous, snapshot);
      const lowAlert = hasLowAlert(snapshot);
      const reason = makeReason(changed, lowAlert);
      let notified = false;

      if (changed || lowAlert || trigger === "manual") {
        const key = `${snapshot.cursor.remaining}|${snapshot.cursor.total}|${snapshot.claude.remaining}|${snapshot.claude.total}|${reason}`;
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
