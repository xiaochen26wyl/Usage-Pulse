export type ServiceType = "cursor" | "claude";

export type Language = "zh" | "en";

export type QuotaStatus = "ok" | "low" | "unknown" | "error";
export type QuotaUnit = "usd" | "percent" | "count";

export interface QuotaWindow {
  key: string;
  label: string;
  remaining: number | null;
  total: number | null;
  percent: number | null;
  resetsAt: string | null;
  message?: string;
}

export interface QuotaSnapshot {
  service: ServiceType;
  remaining: number | null;
  total: number | null;
  percent: number | null;
  unit: QuotaUnit;
  resetsAt: string | null;
  resetLabel?: string | null;
  weeklyResetAt?: string | null;
  weeklyResetLabel?: string | null;
  windows: QuotaWindow[];
  status: QuotaStatus;
  message: string;
  fetchedAt: string;
}

export interface CombinedSnapshot {
  cursor: QuotaSnapshot;
  claude: QuotaSnapshot;
  fetchedAt: string;
}

export interface AuthStatus {
  cursor: boolean;
  claude: boolean;
}

export interface AppSettings {
  intervalMinutes: number;
  lowThresholdPercent: number;
  launchAtLogin: boolean;
  notifyCooldownMinutes: number;
  enableResetAlarm: boolean;
  enableCursorResetAlarm: boolean;
  enableClaudeResetAlarm: boolean;
  enableCursorLowQuotaAlert: boolean;
  enableClaudeLowQuotaAlert: boolean;
  language: Language;
}

export interface MonitorResult {
  snapshot: CombinedSnapshot;
  changed: boolean;
  lowAlert: boolean;
  notified: boolean;
  reason: string;
}

export interface ScrapeResult {
  remaining: number | null;
  total: number | null;
  unit: QuotaUnit;
  resetsAt: string | null;
  resetLabel?: string | null;
  weeklyResetAt?: string | null;
  weeklyResetLabel?: string | null;
  windows: QuotaWindow[];
  message: string;
  isError?: boolean;
}

export interface NotifyPayload {
  snapshot: CombinedSnapshot;
  reason: string;
}

