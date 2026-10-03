import type { AppSettings, ServiceType } from "./types";

export type PopupSettingKey = "enableCursorAlarmPopup" | "enableClaudeAlarmPopup" | "enableCodexAlarmPopup";
export type LineSettingKey =
  | "enableCursorLineNotification"
  | "enableClaudeLineNotification"
  | "enableCodexLineNotification";

export const POPUP_SETTING_KEY: Record<ServiceType, PopupSettingKey> = {
  cursor: "enableCursorAlarmPopup",
  claude: "enableClaudeAlarmPopup",
  codex: "enableCodexAlarmPopup"
};

export const LINE_SETTING_KEY: Record<ServiceType, LineSettingKey> = {
  cursor: "enableCursorLineNotification",
  claude: "enableClaudeLineNotification",
  codex: "enableCodexLineNotification"
};

const MONITORING_SETTING_KEY: Record<
  ServiceType,
  "enableCursorMonitoring" | "enableClaudeMonitoring" | "enableCodexMonitoring"
> = {
  cursor: "enableCursorMonitoring",
  claude: "enableClaudeMonitoring",
  codex: "enableCodexMonitoring"
};

const SERVICES: readonly ServiceType[] = ["cursor", "claude", "codex"];

export const isPopupEnabled = (settings: Pick<AppSettings, PopupSettingKey>, service: ServiceType): boolean =>
  settings[POPUP_SETTING_KEY[service]];

export const isLineEnabled = (settings: Pick<AppSettings, LineSettingKey>, service: ServiceType): boolean =>
  settings[LINE_SETTING_KEY[service]];

// True when at least one service that is actually being monitored sends LINE.
// A service with monitoring off has its settings block hidden, so a stale
// checkbox there must not make the LINE panel look like it is in use.
export const isLineInUse = (
  settings: Pick<AppSettings, LineSettingKey | (typeof MONITORING_SETTING_KEY)[ServiceType]>
): boolean => SERVICES.some((service) => settings[MONITORING_SETTING_KEY[service]] && isLineEnabled(settings, service));

type ChannelFlags = Pick<AppSettings, PopupSettingKey | LineSettingKey>;

/**
 * Resolves the per-service popup / LINE flags from a stored settings object.
 *
 * Older stores carried one global `enableAlarmPopup` and one global
 * `enableLineNotification`. A service's own flag wins when it was already
 * saved; otherwise it inherits the legacy global value, so upgrading never
 * changes who gets notified. With neither present the default (on) applies.
 */
export const resolveChannelFlags = (raw: Record<string, unknown>): ChannelFlags => {
  const pick = (key: string, legacyKey: string): boolean => {
    if (typeof raw[key] === "boolean") {
      return raw[key] as boolean;
    }
    return typeof raw[legacyKey] === "boolean" ? (raw[legacyKey] as boolean) : true;
  };

  return {
    enableCursorAlarmPopup: pick("enableCursorAlarmPopup", "enableAlarmPopup"),
    enableClaudeAlarmPopup: pick("enableClaudeAlarmPopup", "enableAlarmPopup"),
    enableCodexAlarmPopup: pick("enableCodexAlarmPopup", "enableAlarmPopup"),
    enableCursorLineNotification: pick("enableCursorLineNotification", "enableLineNotification"),
    enableClaudeLineNotification: pick("enableClaudeLineNotification", "enableLineNotification"),
    enableCodexLineNotification: pick("enableCodexLineNotification", "enableLineNotification")
  };
};
