import type { AppSettings, ServiceType } from "@shared/types";

export const SERVICE_LABELS: Record<ServiceType, string> = {
  cursor: "Cursor",
  claude: "Claude Code"
};

export const DEFAULT_SETTINGS: AppSettings = {
  cursorIntervalMinutes: 10,
  claudeIntervalMinutes: 10,
  cursorLowThresholdPercent: 20,
  claudeLowThresholdPercent: 20,
  launchAtLogin: false,
  notifyCooldownMinutes: 15,
  enableCursorResetAlarm: true,
  enableClaudeResetAlarm: true,
  enableCursorLowQuotaAlert: true,
  enableClaudeLowQuotaAlert: true,
  language: "zh",
  lineChannelAccessToken: "",
  lineChannelId: "",
  lineAssertionKid: "",
  lineAssertionPrivateKey: ""
};
