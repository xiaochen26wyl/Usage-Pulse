import type { AlarmPopupPayload } from "@shared/types";
import { t } from "@shared/i18n";
import { formatWaterCup } from "@shared/session-stats";
import { clampTimeoutMs } from "@shared/alarm-utils";
import { closeAlarmPopup, getAlarmPayload, onAlarmPopupClosed, showAlarmPopup } from "@main/alarm-window";
import { settingsStore } from "@main/store";

class WaterReminder {
  private timer: NodeJS.Timeout | null = null;
  private nextAtMs: number | null = null;
  private enabled = false;

  constructor() {
    onAlarmPopupClosed((payload) => {
      if (payload.id !== "water" || !this.enabled) {
        return;
      }
      this.arm();
    });
  }

  start(): void {
    this.enabled = settingsStore.get().enableWaterReminder;
    if (!this.enabled) {
      this.clear();
      return;
    }
    this.arm();
  }

  reschedule(): void {
    this.enabled = settingsStore.get().enableWaterReminder;
    if (!this.enabled) {
      this.clear();
      this.dismissIfShowing();
      return;
    }
    if (getAlarmPayload()?.id === "water") {
      return;
    }
    this.arm();
  }

  stop(): void {
    this.enabled = false;
    this.clear();
  }

  getNextAt(): string | null {
    if (!this.enabled || this.nextAtMs === null) {
      return null;
    }
    return new Date(this.nextAtMs).toISOString();
  }

  private arm(): void {
    this.clear();
    const settings = settingsStore.get();
    if (!settings.enableWaterReminder) {
      this.enabled = false;
      this.nextAtMs = null;
      return;
    }
    const delay = clampTimeoutMs(settings.waterReminderMinutes * 60_000);
    this.nextAtMs = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fire();
    }, delay);
  }

  private fire(): void {
    this.nextAtMs = Date.now();
    const settings = settingsStore.get();
    if (!this.enabled || !settings.enableWaterReminder) {
      return;
    }
    const payload: AlarmPopupPayload = {
      id: "water",
      service: null,
      label: t(settings.language, "water.popup.label", { size: formatWaterCup(settings.waterCupSizeMl) }),
      fireAt: new Date().toISOString(),
      soundEnabled: true,
      language: settings.language
    };
    showAlarmPopup(payload);
  }

  private dismissIfShowing(): void {
    if (getAlarmPayload()?.id === "water") {
      closeAlarmPopup();
    }
  }

  private clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextAtMs = null;
  }
}

export const waterReminder = new WaterReminder();
