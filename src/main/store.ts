import Store from "electron-store";
import type { AlertSilenceRecord } from "@shared/alert-silence";
import type {
  AlarmFireRecord,
  AlarmLastGoodRecord,
  AlarmObservation,
  AlarmSource,
  AppSettings,
  CombinedSnapshot,
  CredentialState,
  Language,
  QuotaSnapshot,
  ServiceType
} from "@shared/types";
import { DEFAULT_SETTINGS } from "@main/config";
import { normalizeCodexSnapshot } from "@shared/codex-usage";
import { LEGACY_ALERT_SETTING_KEYS, normalizeAlertChannels, resolveAlertChannels } from "@shared/notify-channels";
import { migrateLaunchWithIde } from "@main/ide-presence";
import { decryptSecret, encryptSecret } from "@main/secure-store";

const LANGUAGES: ReadonlySet<Language> = new Set(["zh", "en", "ja", "ko"]);

// Settings fields listed here are encrypted at rest via OS-native secret storage (see secure-store.ts)
// whenever they're written to the electron-store JSON file, and decrypted on read. Add future
// secrets (e.g. additional LINE keys) to this list rather than storing them in plain text.
const SECRET_SETTINGS_KEYS: Array<keyof AppSettings> = ["lineChannelAccessToken", "claudeManualToken"];

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
  migrations: Record<string, boolean>;
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
    credentials: {},
    migrations: {}
  }
});

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

type StoredSettings = AppSettings & {
  launchAtLogin?: boolean;
  // Removed launch-at-login switch; dropped on read so it leaves the file on the next save.
  launchAtStartup?: boolean;
  claudeManualOAuthToken?: string;
  claudeManualOAuthTokenExpiresAt?: string | null;
  // Removed billing-cadence select and the Claude / Codex activity-polling switches; dropped on read so they leave the file on the next save.
  claudeBillingCadence?: string;
  claudeUseCliActivityPolling?: boolean;
  codexUseCliActivityPolling?: boolean;
  // Per-reminder on/off switches and per-service popup / LINE checkboxes, now
  // alertChannels (see resolveAlertChannels, LEGACY_ALERT_SETTING_KEYS).
  // Removed drink-water reminder; dropped on read so it leaves the file on the next save.
  enableWaterReminder?: boolean;
  waterReminderMinutes?: number;
  waterCupSizeMl?: number;
  // Removed 5-hour cooldown alerts; dropped on read so they leave the file on the next save.
  enableClaudeCooldownAlert?: boolean;
  enableCodexCooldownAlert?: boolean;
  // Removed menu-bar value colour setting (the tray image now has a fixed dark background); dropped on read so it leaves the file on the next save.
  trayValueColorMode?: string;
};

const readSettings = (): AppSettings => {
  const raw = store.get("settings") as StoredSettings;
  const {
    launchAtLogin: _legacy,
    launchAtStartup: _legacyLaunchAtStartup,
    claudeManualOAuthToken: _legacyClaudeToken,
    claudeManualOAuthTokenExpiresAt: _legacyClaudeTokenExpiresAt,
    enableWaterReminder: _legacyWaterReminder,
    waterReminderMinutes: _legacyWaterMinutes,
    waterCupSizeMl: _legacyWaterCup,
    enableClaudeCooldownAlert: _legacyClaudeCooldown,
    enableCodexCooldownAlert: _legacyCodexCooldown,
    claudeBillingCadence: _legacyBillingCadence,
    trayValueColorMode: _legacyTrayValueColor,
    claudeUseCliActivityPolling: _legacyClaudeActivityPolling,
    codexUseCliActivityPolling: _legacyCodexActivityPolling,
    ...rest
  } = raw;
  const rawRecord = raw as unknown as Record<string, unknown>;
  const withoutLegacy: Record<string, unknown> = { ...rest };
  for (const key of LEGACY_ALERT_SETTING_KEYS) {
    delete withoutLegacy[key];
  }
  const settings = decryptSettings({
    ...DEFAULT_SETTINGS,
    ...(withoutLegacy as Partial<AppSettings>),
    launchWithIde: migrateLaunchWithIde(raw),
    alertChannels: resolveAlertChannels(rawRecord)
  });

  return settings;
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
    merged.codexSessionLowThresholdPercent = clamp(Number(merged.codexSessionLowThresholdPercent || 20), 5, 30);
    merged.codexWeeklyLowThresholdPercent = clamp(Number(merged.codexWeeklyLowThresholdPercent || 20), 5, 30);
    merged.notifyCooldownMinutes = Number.isFinite(Number(merged.notifyCooldownMinutes))
      ? clamp(Number(merged.notifyCooldownMinutes), 1, 240)
      : 15;
    if (!LANGUAGES.has(merged.language)) {
      merged.language = DEFAULT_SETTINGS.language;
    }
    merged.enableCursorMonitoring = Boolean(merged.enableCursorMonitoring);
    merged.enableClaudeMonitoring = Boolean(merged.enableClaudeMonitoring);
    merged.enableCodexMonitoring = Boolean(merged.enableCodexMonitoring);
    merged.alertChannels = normalizeAlertChannels(merged.alertChannels, current.alertChannels);
    merged.autoCheckForUpdates = Boolean(merged.autoCheckForUpdates);
    merged.showWeeklyInTray = Boolean(merged.showWeeklyInTray);
    store.set("settings", encryptSettings(merged));
    return merged;
  }
};

const emptyQuotaSnapshot = (service: ServiceType, fetchedAt: string): QuotaSnapshot => ({
  service,
  remaining: null,
  total: null,
  percent: null,
  unit: service === "cursor" ? "usd" : "percent",
  resetsAt: null,
  windows: [],
  status: "unknown",
  message: "",
  fetchedAt
});

const hydrateCombinedSnapshot = (raw: CombinedSnapshot | null): CombinedSnapshot | null => {
  if (!raw) {
    return null;
  }
  const fetchedAt = raw.fetchedAt || "";
  const lang = readSettings().language;
  return {
    cursor: raw.cursor ?? emptyQuotaSnapshot("cursor", fetchedAt),
    claude: raw.claude ?? emptyQuotaSnapshot("claude", fetchedAt),
    codex: normalizeCodexSnapshot(raw.codex ?? emptyQuotaSnapshot("codex", fetchedAt), lang),
    fetchedAt
  };
};

export const snapshotStore = {
  get(): CombinedSnapshot | null {
    return hydrateCombinedSnapshot(store.get("lastSnapshot"));
  },
  set(snapshot: CombinedSnapshot): void {
    const lang = readSettings().language;
    store.set("lastSnapshot", {
      ...snapshot,
      codex: normalizeCodexSnapshot(snapshot.codex, lang)
    });
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
  // Returns whether an entry actually existed and was removed — callers use
  // this to tell a genuine recovery (something was cleared) from a window
  // that was already clear (nothing to report).
  clear(scope: string): boolean {
    const notifications = {
      ...((store.get("notifications") as Record<string, NotificationRecord> | undefined) ?? {})
    };
    const existed = Boolean(notifications[scope]?.key);
    delete notifications[scope];
    store.set("notifications", notifications);
    return existed;
  },
  /**
   * One-shot gate: fires the first time `key` is seen for this scope, then
   * stays silent for every later call that reports the same key, no matter
   * how much time passes. The only ways back in are the ones that should
   * count as a new occurrence — the caller passing a different key, or
   * clearing the scope on genuine recovery.
   */
  shouldFireOnce(scope: string, key: string): boolean {
    const last = notificationStore.get(scope);
    if (last.key === key) {
      return false;
    }
    notificationStore.set(scope, key, new Date().toISOString());
    return true;
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
