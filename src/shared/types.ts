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
  // Cursor's low-quota warning is split by model tier: "advanced models" is the
  // other_models/apiPercentUsed window (pay-as-you-go premium models), "cursor
  // models" is the cursor_models/autoPercentUsed window (Cursor's own Grok/Composer).
  cursorAdvancedModelsLowThresholdPercent: number;
  enableCursorAdvancedModelsLowAlert: boolean;
  cursorModelsLowThresholdPercent: number;
  enableCursorModelsLowAlert: boolean;
  // Claude Code's low-quota warning is split three ways: the 5-hour session
  // window's consumption, its weekly window's consumption, and a separate
  // cooldown alert (see enableClaudeCooldownAlert below).
  claudeSessionLowThresholdPercent: number;
  enableClaudeSessionLowAlert: boolean;
  claudeWeeklyLowThresholdPercent: number;
  enableClaudeWeeklyLowAlert: boolean;
  // Not a percent threshold: the Claude Code 5-hour window starts counting the
  // moment the first message is sent (not when the quota runs out), so once the
  // session quota hits 0% the user is locked out until that window's resetsAt,
  // regardless of how much of the 5 hours has actually elapsed. This toggle
  // alerts on that lockout state itself, distinct from the consumption warning.
  enableClaudeCooldownAlert: boolean;
  launchAtLogin: boolean;
  notifyCooldownMinutes: number;
  enableCursorResetAlarm: boolean;
  enableClaudeResetAlarm: boolean;
  language: Language;
  enableAlarmPopup: boolean;
  alarmSoundEnabled: boolean;
  lineChannelAccessToken: string;
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
// restart) does not replay the same firing.
export interface AlarmFireRecord {
  fireAt: string;
  firedAt: string;
}

// Ids for the independent low-quota-style popups, one per alert configured in
// settings — distinct from AlarmSource (the scheduled reset-time alarms) even
// though "claude-cooldown" describes the same underlying session window.
export type LowQuotaAlertSource =
  | "cursor-advanced-models-low"
  | "cursor-models-low"
  | "claude-session-low"
  | "claude-weekly-low"
  | "claude-cooldown"
  // Quota fully spent on that window. Cursor has one per model window; Claude
  // Code only counts the weekly window (its 5-hour window going to zero is the
  // cooldown alert above, which recovers on its own).
  | "cursor-advanced-models-exhausted"
  | "cursor-models-exhausted"
  | "claude-weekly-exhausted";

export interface AlarmPopupPayload {
  id: AlarmSource | LowQuotaAlertSource | "test";
  service: ServiceType | null;
  label: string;
  fireAt: string;
  soundEnabled: boolean;
  language: Language;
  // Set only for the cooldown popup: when present, the popup shows a live
  // countdown to this ISO time (the session window's resetsAt) instead of a
  // static "fired at" timestamp.
  countdownTarget?: string | null;
}

export interface AlarmStatusReport {
  nextTarget: AlarmTarget | null;
}
