import type {
  AlarmPopupPayload,
  AlarmSource,
  AlarmStatusReport,
  AlarmTarget,
  AppSettings,
  CombinedSnapshot
} from "@shared/types";
import {
  MAX_TIMEOUT_MS,
  clampTimeoutMs,
  collectAlarmTargets,
  decideAlarmAction,
  nextTarget
} from "@shared/alarm-utils";
import { isTrusted } from "@shared/snapshot-trust";
import { t } from "@shared/i18n";
import { SERVICE_LABELS } from "@main/config";
import { buildPlainAlertFlex } from "@shared/line-templates";
import { showAlarmPopup } from "@main/alarm-window";
import { sendLineBroadcast } from "@main/line-notifier";
import { sendDesktopNotification } from "@main/notifiers";
import {
  alarmLastGoodStore,
  alarmPendingStore,
  alarmStore,
  notificationStore,
  settingsStore,
  snapshotStore
} from "@main/store";

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

    const targets = collectAlarmTargets(snapshot, settings, settings.language, alarmLastGoodStore.getAll());
    const nowMs = Date.now();

    for (const target of targets) {
      // Remember every reset time we saw while its snapshot was healthy, so a
      // later credential outage cannot blank it out from under a pending alarm.
      if (isTrusted(snapshot[target.service])) {
        alarmLastGoodStore.set(target.id, target.fireAt, nowIso());
      }

      const action = decideAlarmAction(target.fireAt, nowMs, alarmPendingStore.get(target.id)?.fireAt);

      if (action === "schedule") {
        // Still in the future: this is the observation that earns it the
        // right to ring later, however late that turns out to be — including
        // a sleep/restart that carries it well past the on-time grace window.
        alarmPendingStore.set(target.id, { fireAt: target.fireAt, seenAt: nowIso() });

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
          this.fire(target);
        }, clampTimeoutMs(deltaMs));

        this.timers.set(target.id, timer);
        continue;
      }

      if (action === "skip") {
        // Either never observed pending (e.g. a fresh install or first sighting
        // already past), or the current fireAt has moved on since it was last
        // recorded pending. Consume it so a later re-arm does not keep
        // reconsidering it, but stay quiet: we cannot claim this exact
        // occurrence just reset.
        alarmStore.set(target.id, { fireAt: target.fireAt, firedAt: nowIso() });
        console.log(`[Usage-Pulse] alarm ${target.id} skipped: fireAt was never observed pending`);
        continue;
      }

      this.fire(target);
    }

    if (reason !== "poll") {
      console.log(`[Usage-Pulse] alarms re-armed (${reason}): ${targets.length} target(s)`);
    }

    return targets;
  }

  getReport(): AlarmStatusReport {
    const settings = settingsStore.get();
    const snapshot = snapshotStore.get();
    const targets = snapshot
      ? collectAlarmTargets(snapshot, settings, settings.language, alarmLastGoodStore.getAll())
      : [];
    return {
      nextTarget: nextTarget(targets, Date.now())
    };
  }

  nextTarget(): AlarmTarget | null {
    const settings = settingsStore.get();
    const snapshot = snapshotStore.get();
    if (!snapshot) {
      return null;
    }
    return nextTarget(
      collectAlarmTargets(snapshot, settings, settings.language, alarmLastGoodStore.getAll()),
      Date.now()
    );
  }

  showTestPopup(): void {
    const settings = settingsStore.get();
    showAlarmPopup({
      id: "test",
      service: "codex",
      label: t(settings.language, "alertLabel.codexCooldown"),
      fireAt: nowIso(),
      soundEnabled: false,
      language: settings.language,
      countdownTarget: new Date(Date.now() + 11 * 60_000).toISOString(),
      resetAlarmEnabled: settings.enableCodexResetAlarm
    });
  }

  private fire(target: AlarmTarget): void {
    const already = alarmStore.get(target.id);
    if (already && already.fireAt === target.fireAt) {
      return;
    }

    alarmStore.set(target.id, { fireAt: target.fireAt, firedAt: nowIso() });

    // Re-read settings at firing time rather than closing over the values
    // captured when the timer was scheduled — a timer can outlive several
    // settings changes.
    const settings: AppSettings = settingsStore.get();
    const lang = settings.language;
    const snapshot: CombinedSnapshot | null = snapshotStore.get();
    const reason = target.id === "cursor-billing"
      ? t(lang, "reason.cursorPeriodEnded")
      : target.id === "claude-billing"
        ? t(lang, "reason.claudePeriodEnded")
        : t(lang, "reason.resetFired", {
            service: SERVICE_LABELS[target.service],
            label: target.label
          });

    notificationStore.set(`reset:${target.id}`, `${target.id}|${target.fireAt}`, nowIso());

    if (snapshot) {
      sendDesktopNotification({ snapshot, reason });
    }

    void sendLineBroadcast(
      buildPlainAlertFlex({
        service: target.service,
        serviceLabel: SERVICE_LABELS[target.service],
        title: t(
          lang,
          target.id === "cursor-billing"
            ? "alarm.popup.title.cursorPeriod"
            : target.id === "claude-billing"
              ? "alarm.popup.title.claudePeriod"
              : "alarm.popup.title",
          { service: SERVICE_LABELS[target.service] }
        ),
        body: reason,
        lang
      })
    );

    if (settings.enableAlarmPopup) {
      const payload: AlarmPopupPayload = {
        id: target.id,
        service: target.service,
        label: target.label,
        fireAt: target.fireAt,
        soundEnabled: false,
        language: lang
      };
      showAlarmPopup(payload);
    }
  }
}

export const alarmService = new AlarmService();
