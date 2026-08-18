import type { AppSettings, ServiceType } from "@shared/types";

export const SERVICE_LABELS: Record<ServiceType, string> = {
  cursor: "Cursor",
  claude: "Claude Code"
};

export const DEFAULT_SETTINGS: AppSettings = {
  intervalMinutes: 10,
  lowThresholdPercent: 20,
  launchAtLogin: false,
  notifyCooldownMinutes: 15,
  enableResetAlarm: true,
  enableCursorResetAlarm: true,
  enableClaudeResetAlarm: true,
  enableCursorLowQuotaAlert: true,
  enableClaudeLowQuotaAlert: true,
  language: "zh"
};
