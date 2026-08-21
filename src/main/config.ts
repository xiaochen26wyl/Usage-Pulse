import type { AppSettings, ServiceType } from "@shared/types";

export const SERVICE_LABELS: Record<ServiceType, string> = {
  cursor: "Cursor",
  claude: "Claude Code"
};

export const DEFAULT_SETTINGS: AppSettings = {
  cursorIntervalMinutes: 10,
  claudeIntervalMinutes: 10,
  cursorAdvancedModelsLowThresholdPercent: 20,
  enableCursorAdvancedModelsLowAlert: true,
  cursorModelsLowThresholdPercent: 20,
  enableCursorModelsLowAlert: true,
  claudeSessionLowThresholdPercent: 20,
  enableClaudeSessionLowAlert: true,
  claudeWeeklyLowThresholdPercent: 20,
  enableClaudeWeeklyLowAlert: true,
  enableClaudeCooldownAlert: true,
  launchAtLogin: false,
  notifyCooldownMinutes: 15,
  enableCursorResetAlarm: true,
  enableClaudeResetAlarm: true,
  language: "zh",
  enableAlarmPopup: true,
  alarmSoundEnabled: true,
  lineChannelAccessToken: "",
  claudeManualOAuthToken: "",
  claudeUseCliActivityPolling: true,
  claudeIdleIntervalMinutes: 30,
  claudeUseLocalSessionLogs: true
};
