import Store from "electron-store";
import type { AppSettings, CombinedSnapshot } from "@shared/types";
import { DEFAULT_SETTINGS } from "@main/config";
import { decryptSecret, encryptSecret } from "@main/secure-store";

// Settings fields listed here are encrypted at rest via the OS keychain (see secure-store.ts)
// whenever they're written to the electron-store JSON file, and decrypted on read. Add future
// secrets (e.g. additional LINE keys) to this list rather than storing them in plain text.
const SECRET_SETTINGS_KEYS: Array<keyof AppSettings> = [
  "lineChannelAccessToken",
  "lineChannelId",
  "lineAssertionKid",
  "lineAssertionPrivateKey"
];

const asStringRecord = (settings: AppSettings) => settings as unknown as Record<string, string>;

const decryptSettings = (settings: AppSettings): AppSettings => {
  const result = { ...settings };
  for (const key of SECRET_SETTINGS_KEYS) {
    asStringRecord(result)[key] = decryptSecret(asStringRecord(settings)[key] || "");
  }
  return result;
};

const encryptSettings = (settings: AppSettings): AppSettings => {
  const result = { ...settings };
  for (const key of SECRET_SETTINGS_KEYS) {
    asStringRecord(result)[key] = encryptSecret(asStringRecord(settings)[key] || "");
  }
  return result;
};

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
    return decryptSettings({
      ...DEFAULT_SETTINGS,
      ...current
    });
  },
  update(patch: Partial<AppSettings>): AppSettings {
    const current = decryptSettings({
      ...DEFAULT_SETTINGS,
      ...store.get("settings")
    });
    const merged: AppSettings = {
      ...current,
      ...patch
    };
    merged.cursorIntervalMinutes = clamp(Number(merged.cursorIntervalMinutes || 10), 5, 60);
    merged.claudeIntervalMinutes = clamp(Number(merged.claudeIntervalMinutes || 10), 5, 60);
    merged.cursorLowThresholdPercent = clamp(Number(merged.cursorLowThresholdPercent || 20), 5, 30);
    merged.claudeLowThresholdPercent = clamp(Number(merged.claudeLowThresholdPercent || 20), 5, 30);
    merged.notifyCooldownMinutes = Number.isFinite(Number(merged.notifyCooldownMinutes))
      ? clamp(Number(merged.notifyCooldownMinutes), 1, 240)
      : 15;
    store.set("settings", encryptSettings(merged));
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
