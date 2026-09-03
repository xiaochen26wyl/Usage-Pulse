import type { AppSettings, ServiceType } from "@shared/types";

export const SERVICE_LABELS: Record<ServiceType, string> = {
  cursor: "Cursor",
  claude: "Claude Code",
  codex: "Codex"
};

export const DEFAULT_SETTINGS: AppSettings = {
  enableCursorMonitoring: true,
  enableClaudeMonitoring: true,
  enableCodexMonitoring: true,
  cursorAdvancedModelsLowThresholdPercent: 20,
  enableCursorAdvancedModelsLowAlert: true,
  cursorModelsLowThresholdPercent: 20,
  enableCursorModelsLowAlert: true,
  claudeSessionLowThresholdPercent: 20,
  enableClaudeSessionLowAlert: true,
  claudeWeeklyLowThresholdPercent: 20,
  enableClaudeWeeklyLowAlert: true,
  enableClaudeCooldownAlert: true,
  codexSessionLowThresholdPercent: 20,
  enableCodexSessionLowAlert: true,
  codexWeeklyLowThresholdPercent: 20,
  enableCodexWeeklyLowAlert: true,
  enableCodexCooldownAlert: true,
  launchWithIde: false,
  launchAtStartup: false,
  notifyCooldownMinutes: 15,
  enableCursorResetAlarm: true,
  enableClaudeResetAlarm: true,
  enableClaudeWeeklyResetAlarm: true,
  enableClaudeBillingAlarm: true,
  claudeBillingCadence: "monthly",
  enableCodexResetAlarm: true,
  enableCodexWeeklyResetAlarm: true,
  language: "zh",
  trayValueColorMode: "system",
  enableAlarmPopup: true,
  enableLineNotification: true,
  lineChannelAccessToken: "",
  claudeManualToken: "",
  claudeUseCliActivityPolling: true,
  codexUseCliActivityPolling: false,
  enableWaterReminder: true,
  waterReminderMinutes: 50,
  waterCupSizeMl: 500
};
