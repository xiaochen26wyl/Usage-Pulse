export type ServiceType = "cursor" | "claude" | "codex";

export type Language = "zh" | "en" | "ja" | "ko";

// How menu-bar quota values (line 2) are coloured. Brand labels on line 1 stay
// on their service accents regardless of this setting.
export type TrayValueColorMode = "system" | "white" | "black";

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
  // Claude Code subscription billing: the official usage API has no monthly
  // quota window. These come from /api/oauth/profile's subscription_created_at
  // plus the user's monthly/annual cadence — they do not refill quota.
  billingResetAt?: string | null;
  billingResetLabel?: string | null;
  billingAnchorAt?: string | null;
  windows: QuotaWindow[];
  status: QuotaStatus;
  message: string;
  errorCode?: ErrorCode;
  source?: QuotaSource;
  // Which credential source the failing request used. A source label only —
  // never token material — so it is safe to hand across IPC.
  credentialSource?: CredentialSource;
  // Codex credits row (balance / unlimited). Not a quota window; shown as meta.
  creditsText?: string | null;
  fetchedAt: string;
}

export type ErrorCode = "claudeLoginExpired" | "claudeScopeInsufficient" | "claudeRateLimited" | "codexLoginExpired";

// Which ranked source supplied the token a request used. Claude monitoring
// treats the macOS Keychain item as authoritative and falls back to a token the
// user pasted into the app ("manualToken"); Cursor's only source is its local
// state database; Codex is the CLI auth file or OS keyring.
export type CredentialSource = "keychain" | "cursorStateDb" | "codexAuthFile" | "manualToken" | "codexKeyring";

export interface CombinedSnapshot {
  cursor: QuotaSnapshot;
  claude: QuotaSnapshot;
  codex: QuotaSnapshot;
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
  codex: CredentialStatus;
}

export interface AppSettings {
  // Opt-in per-service monitoring: off means the service's quota card and
  // settings block are hidden, and its credential is never probed.
  enableCursorMonitoring: boolean;
  enableClaudeMonitoring: boolean;
  enableCodexMonitoring: boolean;
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
  // Codex mirrors Claude Code's three-way split: 5-hour session, weekly, and
  // the lockout that starts when the session window hits 0%. Extra API windows
  // (per-model, code review) are displayed but not independently alerted.
  codexSessionLowThresholdPercent: number;
  enableCodexSessionLowAlert: boolean;
  codexWeeklyLowThresholdPercent: number;
  enableCodexWeeklyLowAlert: boolean;
  enableCodexCooldownAlert: boolean;
  // When on, a tiny login helper starts Usage-Pulse only after Cursor or
  // Claude Code is running. The menu-bar app itself is not a login item.
  launchWithIde: boolean;
  // When on, Usage-Pulse itself is registered as a normal OS login item and
  // starts on every boot. Mutually exclusive with launchWithIde — settingsStore
  // enforces this, since "always launch at boot" and "only launch once the IDE
  // is running" are contradictory goals.
  launchAtStartup: boolean;
  notifyCooldownMinutes: number;
  enableCursorResetAlarm: boolean;
  // 5-hour session reset only. Weekly used to share this switch; existing
  // stores migrate enableClaudeWeeklyResetAlarm from this value on first read.
  enableClaudeResetAlarm: boolean;
  enableClaudeWeeklyResetAlarm: boolean;
  enableClaudeBillingAlarm: boolean;
  claudeBillingCadence: ClaudeBillingCadence;
  enableCodexResetAlarm: boolean;
  enableCodexWeeklyResetAlarm: boolean;
  language: Language;
  // Menu-bar numeric text: follow OS appearance, or force white / near-black.
  trayValueColorMode: TrayValueColorMode;
  enableAlarmPopup: boolean;
  // Independent of the token: off skips LINE even when a token is stored.
  enableLineNotification: boolean;
  // Stored encrypted and never handed back to a renderer in cleartext — see
  // LINE_TOKEN_MASK.
  lineChannelAccessToken: string;
  // A Claude OAuth token the user pasted into the app, used only when the CLI's
  // own Keychain credential is missing or expired. Stored encrypted and never
  // handed back to a renderer in cleartext - see CLAUDE_TOKEN_MASK. Nothing is
  // written here unless it has already proved it can read the usage API, so a
  // stored value is one that worked at least once.
  claudeManualToken: string;
  // Poll Claude Code only when its CLI has actually been active since the last
  // successful fetch. Idle ticks skip the request but keep the normal interval.
  claudeUseCliActivityPolling: boolean;
  // Optional Codex traffic saver: skip the usage API while the CLI session dir
  // has been idle since the last successful fetch.
  codexUseCliActivityPolling: boolean;
  // Drink-water reminder: interval from launch (or last response) and the cup
  // size recorded when the user confirms they drank.
  enableWaterReminder: boolean;
  waterReminderMinutes: number;
  waterCupSizeMl: WaterCupSizeMl;
}

export type ClaudeBillingCadence = "monthly" | "annual";

export const WATER_CUP_SIZES_ML = [250, 500, 1000] as const;
export type WaterCupSizeMl = (typeof WATER_CUP_SIZES_ML)[number];

export type SessionDeltaKind = "consumed" | "reset" | "unknown";

export interface SessionMetricDelta {
  key: "billing" | "cursorModels" | "advancedModels" | "claudeSession" | "claudeWeekly" | "codexSession" | "codexWeekly";
  kind: SessionDeltaKind;
  // Consumed amount when kind is "consumed"; otherwise null.
  used: number | null;
  unit: "usd" | "percent";
}

export interface SessionUsageDeltas {
  billing: SessionMetricDelta;
  cursorModels: SessionMetricDelta;
  advancedModels: SessionMetricDelta;
  claudeSession: SessionMetricDelta;
  claudeWeekly: SessionMetricDelta;
  codexSession: SessionMetricDelta;
  codexWeekly: SessionMetricDelta;
}

// Per-launch session: duration, water, and quota consumed since this process started.
export interface SessionStats {
  startedAt: string;
  durationMs: number;
  waterMl: number;
  waterCups: number;
  nextWaterAt: string | null;
  usage: SessionUsageDeltas;
}

// Same contract for the LINE channel access token. It is a live credential —
// anyone holding it can broadcast to the user's official account — so the
// renderer, which only needs to know whether one is stored, gets this instead.
export const LINE_TOKEN_MASK = "__stored__";

// Same contract as LINE_TOKEN_MASK, for the manually pasted Claude token: what
// settings:get hands the renderer in place of the real value, and what
// settings:save strips back out so the mask can never overwrite the secret.
export const CLAUDE_TOKEN_MASK = "__stored__";

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
  billingResetAt?: string | null;
  billingResetLabel?: string | null;
  billingAnchorAt?: string | null;
  windows: QuotaWindow[];
  message: string;
  isError?: boolean;
  errorCode?: ErrorCode;
  source?: QuotaSource;
  // Which credential source produced the token behind this result. Only set on
  // the Claude error path today, where it decides whether a stored fallback
  // token is the one the API just rejected.
  credentialSource?: CredentialSource;
  creditsText?: string | null;
}

export interface NotifyPayload {
  snapshot: CombinedSnapshot;
  reason: string;
}


export type AlarmSource =
  | "cursor-billing"
  | "claude-session"
  | "claude-weekly"
  | "claude-billing"
  | "codex-session"
  | "codex-weekly";

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
  | "codex-session-low"
  | "codex-weekly-low"
  | "codex-cooldown"
  // Quota fully spent on that window. Cursor has one per model window; Claude
  // Code and Codex only count the weekly window (the 5-hour window going to
  // zero is the cooldown alert above, which recovers on its own).
  | "cursor-advanced-models-exhausted"
  | "cursor-models-exhausted"
  | "claude-weekly-exhausted"
  | "codex-weekly-exhausted";

export interface AlarmPopupPayload {
  id: AlarmSource | LowQuotaAlertSource | "test" | "water";
  service: ServiceType | null;
  label: string;
  fireAt: string;
  soundEnabled: boolean;
  language: Language;
  // Set only for the cooldown popup: when present, the popup shows a live
  // countdown to this ISO time (the session window's resetsAt) instead of a
  // static "fired at" timestamp.
  countdownTarget?: string | null;
  // True when the matching 5-hour reset alarm (到點提醒) is on, so the
  // cooldown popup can note that a recovery reminder is already armed.
  resetAlarmEnabled?: boolean;
}

export interface AlarmStatusReport {
  nextTarget: AlarmTarget | null;
}


// Outcome of an explicit "Update Values" click. Quota is already applied in
// main; `message` is localized. A 401 is still ok:true — the snapshot carries
// claudeLoginExpired so the renderer can flip the button back to login.
export interface ManualQuotaResult {
  ok: boolean;
  message: string;
}

// Why a pasted Claude token was refused. Every one of these means nothing was
// stored: a token only earns a place in settings by proving, right there, that
// it can read the usage API.
export type ClaudeTokenRejectCode =
  | "empty"
  | "formatInvalid"
  | "loginExpired"
  | "scopeInsufficient"
  | "rateLimited"
  | "apiFailed";

// Outcome of "validate this pasted token, and store it only if it works".
// `message` is localized and safe to render as-is.
export interface ClaudeTokenSaveResult {
  ok: boolean;
  code?: ClaudeTokenRejectCode;
  message: string;
}
