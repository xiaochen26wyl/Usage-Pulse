import Store from "electron-store";
import type { AppSettings, CombinedSnapshot } from "@shared/types";
import { DEFAULT_SETTINGS } from "@main/config";

interface NotificationRecord {
  key: string;
  at: string;
}

interface UsagePulseStore {
  settings: AppSettings;
  lastSnapshot: CombinedSnapshot | null;
  lastNotificationKey: string;
  lastNotificationAt: string;
  notifications: Record<string, NotificationRecord>;
}

const store = new Store<UsagePulseStore>({
  name: "usage-pulse",
  defaults: {
    settings: DEFAULT_SETTINGS,
    lastSnapshot: null,
    lastNotificationKey: "",
    lastNotificationAt: "",
    notifications: {}
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
  get(scope = "global"): NotificationRecord {
    const notifications = store.get("notifications") as Record<string, NotificationRecord> | undefined;
    const scoped = notifications?.[scope];
    if (scoped && scoped.key) {
      return scoped;
    }

    if (scope === "global") {
      return {
        key: store.get("lastNotificationKey"),
        at: store.get("lastNotificationAt")
      };
    }

    return {
      key: "",
      at: ""
    };
  },
  set(scope: string, key: string, at: string): void {
    store.set(`notifications.${scope}`, { key, at });
    if (scope === "global") {
      store.set("lastNotificationKey", key);
      store.set("lastNotificationAt", at);
    }
  }
};
