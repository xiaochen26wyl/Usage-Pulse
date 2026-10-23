import type { AlertChannel, AlertKey, AppSettings, ServiceType } from "./types";

export const ALERT_SERVICE: Record<AlertKey, ServiceType> = {
  "cursor-advanced-models-low": "cursor",
  "cursor-models-low": "cursor",
  "cursor-billing": "cursor",
  "claude-session-low": "claude",
  "claude-weekly-low": "claude",
  "claude-session": "claude",
  "claude-weekly": "claude",
  "claude-billing": "claude",
  "codex-session-low": "codex",
  "codex-weekly-low": "codex",
  "codex-session": "codex",
  "codex-weekly": "codex",
  "codex-billing": "codex"
};

export const ALERT_KEYS = Object.keys(ALERT_SERVICE) as AlertKey[];

// The 5-hour windows reset several times a day and ring whether or not the
// window was ever low, so their reset reminders start with LINE unticked; the
// low-quota reminder's "recovered" notice already covers LINE for that spell.
const LINE_OFF_BY_DEFAULT: ReadonlySet<AlertKey> = new Set<AlertKey>(["claude-session", "codex-session"]);

export const defaultAlertChannel = (key: AlertKey): AlertChannel => ({
  popup: true,
  line: !LINE_OFF_BY_DEFAULT.has(key)
});

export const defaultAlertChannels = (): Record<AlertKey, AlertChannel> =>
  Object.fromEntries(ALERT_KEYS.map((key) => [key, defaultAlertChannel(key)])) as Record<AlertKey, AlertChannel>;

type ChannelSettings = Pick<AppSettings, "alertChannels">;

export const isAlertPopup = (settings: ChannelSettings, key: AlertKey): boolean => settings.alertChannels[key].popup;

export const isAlertLine = (settings: ChannelSettings, key: AlertKey): boolean => settings.alertChannels[key].line;

// A reminder with neither box ticked is off.
export const isAlertEnabled = (settings: ChannelSettings, key: AlertKey): boolean =>
  isAlertPopup(settings, key) || isAlertLine(settings, key);

// True when any reminder of this service sends LINE. Used by the messages that
// belong to the service rather than to one reminder (credential expired, the
// quit status).
export const isLineEnabled = (settings: ChannelSettings, service: ServiceType): boolean =>
  ALERT_KEYS.some((key) => ALERT_SERVICE[key] === service && isAlertLine(settings, key));

const MONITORING_SETTING_KEY: Record<
  ServiceType,
  "enableCursorMonitoring" | "enableClaudeMonitoring" | "enableCodexMonitoring"
> = {
  cursor: "enableCursorMonitoring",
  claude: "enableClaudeMonitoring",
  codex: "enableCodexMonitoring"
};

const SERVICES: readonly ServiceType[] = ["cursor", "claude", "codex"];

// True when at least one service that is actually being monitored sends LINE.
// A service with monitoring off has its settings block hidden, so a stale
// checkbox there must not make the LINE panel look like it is in use.
export const isLineInUse = (
  settings: ChannelSettings & Pick<AppSettings, (typeof MONITORING_SETTING_KEY)[ServiceType]>
): boolean => SERVICES.some((service) => settings[MONITORING_SETTING_KEY[service]] && isLineEnabled(settings, service));

/**
 * Reads a stored or renderer-supplied `alertChannels` value back into a
 * complete record: a missing or malformed entry falls back to `fallback`, so a
 * partial patch can never leave a reminder without channels.
 */
export const normalizeAlertChannels = (
  value: unknown,
  fallback: Record<AlertKey, AlertChannel> = defaultAlertChannels()
): Record<AlertKey, AlertChannel> => {
  const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const result = {} as Record<AlertKey, AlertChannel>;
  for (const key of ALERT_KEYS) {
    const entry = source[key];
    const candidate = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    result[key] = {
      popup: typeof candidate.popup === "boolean" ? candidate.popup : fallback[key].popup,
      line: typeof candidate.line === "boolean" ? candidate.line : fallback[key].line
    };
  }
  return result;
};

// Pre-per-reminder stores kept one on/off switch per reminder plus one popup
// and one LINE checkbox per service. Each reminder's channels are rebuilt from
// those, so upgrading never changes what anyone is notified about.
const LEGACY_ENABLE_KEY: Record<AlertKey, string> = {
  "cursor-advanced-models-low": "enableCursorAdvancedModelsLowAlert",
  "cursor-models-low": "enableCursorModelsLowAlert",
  "cursor-billing": "enableCursorResetAlarm",
  "claude-session-low": "enableClaudeSessionLowAlert",
  "claude-weekly-low": "enableClaudeWeeklyLowAlert",
  "claude-session": "enableClaudeResetAlarm",
  "claude-weekly": "enableClaudeWeeklyResetAlarm",
  "claude-billing": "enableClaudeBillingAlarm",
  "codex-session-low": "enableCodexSessionLowAlert",
  "codex-weekly-low": "enableCodexWeeklyLowAlert",
  "codex-session": "enableCodexResetAlarm",
  "codex-weekly": "enableCodexWeeklyResetAlarm",
  "codex-billing": "enableCodexBillingAlarm"
};

const LEGACY_SERVICE_POPUP_KEY: Record<ServiceType, string> = {
  cursor: "enableCursorAlarmPopup",
  claude: "enableClaudeAlarmPopup",
  codex: "enableCodexAlarmPopup"
};

const LEGACY_SERVICE_LINE_KEY: Record<ServiceType, string> = {
  cursor: "enableCursorLineNotification",
  claude: "enableClaudeLineNotification",
  codex: "enableCodexLineNotification"
};

// Every field the per-reminder model replaced, so the store can drop them.
export const LEGACY_ALERT_SETTING_KEYS: readonly string[] = [
  ...Object.values(LEGACY_ENABLE_KEY),
  ...Object.values(LEGACY_SERVICE_POPUP_KEY),
  ...Object.values(LEGACY_SERVICE_LINE_KEY),
  "enableAlarmPopup",
  "enableLineNotification"
];

/**
 * The per-reminder channels for a stored settings object. A stored
 * `alertChannels` wins; otherwise they are derived from the legacy fields. A
 * service's own legacy flag wins over the older global `enableAlarmPopup` /
 * `enableLineNotification`; with neither present the default (on) applies.
 * A reminder that was switched off stays off.
 */
export const resolveAlertChannels = (raw: Record<string, unknown>): Record<AlertKey, AlertChannel> => {
  if (raw.alertChannels && typeof raw.alertChannels === "object") {
    return normalizeAlertChannels(raw.alertChannels);
  }

  const pick = (key: string, legacyKey: string): boolean => {
    if (typeof raw[key] === "boolean") {
      return raw[key] as boolean;
    }
    return typeof raw[legacyKey] === "boolean" ? (raw[legacyKey] as boolean) : true;
  };

  const result = {} as Record<AlertKey, AlertChannel>;
  for (const key of ALERT_KEYS) {
    const service = ALERT_SERVICE[key];
    // Weekly reset used to share the 5-hour switch until it got its own.
    const enabledRaw =
      key === "claude-weekly" && typeof raw[LEGACY_ENABLE_KEY[key]] !== "boolean"
        ? raw[LEGACY_ENABLE_KEY["claude-session"]]
        : raw[LEGACY_ENABLE_KEY[key]];
    const enabled = typeof enabledRaw === "boolean" ? enabledRaw : true;
    const fallback = defaultAlertChannel(key);
    result[key] = {
      popup: enabled && pick(LEGACY_SERVICE_POPUP_KEY[service], "enableAlarmPopup"),
      line: enabled && fallback.line && pick(LEGACY_SERVICE_LINE_KEY[service], "enableLineNotification")
    };
  }
  return result;
};
