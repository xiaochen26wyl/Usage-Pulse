import type { AppSettings, ServiceType } from "@shared/types";

export const SERVICE_URLS: Record<ServiceType, string> = {
  cursor: "https://www.cursor.com/settings",
  claude: "https://claude.ai"
};

export const SERVICE_LABELS: Record<ServiceType, string> = {
  cursor: "Cursor",
  claude: "Claude"
};

export const DEFAULT_SETTINGS: AppSettings = {
  intervalMinutes: 5,
  lowThresholdPercent: 20,
  lineChannelToken: "",
  enableLineNotify: false,
  launchAtLogin: false,
  notifyCooldownMinutes: 15
};

export const CURSOR_FAST_REQUEST_REGEXES: RegExp[] = [
  /Fast Requests?[\s\S]{0,60}?(\d+)\s*\/\s*(\d+)/i,
  /Fast Requests?[\s\S]{0,40}?(\d+)/i
];

export const CLAUDE_REMAINING_REGEXES: RegExp[] = [
  /Remaining messages?[\s:：]+(\d+)/i,
  /(\d+)\s+messages?\s+remaining/i
];
