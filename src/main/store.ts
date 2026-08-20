import Store from "electron-store";
import type {
  AlarmFireRecord,
  AlarmSource,
  AppSettings,
  CombinedSnapshot,
  CredentialState,
  ServiceType
} from "@shared/types";
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

// What the last credential sweep saw for one service. `fingerprint` is a
// SHA-256 digest, never the token: comparing digests is enough to notice the
// IDE rotated the credential, and nothing here can be turned back into one.
export interface CredentialRecord {
  fingerprint: string;
  expiresAt: string | null;
  rotatedAt: string | null;
  checkedAt: string;
  state: CredentialState;
}

interface UsagePulseStore {
  settings: AppSettings;
  lastSnapshot: CombinedSnapshot | null;
  lastNotificationKey: string;
  lastNotificationAt: string;
  notifications: Record<string, NotificationRecord>;
  alarmFires: Record<string, AlarmFireRecord>;
  credentials: Record<string, CredentialRecord>;
}

const store = new Store<UsagePulseStore>({
  name: "usage-pulse",
  defaults: {
    settings: DEFAULT_SETTINGS,
    lastSnapshot: null,
    lastNotificationKey: "",
    lastNotificationAt: "",
    notifications: {},
    alarmFires: {},
    credentials: {}
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
    merged.alarmPopupAutoDismissMinutes = Number.isFinite(Number(merged.alarmPopupAutoDismissMinutes))
      ? clamp(Number(merged.alarmPopupAutoDismissMinutes), 1, 30)
      : 5;
    merged.alarmCatchUpMinutes = Number.isFinite(Number(merged.alarmCatchUpMinutes))
      ? clamp(Number(merged.alarmCatchUpMinutes), 5, 180)
      : 30;
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

// Remembers which fireAt already rang for each alarm source. Every re-arm
// (poll, wake, restart) consults this before replaying a missed firing, so a
// catch-up happens exactly once no matter how often the schedule is rebuilt.
export const alarmStore = {
  get(id: AlarmSource): AlarmFireRecord | null {
    const fires = store.get("alarmFires") as Record<string, AlarmFireRecord> | undefined;
    return fires?.[id] ?? null;
  },
  set(id: AlarmSource, record: AlarmFireRecord): void {
    store.set(`alarmFires.${id}`, record);
  },
  clear(id: AlarmSource): void {
    const fires = { ...((store.get("alarmFires") as Record<string, AlarmFireRecord> | undefined) ?? {}) };
    delete fires[id];
    store.set("alarmFires", fires);
  }
};

// Remembers the last credential sweep per service so the next one can tell a
// rotation (fingerprint changed) from a stale credential (fingerprint identical
// but past its expiry), and so a wake-from-sleep knows whether a sweep is due.
export const credentialStore = {
  get(service: ServiceType): CredentialRecord | null {
    const records = store.get("credentials") as Record<string, CredentialRecord> | undefined;
    return records?.[service] ?? null;
  },
  set(service: ServiceType, record: CredentialRecord): void {
    store.set(`credentials.${service}`, record);
  }
};
