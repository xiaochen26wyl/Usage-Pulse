import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { AlarmSyncStatus } from "@shared/types";
import type { SystemAlarmManager } from "./system-alarm";

const execAsync = promisify(exec);
const SHORTCUT_NAME = "Usage-Pulse Update Alarm";

export class MacosClockAlarm implements SystemAlarmManager {
  private async hasShortcut(): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`shortcuts list`);
      return stdout.includes(SHORTCUT_NAME);
    } catch {
      return false;
    }
  }

  async upsert(id: string, fireAt: string, title: string, _body: string): Promise<void> {
    const installed = await this.hasShortcut();
    if (!installed) {
      return;
    }

    const date = new Date(fireAt);
    if (isNaN(date.getTime())) {
      return;
    }
    
    // Check if the alarm time is in the past
    if (date.getTime() <= Date.now()) {
      return;
    }

    const timeStr = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    const input = `${title}|${timeStr}`;

    try {
      await execAsync(`shortcuts run "${SHORTCUT_NAME}" -i "${input}"`);
    } catch (e) {
      console.error("[Usage-Pulse] Failed to upsert macos clock alarm:", e);
    }
  }

  async remove(_id: string, title: string): Promise<void> {
    const installed = await this.hasShortcut();
    if (!installed) {
      return;
    }

    const input = `off|${title}`;

    try {
      await execAsync(`shortcuts run "${SHORTCUT_NAME}" -i "${input}"`);
    } catch (e) {
      console.error("[Usage-Pulse] Failed to remove macos clock alarm:", e);
    }
  }

  async status(): Promise<AlarmSyncStatus> {
    const installed = await this.hasShortcut();
    return installed ? "synced" : "no-shortcuts";
  }
}
