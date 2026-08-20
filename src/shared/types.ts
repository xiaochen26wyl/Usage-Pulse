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
  errorCode?: ErrorCode;
  fetchedAt: string;
}

export type ErrorCode = "claudeLoginExpired";

export interface CombinedSnapshot {
  cursor: QuotaSnapshot;
  claude: QuotaSnapshot;
  fetchedAt: string;
}

// How healthy the locally-stored credential for one service is right now.
// "missing" means no credential was found at all; "error" means one exists but
// could not be read (unreadable state.vscdb, API-key-only mode, and so on).
export type CredentialState = "ok" | "expiring" | "expired" | "missing" | "error";

// Derived credential facts safe to hand to the renderer. Deliberately carries
// no token and no fingerprint: raw credential material never crosses IPC.
export interface CredentialStatus {
  service: ServiceType;
  state: CredentialState;
  // Null whenever the credential carries no parseable expiry.
  expiresAt: string | null;
  // When the credential last changed underneath us (i.e. the IDE refreshed it).
  rotatedAt: string | null;
  checkedAt: string;
  message?: string;
}

export interface AuthStatus {
  cursor: CredentialStatus;
  claude: CredentialStatus;
}

export interface AppSettings {
  cursorIntervalMinutes: number;
  claudeIntervalMinutes: number;
  cursorLowThresholdPercent: number;
  claudeLowThresholdPercent: number;
  launchAtLogin: boolean;
  notifyCooldownMinutes: number;
  enableCursorResetAlarm: boolean;
  enableClaudeResetAlarm: boolean;
  enableCursorLowQuotaAlert: boolean;
  enableClaudeLowQuotaAlert: boolean;
  language: Language;
  enableAlarmPopup: boolean;
  alarmSoundEnabled: boolean;
  alarmPopupAutoDismissMinutes: number;
  alarmCatchUpMinutes: number;
  lineChannelAccessToken: string;
  lineChannelId: string;
  lineAssertionKid: string;
  lineAssertionPrivateKey: string;
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
  errorCode?: ErrorCode;
}

export interface NotifyPayload {
  snapshot: CombinedSnapshot;
  reason: string;
}


export type AlarmSource = "cursor-billing" | "claude-session" | "claude-weekly";

export interface AlarmTarget {
  id: AlarmSource;
  service: ServiceType;
  fireAt: string;
  label: string;
}

// Records that a given fireAt has already rung, so a re-arm (poll, resume,
// restart) replays neither the on-time firing nor its catch-up.
export interface AlarmFireRecord {
  fireAt: string;
  firedAt: string;
  catchUp: boolean;
}

export interface AlarmPopupPayload {
  id: AlarmSource | "test";
  service: ServiceType | null;
  label: string;
  fireAt: string;
  catchUp: boolean;
  autoDismissMinutes: number;
  soundEnabled: boolean;
  language: Language;
}

export interface AlarmStatusReport {
  nextTarget: AlarmTarget | null;
}
