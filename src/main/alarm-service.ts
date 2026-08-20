import type {
  AlarmPopupPayload,
  AlarmSource,
  AlarmStatusReport,
  AlarmTarget,
  AppSettings,
  CombinedSnapshot
} from "@shared/types";
import { MAX_TIMEOUT_MS, classifyFire, clampTimeoutMs, collectAlarmTargets, nextTarget } from "@shared/alarm-utils";
import { t } from "@shared/i18n";
import { SERVICE_LABELS } from "@main/config";
import { showAlarmPopup } from "@main/alarm-window";
import { sendDesktopNotification } from "@main/notifiers";
import { alarmStore, notificationStore, settingsStore, snapshotStore } from "@main/store";

export type RearmReason = "startup" | "settings" | "poll" | "resume" | "unlock" | "manual" | "clamped";

const nowIso = () => new Date().toISOString();

export class AlarmService {
  private timers = new Map<AlarmSource, NodeJS.Timeout>();

  private clearTimers(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  stop(): void {
    this.clearTimers();
  }

  /**
   * Rebuilds every alarm timer from the current snapshot and settings.
   *
   * Safe to call as often as we like — `alarmStore` records which fireAt has
   * already rung, so replaying a missed alarm after a wake or a restart happens
   * exactly once no matter how many times this runs.
   */
  rearm(reason: RearmReason): AlarmTarget[] {
    this.clearTimers();

    const settings = settingsStore.get();
    const snapshot = snapshotStore.get();
    if (!snapshot) {
      return [];
    }

    const targets = collectAlarmTargets(snapshot, settings, settings.language);
    const nowMs = Date.now();

    for (const target of targets) {
      const fireClass = classifyFire(target.fireAt, nowMs, settings.alarmCatchUpMinutes);

      if (fireClass === "expired") {
        continue;
      }

      if (fireClass === "due" || fireClass === "missed") {
        this.fire(target, fireClass === "missed");
        continue;
      }

      const deltaMs = Date.parse(target.fireAt) - nowMs;
      // A wait longer than a signed 32-bit int would fire instantly, so park on
      // the ceiling and rebuild the schedule when that placeholder elapses.
      const isClamped = deltaMs > MAX_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.timers.delete(target.id);
        if (isClamped) {
          this.rearm("clamped");
          return;
        }
        this.fire(target, false);
      }, clampTimeoutMs(deltaMs));

      this.timers.set(target.id, timer);
    }

    if (reason !== "poll") {
      console.log(`[Usage-Pulse] alarms re-armed (${reason}): ${targets.length} target(s)`);
    }

    return targets;
  }

  getReport(system: AlarmStatusReport["system"]): AlarmStatusReport {
    const settings = settingsStore.get();
    const snapshot = snapshotStore.get();
    const targets = snapshot ? collectAlarmTargets(snapshot, settings, settings.language) : [];
    return {
      nextTarget: nextTarget(targets, Date.now()),
      system
    };
  }

  nextTarget(): AlarmTarget | null {
    const settings = settingsStore.get();
    const snapshot = snapshotStore.get();
    if (!snapshot) {
      return null;
    }
    return nextTarget(collectAlarmTargets(snapshot, settings, settings.language), Date.now());
  }

  showTestPopup(): void {
    const settings = settingsStore.get();
    showAlarmPopup({
      id: "test",
      service: null,
      label: t(settings.language, "alarm.testLabel"),
      fireAt: nowIso(),
      catchUp: false,
      autoDismissMinutes: settings.alarmPopupAutoDismissMinutes,
      soundEnabled: settings.alarmSoundEnabled,
      language: settings.language
    });
  }

  private fire(target: AlarmTarget, catchUp: boolean): void {
    const already = alarmStore.get(target.id);
    if (already && already.fireAt === target.fireAt) {
      return;
    }

    alarmStore.set(target.id, { fireAt: target.fireAt, firedAt: nowIso(), catchUp });

    // Re-read settings at firing time rather than closing over the values
    // captured when the timer was scheduled — a timer can outlive several
    // settings changes.
    const settings: AppSettings = settingsStore.get();
    const lang = settings.language;
    const snapshot: CombinedSnapshot | null = snapshotStore.get();
    const reason = t(lang, "reason.resetFired", {
      service: SERVICE_LABELS[target.service],
      label: target.label
    });

    notificationStore.set(`reset:${target.id}`, `${target.id}|${target.fireAt}`, nowIso());

    if (snapshot) {
      sendDesktopNotification({ snapshot, reason });
    }

    if (settings.enableAlarmPopup) {
      const payload: AlarmPopupPayload = {
        id: target.id,
        service: target.service,
        label: target.label,
        fireAt: target.fireAt,
        catchUp,
        autoDismissMinutes: settings.alarmPopupAutoDismissMinutes,
        soundEnabled: settings.alarmSoundEnabled,
        language: lang
      };
      showAlarmPopup(payload);
    }
  }
}

export const alarmService = new AlarmService();
