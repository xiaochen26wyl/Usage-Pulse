export type ServiceType = "cursor" | "claude";

export type QuotaStatus = "ok" | "low" | "unknown" | "error";

export interface QuotaSnapshot {
  service: ServiceType;
  remaining: number | null;
  total: number | null;
  percent: number | null;
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
  lineChannelToken: string;
  enableLineNotify: boolean;
  launchAtLogin: boolean;
  notifyCooldownMinutes: number;
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
  message: string;
}

export interface NotifyPayload {
  snapshot: CombinedSnapshot;
  reason: string;
}
