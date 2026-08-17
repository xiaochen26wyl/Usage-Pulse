import type { AppSettings, ServiceType } from "@shared/types";

export const SERVICE_LABELS: Record<ServiceType, string> = {
  cursor: "Cursor",
  claude: "Claude Code"
};

export const DEFAULT_SETTINGS: AppSettings = {
  intervalMinutes: 5,
  lowThresholdPercent: 20,
  lineChannelToken: "",
  enableLineNotify: false,
  launchAtLogin: false,
  notifyCooldownMinutes: 15,
  enableResetAlarm: true,
  enableLowQuotaAlarm: true,
  enableResetAlarmLine: false,
  enableLowQuotaAlarmLine: false
};
