import type { AlarmSyncStatus } from "@shared/types";

export interface SystemAlarmManager {
  upsert(id: string, fireAt: string, title: string, body: string): Promise<void>;
  remove(id: string, title: string): Promise<void>;
  status(): Promise<AlarmSyncStatus>;
}

export const getSystemAlarmManager = (): SystemAlarmManager | null => {
  if (process.platform === "darwin") {
    // Lazy require so we don't evaluate things on unsupported platforms
    const { MacosClockAlarm } = require("./macos-clock-alarm");
    return new MacosClockAlarm();
  }
  if (process.platform === "win32") {
    const { WindowsToastAlarm } = require("./windows-toast-alarm");
    return new WindowsToastAlarm();
  }
  return null;
};

