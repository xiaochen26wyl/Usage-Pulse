import Store from "electron-store";
import type { AppSettings, CombinedSnapshot } from "@shared/types";
import { DEFAULT_SETTINGS } from "@main/config";

interface UsagePulseStore {
  settings: AppSettings;
  lastSnapshot: CombinedSnapshot | null;
  lastNotificationKey: string;
  lastNotificationAt: string;
}

const store = new Store<UsagePulseStore>({
  name: "usage-pulse",
  defaults: {
    settings: DEFAULT_SETTINGS,
    lastSnapshot: null,
    lastNotificationKey: "",
    lastNotificationAt: ""
  }
});

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const settingsStore = {
  get(): AppSettings {
    const current = store.get("settings");
    return {
      ...DEFAULT_SETTINGS,
      ...current
    };
  },
  update(patch: Partial<AppSettings>): AppSettings {
    const current = store.get("settings");
    const merged: AppSettings = {
      ...DEFAULT_SETTINGS,
      ...current,
      ...patch
    };
    merged.intervalMinutes = clamp(Number(merged.intervalMinutes || 5), 1, 60);
    merged.lowThresholdPercent = clamp(Number(merged.lowThresholdPercent || 20), 1, 99);
    merged.notifyCooldownMinutes = clamp(Number(merged.notifyCooldownMinutes || 15), 1, 240);
    merged.lineChannelToken = `${merged.lineChannelToken || ""}`.trim();
    store.set("settings", merged);
    return merged;
  }
};

export const snapshotStore = {
  get(): CombinedSnapshot | null {
    return store.get("lastSnapshot");
  },
  set(snapshot: CombinedSnapshot): void {
    store.set("lastSnapshot", snapshot);
  }
};

export const notificationStore = {
  get(): { key: string; at: string } {
    return {
      key: store.get("lastNotificationKey"),
      at: store.get("lastNotificationAt")
    };
  },
  set(key: string, at: string): void {
    store.set("lastNotificationKey", key);
    store.set("lastNotificationAt", at);
  }
};
