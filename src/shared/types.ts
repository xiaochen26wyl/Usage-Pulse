export type ServiceType = "cursor" | "claude";

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
  fetchedAt: string;
}

export type ErrorCode = "claudeLoginExpired";

// Which of readClaudeCredential's ranked sources actually supplied the token a
// request used. Without this, a 401 tells us a credential is dead but not
// *which* one — and the self-heal that drops a stale fallback token would fire
// on 401s belonging to a completely different source (see
// claude-fallback-decision.ts). "cursorStateDb" is Cursor's only source.
export type CredentialSource = "env" | "manual" | "keychain" | "file" | "cursorStateDb";

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
  // Opt-in per-service monitoring: off means the service's quota card and
  // settings block are hidden, and its credential is never probed.
  enableCursorMonitoring: boolean;
  enableClaudeMonitoring: boolean;
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
  language: Language;
  // Menu-bar numeric text: follow OS appearance, or force white / near-black.
  trayValueColorMode: TrayValueColorMode;
  enableAlarmPopup: boolean;
  // Independent of the token: off skips LINE even when a token is stored.
  enableLineNotification: boolean;
  // Stored encrypted and never handed back to a renderer in cleartext — see
  // LINE_TOKEN_MASK.
  lineChannelAccessToken: string;
  // The token the "re-detect" flow captures from running `claude setup-token`
  // in a terminal, kept as a fallback for when the Keychain write it also
  // performs cannot be confirmed. Stored encrypted and never handed back to a
  // renderer in cleartext — see CLAUDE_MANUAL_TOKEN_MASK.
  claudeManualOAuthToken: string;
  // When claudeManualOAuthToken was issued plus its known validity (`claude
  // setup-token` tokens are documented as valid for 1 year, and carry no
  // expiry claim of their own — see computeSetupTokenExpiryIso). Lets the
  // re-detect flow decide the credential is still good without ever calling
  // the usage API just to find out.
  claudeManualOAuthTokenExpiresAt: string | null;
  // Poll Claude Code only when its CLI has actually been active since the last
  // successful fetch. Idle ticks skip the request but keep the normal interval.
  claudeUseCliActivityPolling: boolean;
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
  key: "billing" | "cursorModels" | "advancedModels" | "claudeSession" | "claudeWeekly";
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

// What a renderer sees in place of a stored manual token. The renderer only
// ever needs to know whether one is set, so the value itself never crosses IPC.
export const CLAUDE_MANUAL_TOKEN_MASK = "__stored__";

// Same contract for the LINE channel access token. It is a live credential —
// anyone holding it can broadcast to the user's official account — so the
// renderer, which only needs to know whether one is stored, gets this instead.
export const LINE_TOKEN_MASK = "__stored__";

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
}

export interface NotifyPayload {
  snapshot: CombinedSnapshot;
  reason: string;
}


export type AlarmSource = "cursor-billing" | "claude-session" | "claude-weekly" | "claude-billing";

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
}

export interface AlarmStatusReport {
  nextTarget: AlarmTarget | null;
}


// The outcome of the "re-detect" flow (Keychain lookup, or a `claude
// setup-token` run when that comes up empty). `message` is already localized.
export interface ManualTokenResult {
  ok: boolean;
  message: string;
  // True only when persistClaudeToken's Keychain write threw. The token is
  // still usable (settings-store fallback), but the user should know the
  // Keychain copy did not actually get written, since that fallback is
  // silent and easy to lose track of (e.g. a settings reset would drop it).
  keychainWriteFailed?: boolean;
  // True only when the automatic `claude setup-token` capture itself failed
  // (no claude binary, timed out, no terminal, nothing in the output) — not
  // for a login that is merely already in progress elsewhere. Tells the
  // renderer to offer the manual "copy the command, paste the token back"
  // fallback instead of just showing an error and dead-ending.
  needsManualFallback?: boolean;
  // True only when this result already confirms real quota data is sitting
  // in main, ready to view. The renderer never applies it automatically —
  // it shows an explicit "Update UI" confirmation button instead, so the
  // user always sees which credential state actually reached the screen.
  readyToApply?: boolean;
}
