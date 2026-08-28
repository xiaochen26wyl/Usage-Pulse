import Store from "electron-store";
import type { AlertSilenceRecord } from "@shared/alert-silence";
import type {
  AlarmFireRecord,
  AlarmLastGoodRecord,
  AlarmObservation,
  AlarmSource,
  AppSettings,
  ClaudeBillingCadence,
  CombinedSnapshot,
  CredentialState,
  Language,
  ServiceType,
  TrayValueColorMode
} from "@shared/types";
import { DEFAULT_SETTINGS } from "@main/config";
import { clampWaterReminderMinutes, normalizeWaterCupSize } from "@shared/water";
import { migrateLaunchWithIde } from "@main/ide-presence";
import { decryptSecret, encryptSecret } from "@main/secure-store";

const TRAY_VALUE_COLOR_MODES: ReadonlySet<TrayValueColorMode> = new Set(["system", "white", "black"]);
const LANGUAGES: ReadonlySet<Language> = new Set(["zh", "en", "ja", "ko"]);

// Settings fields listed here are encrypted at rest via the OS keychain (see secure-store.ts)
// whenever they're written to the electron-store JSON file, and decrypted on read. Add future
// secrets (e.g. additional LINE keys) to this list rather than storing them in plain text.
const SECRET_SETTINGS_KEYS: Array<keyof AppSettings> = ["lineChannelAccessToken", "claudeManualOAuthToken"];

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

type NotificationRecord = AlertSilenceRecord;

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
  alarmPending: Record<string, AlarmObservation>;
  alarmLastGood: Record<string, AlarmLastGoodRecord>;
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
    alarmPending: {},
    alarmLastGood: {},
    credentials: {}
  }
});

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

type StoredSettings = AppSettings & {
  launchAtLogin?: boolean;
  enableClaudeWeeklyResetAlarm?: boolean;
  enableClaudeBillingAlarm?: boolean;
  claudeBillingCadence?: ClaudeBillingCadence;
};

const migrateClaudeWeeklyResetAlarm = (raw: StoredSettings): boolean =>
  typeof raw.enableClaudeWeeklyResetAlarm === "boolean"
    ? raw.enableClaudeWeeklyResetAlarm
    : Boolean(raw.enableClaudeResetAlarm ?? DEFAULT_SETTINGS.enableClaudeResetAlarm);

const migrateClaudeBillingCadence = (raw: StoredSettings): ClaudeBillingCadence =>
  raw.claudeBillingCadence === "annual" ? "annual" : "monthly";

const readSettings = (): AppSettings => {
  const raw = store.get("settings") as StoredSettings;
  const { launchAtLogin: _legacy, ...rest } = raw;
  return decryptSettings({
    ...DEFAULT_SETTINGS,
    ...rest,
    launchWithIde: migrateLaunchWithIde(raw),
    enableClaudeWeeklyResetAlarm: migrateClaudeWeeklyResetAlarm(raw),
    enableClaudeBillingAlarm:
      typeof raw.enableClaudeBillingAlarm === "boolean"
        ? raw.enableClaudeBillingAlarm
        : DEFAULT_SETTINGS.enableClaudeBillingAlarm,
    claudeBillingCadence: migrateClaudeBillingCadence(raw)
  });
};

export const settingsStore = {
  get(): AppSettings {
    return readSettings();
  },
  update(patch: Partial<AppSettings>): AppSettings {
    const current = readSettings();
    const merged: AppSettings = {
      ...current,
      ...patch
    };
    merged.cursorAdvancedModelsLowThresholdPercent = clamp(
      Number(merged.cursorAdvancedModelsLowThresholdPercent || 20),
      5,
      30
    );
    merged.cursorModelsLowThresholdPercent = clamp(Number(merged.cursorModelsLowThresholdPercent || 20), 5, 30);
    merged.claudeSessionLowThresholdPercent = clamp(Number(merged.claudeSessionLowThresholdPercent || 20), 5, 30);
    merged.claudeWeeklyLowThresholdPercent = clamp(Number(merged.claudeWeeklyLowThresholdPercent || 20), 5, 30);
    merged.notifyCooldownMinutes = Number.isFinite(Number(merged.notifyCooldownMinutes))
      ? clamp(Number(merged.notifyCooldownMinutes), 1, 240)
      : 15;
    if (!TRAY_VALUE_COLOR_MODES.has(merged.trayValueColorMode)) {
      merged.trayValueColorMode = DEFAULT_SETTINGS.trayValueColorMode;
    }
    if (!LANGUAGES.has(merged.language)) {
      merged.language = DEFAULT_SETTINGS.language;
    }
    merged.waterReminderMinutes = clampWaterReminderMinutes(merged.waterReminderMinutes);
    merged.waterCupSizeMl = normalizeWaterCupSize(merged.waterCupSizeMl);
    merged.enableWaterReminder = Boolean(merged.enableWaterReminder);
    merged.enableCursorMonitoring = Boolean(merged.enableCursorMonitoring);
    merged.enableClaudeMonitoring = Boolean(merged.enableClaudeMonitoring);
    merged.enableClaudeWeeklyResetAlarm = Boolean(merged.enableClaudeWeeklyResetAlarm);
    merged.enableClaudeBillingAlarm = Boolean(merged.enableClaudeBillingAlarm);
    merged.claudeBillingCadence = merged.claudeBillingCadence === "annual" ? "annual" : "monthly";
    if (merged.launchAtStartup && merged.launchWithIde) {
      if (patch.launchAtStartup === true) {
        merged.launchWithIde = false;
      } else {
        merged.launchAtStartup = false;
      }
    }
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
      return {
        key: scoped.key,
        at: scoped.at,
        restoreAt: scoped.restoreAt ?? null
      };
    }

    if (scope === "global") {
      return {
        key: store.get("lastNotificationKey"),
        at: store.get("lastNotificationAt"),
        restoreAt: null
      };
    }

    return {
      key: "",
      at: "",
      restoreAt: null
    };
  },
  set(scope: string, key: string, at: string, restoreAt?: string | null): void {
    store.set(`notifications.${scope}`, { key, at, restoreAt: restoreAt ?? null });
    if (scope === "global") {
      store.set("lastNotificationKey", key);
      store.set("lastNotificationAt", at);
    }
  },
  clear(scope: string): void {
    const notifications = {
      ...((store.get("notifications") as Record<string, NotificationRecord> | undefined) ?? {})
    };
    delete notifications[scope];
    store.set("notifications", notifications);
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

// Remembers which fireAt was seen while still pending, per alarm source. An
// alarm only rings for a fireAt recorded here: see AlarmObservation.
export const alarmPendingStore = {
  get(id: AlarmSource): AlarmObservation | null {
    const seen = store.get("alarmPending") as Record<string, AlarmObservation> | undefined;
    return seen?.[id] ?? null;
  },
  set(id: AlarmSource, record: AlarmObservation): void {
    store.set(`alarmPending.${id}`, record);
  }
};

// Remembers the last trustworthy reset time per alarm source, so a credential
// outage that blanks resetsAt cannot silently disarm a real pending alarm.
export const alarmLastGoodStore = {
  getAll(): Partial<Record<AlarmSource, string>> {
    const records = store.get("alarmLastGood") as Record<string, AlarmLastGoodRecord> | undefined;
    const result: Partial<Record<AlarmSource, string>> = {};
    for (const [id, record] of Object.entries(records ?? {})) {
      if (record?.fireAt) {
        result[id as AlarmSource] = record.fireAt;
      }
    }
    return result;
  },
  set(id: AlarmSource, fireAt: string, observedAt: string): void {
    store.set(`alarmLastGood.${id}`, { fireAt, observedAt });
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
