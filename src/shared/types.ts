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
  enableSystemAlarmWakeApp: boolean;
  enableSystemAlarmNative: boolean;
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

export type SystemAlarmKind = "wake-app" | "native";

export type SystemAlarmState =
  | "unsupported"
  | "disabled"
  | "not-installed"
  | "armed"
  | "stale"
  | "error";

export interface SystemAlarmStatus {
  kind: SystemAlarmKind;
  state: SystemAlarmState;
  fireAt: string | null;
  // When this status was actually verified against the OS. Never a cached flag:
  // every probe() shells out and asks the scheduler what it really holds.
  verifiedAt: string;
  message?: string;
}

export interface AlarmStatusReport {
  nextTarget: AlarmTarget | null;
  system: SystemAlarmStatus[];
}
