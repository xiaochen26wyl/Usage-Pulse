import { defaultAlertChannels } from "@shared/notify-channels";
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
  cursorModelsLowThresholdPercent: 20,
  claudeSessionLowThresholdPercent: 20,
  claudeWeeklyLowThresholdPercent: 20,
  codexSessionLowThresholdPercent: 20,
  codexWeeklyLowThresholdPercent: 20,
  launchWithIde: false,
  notifyCooldownMinutes: 15,
  language: "zh",
  showWeeklyInTray: true,
  alertChannels: defaultAlertChannels(),
  lineChannelAccessToken: "",
  claudeManualToken: "",
  autoCheckForUpdates: true
};
