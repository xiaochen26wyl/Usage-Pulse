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

// Where a snapshot's numbers came from. "api" is the official usage endpoint;
// "cli-log" is the local Claude Code session log, which can corroborate a
// lockout without spending an API request.
export type QuotaSource = "api" | "cli-log";

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
  source?: QuotaSource;
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
  // A Claude Code OAuth token the user pasted in themselves (`claude
  // setup-token`), used when automatic detection cannot reach the Keychain or
  // the credentials file. Stored encrypted and never handed back to a renderer
  // in cleartext — see CLAUDE_MANUAL_TOKEN_MASK.
  claudeManualOAuthToken: string;
  // Poll Claude Code only when its CLI has actually been active since the last
  // successful fetch, stretching to claudeIdleIntervalMinutes when it has not.
  // This exists to *reduce* request volume, not to increase it.
  claudeUseCliActivityPolling: boolean;
  claudeIdleIntervalMinutes: number;
  // Read quota events out of the local Claude Code session logs. Credential-free
  // and costs no API request, but the log directory also holds conversation
  // content, so it is opt-outable.
  claudeUseLocalSessionLogs: boolean;
}

// What a renderer sees in place of a stored manual token. The renderer only
// ever needs to know whether one is set, so the value itself never crosses IPC.
export const CLAUDE_MANUAL_TOKEN_MASK = "__stored__";

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
  source?: QuotaSource;
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

// Records that a given fireAt was observed while it was still in the future.
// An alarm only rings for a fireAt it has seen pending: a reset time we first
// laid eyes on when it was already past is a gap in our own observation, not a
// reset that just happened, and ringing for it is how a freshly recovered
// credential used to manufacture a bogus alarm.
export interface AlarmObservation {
  fireAt: string;
  seenAt: string;
}

// The last reset time each alarm source was seen carrying while its snapshot
// was still trustworthy. A credential outage blanks resetsAt, which would
// otherwise silently disarm a real pending alarm.
export interface AlarmLastGoodRecord {
  fireAt: string;
  observedAt: string;
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


// What the manual-credential window needs to render itself: which service is
// stuck and why automatic detection gave up.
export interface ManualCredentialContext {
  service: ServiceType;
  state: CredentialState;
  message: string;
  language: Language;
  hasStoredToken: boolean;
}

// The outcome of validating a pasted token. `message` is already localized.
export interface ManualTokenResult {
  ok: boolean;
  message: string;
}
