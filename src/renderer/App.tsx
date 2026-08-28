import {
  useEffect,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import {
  WATER_CUP_SIZES_ML,
  type AlarmStatusReport,
  type AppSettings,
  type ClaudeBillingCadence,
  type AuthStatus,
  type CombinedSnapshot,
  type CredentialState,
  type CredentialStatus,
  type ErrorCode,
  type Language,
  type QuotaSnapshot,
  type QuotaWindow,
  type SessionStats,
  type ServiceType,
  type TrayValueColorMode,
  type WaterCupSizeMl,
} from "@shared/types";
import { LINE_TOKEN_MASK } from "@shared/types";
import {
  ALARM_POPUP_AUTO_DISMISS_MINUTES,
  formatCountdown,
} from "@shared/alarm-utils";
import { resolveClaudeBillingAt } from "@shared/claude-billing";
import { localeForLanguage, t, type TranslationKey } from "@shared/i18n";
import {
  INSTAGRAM_URL,
  LINE_URL,
  LINKEDIN_URL,
  THREADS_URL,
  WHATSAPP_URL,
} from "@shared/support-links";
import appLogo from "./assets/app-logo.png";

// The token is masked with a fixed-length run of asterisks rather than one per
// character: a channel access token is ~170 characters, and echoing its real
// length both overflows the field and leaks something about the secret.
const TOKEN_MASK_MAX = 10;
// A stored token never reaches this process, so it arrives as a placeholder.
// Both cases render as the same run of asterisks — the field shows that a
// secret is set, and nothing about the secret itself.
const maskToken = (token: string): string =>
  token === LINE_TOKEN_MASK
    ? "*".repeat(TOKEN_MASK_MAX)
    : "*".repeat(Math.min(token.length, TOKEN_MASK_MAX));

const LANGUAGE_OPTIONS: Array<{ value: Language; label: string }> = [
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
];

// Claude Code's 5-hour session window has a fixed duration; only its end
// (resetsAt) comes from the API, so the countdown bar's fill derives the
// elapsed fraction from that fixed length.
const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;

const defaultSettings: AppSettings = {
  enableCursorMonitoring: true,
  enableClaudeMonitoring: true,
  cursorAdvancedModelsLowThresholdPercent: 20,
  enableCursorAdvancedModelsLowAlert: true,
  cursorModelsLowThresholdPercent: 20,
  enableCursorModelsLowAlert: true,
  claudeSessionLowThresholdPercent: 20,
  enableClaudeSessionLowAlert: true,
  claudeWeeklyLowThresholdPercent: 20,
  enableClaudeWeeklyLowAlert: true,
  enableClaudeCooldownAlert: true,
  launchWithIde: false,
  launchAtStartup: false,
  notifyCooldownMinutes: 15,
  enableCursorResetAlarm: true,
  enableClaudeResetAlarm: true,
  enableClaudeWeeklyResetAlarm: true,
  enableClaudeBillingAlarm: true,
  claudeBillingCadence: "monthly",
  language: "zh",
  trayValueColorMode: "system",
  enableAlarmPopup: true,
  enableLineNotification: true,
  lineChannelAccessToken: "",
  claudeManualOAuthToken: "",
  claudeManualOAuthTokenExpiresAt: null,
  claudeUseCliActivityPolling: true,
  enableWaterReminder: true,
  waterReminderMinutes: 50,
  waterCupSizeMl: 500,
};

const emptyCredential = (service: ServiceType): CredentialStatus => ({
  service,
  state: "missing",
  expiresAt: null,
  rotatedAt: null,
  checkedAt: "",
});

const defaultAuth: AuthStatus = {
  cursor: emptyCredential("cursor"),
  claude: emptyCredential("claude"),
};

const credentialStateKeys: Record<
  CredentialState,
  | "auth.state.ok"
  | "auth.state.expiring"
  | "auth.state.expired"
  | "auth.state.missing"
  | "auth.state.error"
> = {
  ok: "auth.state.ok",
  expiring: "auth.state.expiring",
  expired: "auth.state.expired",
  missing: "auth.state.missing",
  error: "auth.state.error",
};

// Reuses the quota status-tag palette so a card reads consistently top to
// bottom: green healthy, amber needs-attention, red broken.
const credentialTagClass = (state: CredentialState): string => {
  if (state === "ok") {
    return "status-ok";
  }
  if (state === "expiring") {
    return "status-low";
  }
  if (state === "missing") {
    return "status-unknown";
  }
  return "status-error";
};

const serviceNames: Record<ServiceType, string> = {
  cursor: "Cursor",
  claude: "Claude Code",
};

const authHintKeys: Record<
  ServiceType,
  "auth.hint.cursor" | "auth.hint.claude"
> = {
  cursor: "auth.hint.cursor",
  claude: "auth.hint.claude",
};

const formatValue = (
  value: number | null,
  unit: QuotaSnapshot["unit"],
): string => {
  if (value === null) {
    return "N/A";
  }
  if (unit === "usd") {
    return `$${value.toFixed(2)}`;
  }
  if (unit === "percent") {
    return `${Math.round(value)}%`;
  }
  return `${value}`;
};

const formatResetText = (iso: string | null, lang: Language): string => {
  if (!iso) {
    return t(lang, "app.unknown");
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return t(lang, "app.unknown");
  }
  return date.toLocaleString(localeForLanguage(lang));
};

type LowQuotaThresholdKey =
  | "cursorAdvancedModelsLowThresholdPercent"
  | "cursorModelsLowThresholdPercent"
  | "claudeSessionLowThresholdPercent"
  | "claudeWeeklyLowThresholdPercent";

type LowQuotaToggleKey =
  | "enableCursorAdvancedModelsLowAlert"
  | "enableCursorModelsLowAlert"
  | "enableClaudeSessionLowAlert"
  | "enableClaudeWeeklyLowAlert";

const roundToStep = (
  value: unknown,
  min: number,
  max: number,
  step: number,
  fallback: number,
): number => {
  const numeric = Number(value) || fallback;
  const clamped = Math.min(max, Math.max(min, numeric));
  return Math.round(clamped / step) * step;
};

export const App = () => {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [authStatus, setAuthStatus] = useState<AuthStatus>(defaultAuth);
  const [snapshot, setSnapshot] = useState<CombinedSnapshot | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState<
    Record<ServiceType, boolean>
  >({ cursor: false, claude: false });
  const [authMessage, setAuthMessage] = useState<Record<ServiceType, string>>({
    cursor: "",
    claude: "",
  });
  // Shown once "Get Credentials" opens a fresh claude-login window — lets the
  // user paste (or receive an auto-filled) token back here instead of dead-
  // ending on an error message.
  const [claudeNeedsManualFallback, setClaudeNeedsManualFallback] = useState(false);
  // True whenever main has already confirmed real quota data is sitting
  // there ready to view (a single re-detect check, or a manual submit, both
  // came back with real usage windows) — the header button becomes an
  // explicit "Update UI" confirmation instead of the numbers changing on
  // their own underneath the user.
  const [claudeReadyToApply, setClaudeReadyToApply] = useState(false);
  const [manualTokenInput, setManualTokenInput] = useState("");
  const [manualTokenSubmitting, setManualTokenSubmitting] = useState(false);
  const [manualTokenCopied, setManualTokenCopied] = useState(false);
  const [lineToken, setLineToken] = useState("");
  // False only on hosts with no OS keychain available, where a saved token
  // would land in the settings file as plain text. The user is told rather
  // than silently downgraded.
  const [secretStorageOk, setSecretStorageOk] = useState(true);
  const [savingLineToken, setSavingLineToken] = useState(false);
  const [lineTokenMessage, setLineTokenMessage] = useState<{
    text: string;
    isError: boolean;
  }>({
    text: "",
    isError: false,
  });
  const [testingLineToken, setTestingLineToken] = useState(false);
  const [sendingLineStatus, setSendingLineStatus] = useState(false);
  // Reveals the token input again once a token is already stored (the
  // collapsed "connected" state hides it by default). Reset to false whenever
  // a save succeeds, so the panel collapses back down.
  const [showLineTokenInput, setShowLineTokenInput] = useState(false);
  const [now, setNow] = useState<number>(Date.now());
  const [alarmStatus, setAlarmStatus] = useState<AlarmStatusReport | null>(
    null,
  );
  const [alarmMessage, setAlarmMessage] = useState("");
  const [checkingAlarm, setCheckingAlarm] = useState(false);
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const lang = settings.language;
  const claudeBillingAt = resolveClaudeBillingAt(
    snapshot?.claude.billingAnchorAt,
    snapshot?.claude.billingResetAt,
    settings.claudeBillingCadence,
    now,
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const refreshBaseData = async () => {
    const [nextSettings, nextAuthStatus, latestSnapshot, nextAlarmStatus, nextSessionStats] =
      await Promise.all([
        window.usagePulse.getSettings(),
        window.usagePulse.getAuthStatus(),
        window.usagePulse.getLatestSnapshot(),
        window.usagePulse.getAlarmStatus(),
        window.usagePulse.getSessionStats(),
      ]);
    setSettings(nextSettings);
    setAuthStatus(nextAuthStatus);
    setSnapshot(latestSnapshot);
    setAlarmStatus(nextAlarmStatus);
    setSessionStats(nextSessionStats);
    setLineToken(nextSettings.lineChannelAccessToken);
  };

  useEffect(() => {
    window.usagePulse
      .isSecretStorageAvailable()
      .then(setSecretStorageOk)
      .catch(() => setSecretStorageOk(true));
  }, []);

  useEffect(() => {
    refreshBaseData().catch((error) => {
      console.error(error);
    });

    const unsubscribeSnapshot = window.usagePulse.onSnapshotUpdated(
      (nextSnapshot) => {
        setSnapshot(nextSnapshot);
      },
    );

    const unsubscribeAuth = window.usagePulse.onAuthUpdated((nextAuth) => {
      setAuthStatus(nextAuth);
    });

    const unsubscribeSession = window.usagePulse.onSessionStatsUpdated((next) => {
      setSessionStats(next);
    });

    // The claude-login PTY auto-detected the printed token — fill it in
    // (in the clear, not masked) so the user can confirm/adjust it before
    // submitting rather than it applying itself silently.
    const unsubscribeTokenCaptured = window.usagePulse.onManualTokenCaptured((token) => {
      setManualTokenInput(token);
    });

    const unsubscribeSpawnError = window.usagePulse.onSetupTokenSpawnError((message) => {
      setAuthMessage((prev) => ({ ...prev, claude: message }));
    });

    return () => {
      unsubscribeSnapshot();
      unsubscribeAuth();
      unsubscribeSession();
      unsubscribeTokenCaptured();
      unsubscribeSpawnError();
    };
  }, []);

  const clampSettings = (value: AppSettings): AppSettings => ({
    ...value,
    cursorAdvancedModelsLowThresholdPercent: roundToStep(
      value.cursorAdvancedModelsLowThresholdPercent,
      5,
      30,
      5,
      20,
    ),
    cursorModelsLowThresholdPercent: roundToStep(
      value.cursorModelsLowThresholdPercent,
      5,
      30,
      5,
      20,
    ),
    claudeSessionLowThresholdPercent: roundToStep(
      value.claudeSessionLowThresholdPercent,
      5,
      30,
      5,
      20,
    ),
    claudeWeeklyLowThresholdPercent: roundToStep(
      value.claudeWeeklyLowThresholdPercent,
      5,
      30,
      5,
      20,
    ),
    notifyCooldownMinutes: roundToStep(
      value.notifyCooldownMinutes,
      5,
      240,
      5,
      15,
    ),
    waterReminderMinutes: roundToStep(
      value.waterReminderMinutes,
      5,
      180,
      1,
      50,
    ),
  });

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      const next = await window.usagePulse.saveSettings(
        clampSettings(settings),
      );
      setSettings(next);
      setAlarmStatus(await window.usagePulse.getAlarmStatus());
      setSessionStats(await window.usagePulse.getSessionStats());
    } catch (error) {
      console.error(error);
    } finally {
      setSavingSettings(false);
    }
  };

  const refreshAlarmStatus = async () => {
    setCheckingAlarm(true);
    try {
      setAlarmStatus(await window.usagePulse.getAlarmStatus());
      setAlarmMessage("");
    } catch (error) {
      setAlarmMessage(
        t(lang, "alarm.checkFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setCheckingAlarm(false);
    }
  };

  const testAlarmPopup = async () => {
    try {
      await window.usagePulse.testAlarmPopup();
      setAlarmMessage("");
    } catch (error) {
      setAlarmMessage(
        error instanceof Error ? error.message : t(lang, "alarm.testFailed"),
      );
    }
  };

  // Scoped to one service: the Cursor card re-reads only Cursor's credential and
  // the Claude Code card only Claude's, so retrying one never disturbs the other.
  //
  // Claude is fire-and-forget rather than awaited end-to-end: the manual
  // paste box (below) needs to appear the instant the user clicks, racing
  // alongside the automatic capture instead of waiting for it to finish or
  // fail first. `checkingAuth.claude` still stays true for the whole run —
  // the header button remains a disabled status pill throughout — it's only
  // this function's own `await` that no longer blocks the render.
  // Scoped to one service: the Cursor card re-reads only Cursor's credential and
  // the Claude Code card only Claude's, so retrying one never disturbs the other.
  // For claude this is now always fast (a local Keychain+expiry check, at most
  // one API validation call, or just opening the claude-login window) — no more
  // fire-and-forget needed, a plain await covers every outcome.
  const refreshAuthStatus = async (service: ServiceType) => {
    setCheckingAuth((prev) => ({ ...prev, [service]: true }));

    if (service === "claude") {
      setAuthMessage((prev) => ({ ...prev, claude: t(lang, "setupToken.waiting") }));
      try {
        const result = await window.usagePulse.runSetupToken();
        setAuthMessage((prev) => ({ ...prev, claude: result.message }));
        if (result.readyToApply) {
          // Already confirmed real quota data is ready — don't apply it
          // automatically, let the user press "Update UI" to pull it in.
          setClaudeNeedsManualFallback(false);
          setClaudeReadyToApply(true);
        } else if (result.needsManualFallback) {
          setManualTokenInput("");
          setClaudeReadyToApply(false);
          setClaudeNeedsManualFallback(true);
        }
      } catch (error) {
        setAuthMessage((prev) => ({
          ...prev,
          claude: error instanceof Error ? error.message : t(lang, "app.authRefreshFailed"),
        }));
      } finally {
        setCheckingAuth((prev) => ({ ...prev, claude: false }));
      }
      return;
    }

    try {
      const next = await window.usagePulse.checkAuth(service);
      setAuthStatus((prev) => ({ ...prev, [service]: next }));
      setAuthMessage((prev) => ({
        ...prev,
        [service]: t(lang, "app.authRefreshed"),
      }));
    } catch (error) {
      setAuthMessage((prev) => ({
        ...prev,
        [service]:
          error instanceof Error
            ? error.message
            : t(lang, "app.authRefreshFailed"),
      }));
    } finally {
      setCheckingAuth((prev) => ({ ...prev, [service]: false }));
    }
  };

  // The "Update UI" confirmation: main already told us real quota data is
  // ready (a single re-detect check or a manual submit both came back with
  // real usage windows) — this is the one explicit click that actually pulls
  // it onto the screen. If it turns out there's nothing to show after all,
  // that's step 5 of the flow: fall back to the "Get Credentials" state
  // rather than sitting in a state that looks confirmed but shows nothing.
  const applyClaudeUpdate = async () => {
    setCheckingAuth((prev) => ({ ...prev, claude: true }));
    try {
      const [next, latestSnapshot] = await Promise.all([
        window.usagePulse.checkAuth("claude"),
        window.usagePulse.getLatestSnapshot(),
      ]);
      setAuthStatus((prev) => ({ ...prev, claude: next }));
      setSnapshot(latestSnapshot);
      setClaudeReadyToApply(false);
      const hasValues = (latestSnapshot?.claude.windows.length ?? 0) > 0;
      if (!hasValues) {
        setAuthMessage((prev) => ({ ...prev, claude: t(lang, "app.authRefreshFailed") }));
      }
    } finally {
      setCheckingAuth((prev) => ({ ...prev, claude: false }));
    }
  };

  const copyManualSetupCommand = async () => {
    try {
      await window.usagePulse.copyToClipboard("claude setup-token");
      setManualTokenCopied(true);
      setTimeout(() => setManualTokenCopied(false), 3000);
    } catch (error) {
      console.error(error);
    }
  };

  // Applied by hand instead of letting the browser do it: clearing the
  // system clipboard afterward races the default paste action otherwise,
  // which is why pasting used to leave the field empty (see clearSystemClipboard).
  const handleManualTokenPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const pasted = event.clipboardData.getData("text").trim();
    if (pasted) {
      setManualTokenInput(pasted);
      setAuthMessage((prev) => ({ ...prev, claude: "" }));
    }
    clearSystemClipboard();
  };

  const handleManualTokenChange = (event: ChangeEvent<HTMLInputElement>) => {
    setManualTokenInput(event.target.value);
    setAuthMessage((prev) => ({ ...prev, claude: "" }));
  };

  const submitManualToken = async () => {
    const token = manualTokenInput.trim();
    if (!token) {
      setAuthMessage((prev) => ({ ...prev, claude: t(lang, "manualToken.invalidFormat") }));
      return;
    }
    setManualTokenSubmitting(true);
    try {
      const result = await window.usagePulse.submitManualToken(token);
      setAuthMessage((prev) => ({ ...prev, claude: result.message }));
      if (result.ok) {
        setManualTokenInput("");
        setClaudeNeedsManualFallback(false);
        // Don't apply automatically — same "Update UI" confirmation step as
        // the re-detect path, so a hand-pasted token gets no less scrutiny
        // before its numbers land on screen.
        setClaudeReadyToApply(Boolean(result.readyToApply));
      }
    } catch (error) {
      setAuthMessage((prev) => ({
        ...prev,
        claude: error instanceof Error ? error.message : t(lang, "app.authRefreshFailed"),
      }));
    } finally {
      setManualTokenSubmitting(false);
    }
  };

  const handleSaveLineCredentials = async () => {
    if (!lineToken.trim()) {
      setLineTokenMessage({ text: t(lang, "line.missing"), isError: true });
      return;
    }

    // The field still holds the placeholder: the stored token is untouched, so
    // there is nothing to send. Saving the placeholder itself would be a no-op
    // in main anyway, but reporting "saved" without a round trip is honest and
    // avoids rewriting a good token.
    if (lineToken === LINE_TOKEN_MASK) {
      setLineTokenMessage({ text: t(lang, "line.saved"), isError: false });
      return;
    }

    setSavingLineToken(true);
    try {
      const next = await window.usagePulse.saveSettings({
        lineChannelAccessToken: lineToken.trim(),
      });
      setSettings(next);
      setLineToken(next.lineChannelAccessToken);
      setShowLineTokenInput(false);
      // A pasted token is easy to get wrong (truncated, wrong field copied);
      // sending a test message immediately tells the user whether it actually
      // works instead of leaving them to remember to press "test" themselves.
      await handleSendLineTest();
    } catch (error) {
      console.error(error);
    } finally {
      setSavingLineToken(false);
    }
  };

  const handleChangeLineToken = () => {
    setLineToken("");
    setLineTokenMessage({ text: "", isError: false });
    setShowLineTokenInput(true);
  };

  const handleSendLineTest = async () => {
    setTestingLineToken(true);
    try {
      const ok = await window.usagePulse.sendLineTest();
      setLineTokenMessage({
        text: t(lang, ok ? "line.testSuccess" : "line.testFail"),
        isError: !ok,
      });
    } catch (error) {
      console.error(error);
      setLineTokenMessage({ text: t(lang, "line.testFail"), isError: true });
    } finally {
      setTestingLineToken(false);
    }
  };

  // Sends the real "final status" bubbles (same ones quit sends) from the
  // already-cached snapshot, so the user can check the actual Cursor/Claude
  // numbers on LINE right now instead of waiting to quit the app.
  const handleSendLineStatus = async () => {
    setSendingLineStatus(true);
    try {
      const ok = await window.usagePulse.sendLineStatus();
      setLineTokenMessage({
        text: t(lang, ok ? "line.statusSuccess" : "line.statusFail"),
        isError: !ok,
      });
    } catch (error) {
      console.error(error);
      setLineTokenMessage({ text: t(lang, "line.statusFail"), isError: true });
    } finally {
      setSendingLineStatus(false);
    }
  };

  const persistWaterSettings = async (patch: Partial<AppSettings>) => {
    const merged = { ...settings, ...patch };
    const waterPatch = {
      enableWaterReminder: merged.enableWaterReminder,
      waterReminderMinutes: roundToStep(merged.waterReminderMinutes, 5, 180, 1, 50),
      waterCupSizeMl: merged.waterCupSizeMl,
    };
    setSettings({ ...merged, ...waterPatch });
    try {
      const next = await window.usagePulse.saveSettings(waterPatch);
      setSettings(next);
      setSessionStats(await window.usagePulse.getSessionStats());
    } catch (error) {
      console.error(error);
    }
  };

  const logWaterCup = async (sizeMl: WaterCupSizeMl) => {
    try {
      setSessionStats(await window.usagePulse.logWaterCup(sizeMl));
    } catch (error) {
      console.error(error);
    }
  };

  const clearSystemClipboard = () => {
    window.usagePulse
      .clearClipboard()
      .catch((error: unknown) => console.error(error));
  };

  // The pasted text is applied by hand instead of letting the browser do it:
  // clearing the system clipboard raced the default paste action, which is why
  // pasting a token used to leave the field empty.
  const handleTokenPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const pasted = event.clipboardData.getData("text").trim();
    if (pasted) {
      setLineToken(pasted);
      setLineTokenMessage({ text: "", isError: false });
    }
    clearSystemClipboard();
  };

  // The field shows the mask, not the token, so every edit is applied to the
  // real value held in state rather than to what is on screen.
  const handleTokenKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Let the shortcuts through: cmd+V arrives as a paste event, and cmd+A has
    // to reach the field so "select all, then retype" can clear a long token —
    // backspacing a 170-character token one asterisk at a time is no way out.
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    const field = event.currentTarget;
    const wholeMaskSelected =
      field.selectionStart === 0 &&
      field.selectionEnd === field.value.length &&
      field.value.length > 0;

    // Editing a field that is only showing the placeholder starts a new token:
    // there is no real value in state to append to or trim from.
    const startsFresh = wholeMaskSelected || lineToken === LINE_TOKEN_MASK;

    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      setLineToken((prev) => (startsFresh ? "" : prev.slice(0, -1)));
      setLineTokenMessage({ text: "", isError: false });
      return;
    }
    if (event.key.length === 1) {
      event.preventDefault();
      setLineToken((prev) => (startsFresh ? event.key : prev + event.key));
      setLineTokenMessage({ text: "", isError: false });
    }
  };

  // settings:get hands back a placeholder for the fallback token, never the
  // token itself, so all the UI can know is whether one is stored. There is
  // deliberately no manual "clear" action here: a fallback token this stale
  // is dropped automatically by the main process the moment a real quota
  // fetch proves it dead (see monitor-engine's applyScrapeResult), so a
  // button that races the same decision would only invite clearing a token
  // that's actually still fine.
  const hasFallbackToken = Boolean(settings.claudeManualOAuthToken);

  // Same placeholder contract as hasFallbackToken above: settings:get never
  // hands back the real LINE token, only whether one is stored.
  const hasLineToken = Boolean(settings.lineChannelAccessToken);

  const quitApp = async () => {
    try {
      await window.usagePulse.quitApp();
    } catch (error) {
      console.error(error);
    }
  };

  const openSupportLink = async (url: string) => {
    try {
      await window.usagePulse.openExternal(url);
    } catch {
      // best-effort: opening the support link failing is not worth surfacing.
    }
  };

  // Bar colour identifies the service, never the quota level — Cursor is always
  // green and Claude Code always blue. Low quota is signalled by the status tag
  // in the card header instead.
  const barClass = (service: ServiceType): string =>
    service === "cursor"
      ? "progress-fill progress-fill-cursor"
      : "progress-fill";

  // Lives inside each quota card rather than in a section of its own: a card
  // showing "no data" is almost always explained by the credential right above
  // it, and the re-detect button here only ever touches this one service.
  const renderCredentialRow = (service: ServiceType, errorCode?: ErrorCode) => {
    const credential = authStatus[service];
    const message = authMessage[service];

    // Claude: the button always stays — it's also the "manually refresh
    // usage now" entry point, still useful when the credential is healthy.
    // Only relabel/restyle it toward "needs a fresh login" when the
    // credential is either confirmed missing, or the last usage fetch came
    // back with a real 401 (claudeLoginExpired). Everything else (429,
    // network hiccups, ...) keeps the quiet "refresh" presentation.
    const needsFreshLogin =
      service === "claude" &&
      (credential.state === "missing" || errorCode === "claudeLoginExpired");

    // Cursor: its expiresAt is a real JWT expiry, so `state` alone reliably
    // says whether the credential is actually broken. The button's only job
    // is fixing a broken credential, so it stays hidden entirely otherwise.
    const cursorCredentialBroken =
      service === "cursor" &&
      (credential.state === "expired" || credential.state === "missing" || credential.state === "error");
    const showButton = service === "claude" || cursorCredentialBroken;
    const needsAttention = needsFreshLogin || cursorCredentialBroken;

    return (
      <div className="credential-row">
        <div className="quota-header">
          <span
            className={`status-tag ${credentialTagClass(credential.state)}`}
          >
            {t(lang, credentialStateKeys[credential.state])}
          </span>
          {service === "claude" && claudeReadyToApply ? (
            <button
              type="button"
              className="primary-btn"
              style={{ width: "auto" }}
              onClick={applyClaudeUpdate}
              disabled={checkingAuth.claude}
            >
              {checkingAuth.claude ? t(lang, "button.detecting") : t(lang, "button.updateUi")}
            </button>
          ) : showButton ? (
            <button
              type="button"
              className={needsAttention ? "warning-btn" : "ghost-btn"}
              style={{ width: "auto" }}
              onClick={() => refreshAuthStatus(service)}
              disabled={checkingAuth[service]}
              title={
                needsAttention
                  ? t(lang, "button.redetect.tooltip")
                  : t(lang, "button.refreshQuota.tooltip")
              }
            >
              {checkingAuth[service]
                ? t(lang, "button.detecting")
                : needsAttention
                  ? t(lang, "button.redetect")
                  : t(lang, "button.refreshQuota")}
            </button>
          ) : null}
        </div>
        <p className="meta-text" style={{ margin: "6px 0 0" }}>
          {credential.checkedAt
            ? t(lang, "auth.lastChecked", {
                time: new Date(credential.checkedAt).toLocaleString(
                  localeForLanguage(lang),
                ),
              })
            : t(lang, "auth.lastCheckedNever")}
        </p>
        {credential.expiresAt ? (
          <p className="meta-text" style={{ margin: "2px 0 0" }}>
            {t(lang, "auth.expiresAt", {
              time: new Date(credential.expiresAt).toLocaleString(
                localeForLanguage(lang),
              ),
            })}
          </p>
        ) : null}
        {credential.state === "missing" || credential.state === "error" ? (
          <p className="meta-text" style={{ margin: "2px 0 0" }}>
            {t(lang, authHintKeys[service])}
          </p>
        ) : null}
        {credential.message ? (
          <p className="meta-text" style={{ margin: "2px 0 0" }}>
            {credential.message}
          </p>
        ) : null}
        {message ? (
          <p className="meta-text" style={{ margin: "2px 0 0" }}>
            {message}
          </p>
        ) : null}
        {service === "claude" ? renderFallbackCredentialRow() : null}
        {service === "claude" && claudeNeedsManualFallback ? renderManualTokenFallback() : null}
      </div>
    );
  };

  // Claude Code only. Read-only: notes whether the token the re-detect flow
  // captured is still the one in use. No manual clear action — the main
  // process drops it on its own once a real quota fetch confirms it's dead.
  const renderFallbackCredentialRow = () =>
    hasFallbackToken ? (
      <div className="quota-header" style={{ marginTop: "8px", gap: "8px" }}>
        <span className="meta-text" style={{ margin: 0 }}>
          {t(lang, "credential.usingFallbackToken")}
        </span>
      </div>
    ) : null;

  // Claude Code only, shown once "Get Credentials" opens a fresh claude-login
  // window. Not masked: the claude-login PTY may have already auto-filled a
  // captured token here, and the user needs to actually see it to confirm
  // it's right before submitting, not stare at asterisks.
  const renderManualTokenFallback = () => (
    <div className="callout-warning" style={{ marginTop: "8px" }}>
      <p style={{ margin: 0 }}>{t(lang, "manualToken.prompt")}</p>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          marginTop: "8px",
        }}
      >
        <code>claude setup-token</code>
        <button
          type="button"
          className="warning-btn"
          style={{ width: "auto" }}
          onClick={copyManualSetupCommand}
        >
          {manualTokenCopied ? t(lang, "manualToken.copied") : t(lang, "manualToken.copyCommand")}
        </button>
      </div>
      <label className="field" style={{ marginTop: "8px", marginBottom: 0 }}>
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder={t(lang, "manualToken.inputPlaceholder")}
          value={manualTokenInput}
          onChange={handleManualTokenChange}
          onPaste={handleManualTokenPaste}
        />
      </label>
      <button
        type="button"
        className="warning-btn"
        style={{ width: "auto", marginTop: "8px" }}
        onClick={submitManualToken}
        disabled={manualTokenSubmitting || !manualTokenInput.trim()}
      >
        {manualTokenSubmitting ? t(lang, "button.detecting") : t(lang, "manualToken.submit")}
      </button>
    </div>
  );

  const renderUsagePercentBar = (window: QuotaWindow, service: ServiceType) => (
    <div className="window-bar" key={window.key}>
      <div className="quota-header" style={{ marginBottom: "6px" }}>
        <span className="window-bar-label">{window.label}</span>
        <span className="meta-text" style={{ margin: 0 }}>
          {t(lang, "window.usagePercent", {
            percent: Math.round(Math.max(0, Math.min(100, window.percent ?? 0))),
          })}
        </span>
      </div>
      <div className="progress-track">
        <div
          className={barClass(service)}
          style={{
            width: `${Math.max(0, Math.min(100, window.percent ?? 0))}%`,
          }}
        />
      </div>
      {window.message && (
        <p className="meta-text" style={{ margin: "6px 0 0" }}>
          {window.message}
        </p>
      )}
    </div>
  );

  // Claude Code windows store `percent`/`remaining` as remaining%, but the bar
  // should read as usage (how much has been consumed), so both are inverted here.
  const renderWindowBar = (
    window: QuotaWindow,
    unit: QuotaSnapshot["unit"],
    service: ServiceType,
    showCountdownCaption = true,
  ) => {
    const used =
      window.remaining !== null && window.total !== null
        ? window.total - window.remaining
        : null;
    const usedPercent =
      window.percent === null
        ? 0
        : Math.max(0, Math.min(100, 100 - window.percent));

    return (
      <div className="window-bar" key={window.key}>
        <div className="quota-header" style={{ marginBottom: "6px" }}>
          <span className="window-bar-label">{window.label}</span>
          <span className="meta-text" style={{ margin: 0 }}>
            {t(lang, "quota.used")} {formatValue(used, unit)} /{" "}
            {formatValue(window.total, unit)}
          </span>
        </div>
        <div className="progress-track">
          <div
            className={barClass(service)}
            style={{ width: `${usedPercent}%` }}
          />
        </div>
        {showCountdownCaption && window.resetsAt && (
          <p
            className="meta-text"
            style={{ margin: "6px 0 0", color: "#8b949e", fontSize: "12px" }}
          >
            {t(lang, "app.liveCountdown", {
              countdown: formatCountdown(window.resetsAt, now, lang),
              resetTime: formatResetText(window.resetsAt, lang),
            })}
          </p>
        )}
      </div>
    );
  };

  // A real ticking countdown to the 5-hour session reset — distinct from the
  // usage bar above it, this one fills as time elapses through the fixed
  // 5-hour window rather than as quota is consumed.
  const renderSessionCountdownBar = (resetsAt: string) => {
    const msRemaining = Date.parse(resetsAt) - now;
    const elapsedPercent = Number.isNaN(msRemaining)
      ? 0
      : Math.max(
          0,
          Math.min(100, 100 - (msRemaining / SESSION_WINDOW_MS) * 100),
        );

    return (
      <div className="window-bar" key="claude-session-countdown">
        <div className="quota-header" style={{ marginBottom: "6px" }}>
          <span className="window-bar-label">
            {t(lang, "window.label.claudeCountdown")}
          </span>
          <span className="meta-text" style={{ margin: 0 }}>
            {formatCountdown(resetsAt, now, lang)}
          </span>
        </div>
        <div className="progress-track">
          <div
            className={barClass("claude")}
            style={{ width: `${elapsedPercent}%` }}
          />
        </div>
        <p
          className="meta-text"
          style={{ margin: "6px 0 0", color: "#8b949e", fontSize: "12px" }}
        >
          {t(lang, "window.claudeCountdown.resetAt", {
            resetTime: formatResetText(resetsAt, lang),
          })}
        </p>
      </div>
    );
  };

  const changeLanguage = async (nextLang: Language) => {
    if (nextLang === lang) {
      return;
    }
    setSettings((prev) => ({ ...prev, language: nextLang }));
    try {
      const next = await window.usagePulse.saveSettings(
        clampSettings({ ...settings, language: nextLang }),
      );
      setSettings(next);
    } catch (error) {
      console.error(error);
    }
  };

  // Lives on the quota card itself (not the batched Settings panel below), so
  // it takes effect immediately rather than waiting on the "save settings"
  // button — same immediacy as changeLanguage above.
  const setMonitoringEnabled = async (service: ServiceType, enabled: boolean) => {
    const key: "enableCursorMonitoring" | "enableClaudeMonitoring" =
      service === "cursor" ? "enableCursorMonitoring" : "enableClaudeMonitoring";
    setSettings((prev) => ({ ...prev, [key]: enabled }));
    try {
      const next = await window.usagePulse.saveSettings({ [key]: enabled });
      setSettings(next);
    } catch (error) {
      console.error(error);
    }
  };

  // One threshold slider + notify toggle per independent low-quota alert —
  // Cursor has two (advanced models, cursor models), Claude Code has two of
  // these plus a third toggle-only cooldown alert (see renderToggleOnlyRow).
  const renderLowQuotaRow = (
    labelKey: TranslationKey,
    thresholdKey: LowQuotaThresholdKey,
    toggleKey: LowQuotaToggleKey,
  ) => (
    <div className="alarm-suboption" key={thresholdKey}>
      <p className="subsection-title">{t(lang, labelKey)}</p>
      <label className="field">
        <span>
          {t(lang, "settings.lowThreshold", {
            percent: settings[thresholdKey],
          })}
        </span>
        <input
          type="range"
          min={5}
          max={30}
          step={5}
          value={settings[thresholdKey]}
          onChange={(event) =>
            setSettings((prev) => ({
              ...prev,
              [thresholdKey]: Number(event.target.value) || prev[thresholdKey],
            }))
          }
        />
      </label>
      <label className="field switch-row" style={{ marginBottom: 0 }}>
        <span>{t(lang, "settings.lowQuota.toggleLabel")}</span>
        <input
          type="checkbox"
          className="toggle"
          checked={settings[toggleKey]}
          onChange={(event) =>
            setSettings((prev) => ({
              ...prev,
              [toggleKey]: event.target.checked,
            }))
          }
        />
      </label>
    </div>
  );

  const renderToggleOnlyRow = (
    labelKey: TranslationKey,
    toggleKey: "enableClaudeCooldownAlert",
  ) => (
    <label
      className="field switch-row"
      key={toggleKey}
      style={{ marginTop: "10px" }}
    >
      <span>{t(lang, labelKey)}</span>
      <input
        type="checkbox"
        className="toggle"
        checked={settings[toggleKey]}
        onChange={(event) =>
          setSettings((prev) => ({
            ...prev,
            [toggleKey]: event.target.checked,
          }))
        }
      />
    </label>
  );

  return (
    <main className="app">
      <section className="panel">
        <div className="app-title-row">
          <img src={appLogo} alt="" className="app-logo" />
          <div className="app-title-text">
            <div className="quota-header">
              <h1>Usage-Pulse</h1>
              <select
                className="lang-toggle"
                value={lang}
                title={t(lang, "settings.language")}
                aria-label={t(lang, "settings.language")}
                onChange={(event) =>
                  changeLanguage(event.target.value as Language)
                }
              >
                {LANGUAGE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="subtitle">{t(lang, "app.subtitle")}</p>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="quota-header">
          <h2>{t(lang, "section.realtimeQuota")}</h2>
        </div>
        <div className="quota-grid">
          {(["claude", "cursor"] as ServiceType[]).map((service) => {
            const item = snapshot?.[service];

            if (service === "claude") {
              const windows = item?.windows ?? [];
              const sessionWindow =
                windows.find((window) => window.key === "session") ?? null;
              const weeklyWindow =
                windows.find((window) => window.key === "weekly_all") ??
                windows.find((window) => window.key === "weekly_scoped") ??
                windows.find((window) => window.key === "weekly") ??
                null;
              const barWindows = [sessionWindow, weeklyWindow].filter(
                (window): window is QuotaWindow => window !== null,
              );

              return (
                <div className="quota-card quota-card-claude" key={service}>
                  <div className="quota-header">
                    <label className="field switch-row" style={{ margin: 0 }}>
                      <span>{t(lang, "monitor.enableClaude")}</span>
                      <input
                        type="checkbox"
                        className="toggle"
                        checked={settings.enableClaudeMonitoring}
                        onChange={(event) =>
                          setMonitoringEnabled("claude", event.target.checked)
                        }
                      />
                    </label>
                  </div>
                  {!settings.enableClaudeMonitoring ? (
                    <p className="meta-text" style={{ marginTop: "8px" }}>
                      {t(lang, "monitor.disabledHint")}
                    </p>
                  ) : (
                    <>
                  <div className="quota-header">
                    <strong>{serviceNames[service]}</strong>
                    <span
                      className={`status-tag status-${item?.status || "unknown"}`}
                    >
                      {item?.status || "unknown"}
                    </span>
                  </div>
                  {renderCredentialRow(service, item?.errorCode)}
                  {barWindows.length ? (
                    <div className="window-bars">
                      {sessionWindow &&
                        renderWindowBar(
                          sessionWindow,
                          item!.unit,
                          service,
                          false,
                        )}
                      {sessionWindow?.resetsAt &&
                        renderSessionCountdownBar(sessionWindow.resetsAt)}
                      {weeklyWindow &&
                        renderWindowBar(weeklyWindow, item!.unit, service)}
                      {claudeBillingAt ? (
                        <p className="meta-text" style={{ marginTop: "8px" }}>
                          {t(lang, "window.claudeBilling.renewsAt", {
                            resetTime: formatResetText(claudeBillingAt, lang),
                          })}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="meta-text" style={{ marginTop: "8px" }}>
                      {item?.message || t(lang, "app.notFetchedYet")}
                    </p>
                  )}
                    </>
                  )}
                </div>
              );
            }

            const allWindows = item?.windows ?? [];
            const billingWindow =
              allWindows.find((window) => window.key === "billing_cycle") ??
              null;
            const cursorModelsWindow =
              allWindows.find((window) => window.key === "cursor_models") ??
              null;
            const billingUsed =
              billingWindow &&
              billingWindow.remaining !== null &&
              billingWindow.total !== null
                ? billingWindow.total - billingWindow.remaining
                : null;
            const billingUsedPercent =
              billingWindow?.percent !== null &&
              billingWindow?.percent !== undefined
                ? 100 - billingWindow.percent
                : 0;
            return (
              <div className="quota-card quota-card-cursor" key={service}>
                <div className="quota-header">
                  <label className="field switch-row" style={{ margin: 0 }}>
                    <span>{t(lang, "monitor.enableCursor")}</span>
                    <input
                      type="checkbox"
                      className="toggle"
                      checked={settings.enableCursorMonitoring}
                      onChange={(event) =>
                        setMonitoringEnabled("cursor", event.target.checked)
                      }
                    />
                  </label>
                </div>
                {!settings.enableCursorMonitoring ? (
                  <p className="meta-text" style={{ marginTop: "8px" }}>
                    {t(lang, "monitor.disabledHint")}
                  </p>
                ) : (
                  <>
                <div className="quota-header">
                  <strong>{serviceNames[service]}</strong>
                  <span
                    className={`status-tag status-${item?.status || "unknown"}`}
                  >
                    {item?.status || "unknown"}
                  </span>
                </div>
                {renderCredentialRow(service)}
                {cursorModelsWindow ? (
                  <div className="window-bars" style={{ marginBottom: "12px" }}>
                    {renderUsagePercentBar(cursorModelsWindow, service)}
                  </div>
                ) : null}
                {billingWindow ? (
                  <div className="window-bar" key={`${service}-billing`}>
                    <div
                      className="quota-header"
                      style={{ marginBottom: "6px" }}
                    >
                      <span className="window-bar-label">
                        {billingWindow.label}
                      </span>
                      <span className="meta-text" style={{ margin: 0 }}>
                        {t(lang, "quota.used")}{" "}
                        {formatValue(billingUsed, item!.unit)} /{" "}
                        {formatValue(billingWindow.total, item!.unit)}
                      </span>
                    </div>
                    <div className="progress-track">
                      <div
                        className={barClass(service)}
                        style={{
                          width: `${Math.max(0, Math.min(100, billingUsedPercent))}%`,
                        }}
                      />
                    </div>
                    {billingWindow.resetsAt && (
                      <p
                        className="meta-text"
                        style={{
                          margin: "10px 0 0",
                          color: "#8b949e",
                          fontSize: "12px",
                        }}
                      >
                        {t(lang, "app.liveCountdown", {
                          countdown: formatCountdown(
                            billingWindow.resetsAt,
                            now,
                            lang,
                          ),
                          resetTime: formatResetText(
                            billingWindow.resetsAt,
                            lang,
                          ),
                        })}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="meta-text" style={{ marginTop: "8px" }}>
                    {item?.message || t(lang, "app.notFetchedYet")}
                  </p>
                )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <h2>{t(lang, "section.settings")}</h2>

        <div className="field">
          <label className="field switch-row" style={{ marginBottom: 0 }}>
            <span>{t(lang, "settings.launchWithIde")}</span>
            <input
              type="checkbox"
              className="toggle"
              checked={settings.launchWithIde}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  launchWithIde: event.target.checked,
                  launchAtStartup: event.target.checked
                    ? false
                    : prev.launchAtStartup,
                }))
              }
            />
          </label>
          <p className="meta-text" style={{ margin: 0 }}>
            {t(lang, "settings.launchWithIde.hint")}
          </p>
        </div>

        <div className="field">
          <label className="field switch-row" style={{ marginBottom: 0 }}>
            <span>{t(lang, "settings.launchAtStartup")}</span>
            <input
              type="checkbox"
              className="toggle"
              checked={settings.launchAtStartup}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  launchAtStartup: event.target.checked,
                  launchWithIde: event.target.checked
                    ? false
                    : prev.launchWithIde,
                }))
              }
            />
          </label>
          <p className="meta-text" style={{ margin: 0 }}>
            {t(lang, "settings.launchAtStartup.hint")}
          </p>
        </div>

        <label className="field">
          <span>{t(lang, "settings.trayValueColor")}</span>
          <select
            value={settings.trayValueColorMode}
            onChange={(event) =>
              setSettings((prev) => ({
                ...prev,
                trayValueColorMode: event.target.value as TrayValueColorMode,
              }))
            }
          >
            <option value="system">
              {t(lang, "settings.trayValueColor.system")}
            </option>
            <option value="white">
              {t(lang, "settings.trayValueColor.white")}
            </option>
            <option value="black">
              {t(lang, "settings.trayValueColor.black")}
            </option>
          </select>
        </label>

        {settings.enableCursorMonitoring && (
        <div className="quota-card service-block service-block-cursor">
          <div className="quota-header">
            <strong>{serviceNames.cursor}</strong>
          </div>

          {renderLowQuotaRow(
            "alertLabel.cursorAdvancedModels",
            "cursorAdvancedModelsLowThresholdPercent",
            "enableCursorAdvancedModelsLowAlert",
          )}
          {renderLowQuotaRow(
            "alertLabel.cursorModels",
            "cursorModelsLowThresholdPercent",
            "enableCursorModelsLowAlert",
          )}

          <label className="field switch-row" style={{ marginTop: "10px" }}>
            <span>{t(lang, "alarm.when.cursor")}</span>
            <input
              type="checkbox"
              className="toggle"
              checked={settings.enableCursorResetAlarm}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  enableCursorResetAlarm: event.target.checked,
                }))
              }
            />
          </label>
          {settings.enableCursorResetAlarm && snapshot?.cursor.resetsAt && (
            <p
              className="meta-text"
              style={{ margin: "2px 0 0", color: "#8b949e", fontSize: "12px" }}
            >
              {t(lang, "settings.resetAlarm.nextFire", {
                countdown: formatCountdown(snapshot.cursor.resetsAt, now, lang),
                resetTime: formatResetText(snapshot.cursor.resetsAt, lang),
              })}
            </p>
          )}
        </div>
        )}

        {settings.enableClaudeMonitoring && (
        <div className="quota-card service-block service-block-claude">
          <div className="quota-header">
            <strong>{serviceNames.claude}</strong>
          </div>

          {renderLowQuotaRow(
            "alertLabel.claudeSession",
            "claudeSessionLowThresholdPercent",
            "enableClaudeSessionLowAlert",
          )}
          {renderLowQuotaRow(
            "alertLabel.claudeWeekly",
            "claudeWeeklyLowThresholdPercent",
            "enableClaudeWeeklyLowAlert",
          )}
          {renderToggleOnlyRow(
            "alertLabel.claudeCooldown",
            "enableClaudeCooldownAlert",
          )}

          <label className="field switch-row" style={{ marginTop: "10px" }}>
            <span>{t(lang, "settings.claudeActivityPolling")}</span>
            <input
              type="checkbox"
              className="toggle"
              checked={settings.claudeUseCliActivityPolling}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  claudeUseCliActivityPolling: event.target.checked,
                }))
              }
            />
          </label>

          <label className="field switch-row" style={{ marginTop: "10px" }}>
            <span>{t(lang, "alarm.when.claudeSession")}</span>
            <input
              type="checkbox"
              className="toggle"
              checked={settings.enableClaudeResetAlarm}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  enableClaudeResetAlarm: event.target.checked,
                }))
              }
            />
          </label>
          {settings.enableClaudeResetAlarm && snapshot?.claude.resetsAt && (
            <p
              className="meta-text"
              style={{ margin: "2px 0 0", color: "#8b949e", fontSize: "12px" }}
            >
              {t(lang, "settings.resetAlarm.nextFire", {
                countdown: formatCountdown(snapshot.claude.resetsAt, now, lang),
                resetTime: formatResetText(snapshot.claude.resetsAt, lang),
              })}
            </p>
          )}

          <label className="field switch-row" style={{ marginTop: "10px" }}>
            <span>{t(lang, "alarm.when.claudeWeekly")}</span>
            <input
              type="checkbox"
              className="toggle"
              checked={settings.enableClaudeWeeklyResetAlarm}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  enableClaudeWeeklyResetAlarm: event.target.checked,
                }))
              }
            />
          </label>
          {settings.enableClaudeWeeklyResetAlarm &&
            snapshot?.claude.weeklyResetAt && (
              <p
                className="meta-text"
                style={{
                  margin: "2px 0 0",
                  color: "#8b949e",
                  fontSize: "12px",
                }}
              >
                {t(lang, "settings.resetAlarm.nextFire", {
                  countdown: formatCountdown(
                    snapshot.claude.weeklyResetAt,
                    now,
                    lang,
                  ),
                  resetTime: formatResetText(
                    snapshot.claude.weeklyResetAt,
                    lang,
                  ),
                })}
              </p>
            )}

          <label className="field switch-row" style={{ marginTop: "10px" }}>
            <span>{t(lang, "alarm.when.claudeBilling")}</span>
            <input
              type="checkbox"
              className="toggle"
              checked={settings.enableClaudeBillingAlarm}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  enableClaudeBillingAlarm: event.target.checked,
                }))
              }
            />
          </label>
          <label className="field" style={{ margin: "6px 0 0" }}>
            <span>{t(lang, "settings.claudeBilling.cadence")}</span>
            <select
              value={settings.claudeBillingCadence}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  claudeBillingCadence: event.target.value as ClaudeBillingCadence,
                }))
              }
            >
              <option value="monthly">
                {t(lang, "settings.claudeBilling.monthly")}
              </option>
              <option value="annual">
                {t(lang, "settings.claudeBilling.annual")}
              </option>
            </select>
          </label>
          {settings.enableClaudeBillingAlarm && claudeBillingAt && (
            <p
              className="meta-text"
              style={{
                margin: "2px 0 0",
                color: "#8b949e",
                fontSize: "12px",
              }}
            >
              {t(lang, "settings.resetAlarm.nextFire", {
                countdown: formatCountdown(claudeBillingAt, now, lang),
                resetTime: formatResetText(claudeBillingAt, lang),
              })}
            </p>
          )}
        </div>
        )}

        <div className="quota-card service-block" style={{ marginTop: "12px" }}>
          <p className="meta-text">
            {alarmStatus?.nextTarget
              ? t(lang, "alarm.nextFire", {
                  countdown: formatCountdown(
                    alarmStatus.nextTarget.fireAt,
                    now,
                    lang,
                  ),
                  resetTime: formatResetText(
                    alarmStatus.nextTarget.fireAt,
                    lang,
                  ),
                })
              : t(lang, "alarm.noTarget")}
          </p>

          <p className="subsection-title">{t(lang, "alarm.how.title")}</p>

          <label className="field switch-row">
            <span>{t(lang, "alarm.popupToggle")}</span>
            <input
              type="checkbox"
              className="toggle"
              checked={settings.enableAlarmPopup}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  enableAlarmPopup: event.target.checked,
                }))
              }
            />
          </label>
          {settings.enableAlarmPopup ? (
            <p className="meta-text" style={{ margin: "0 0 8px" }}>
              {t(lang, "alarm.autoDismiss", {
                minutes: ALARM_POPUP_AUTO_DISMISS_MINUTES,
              })}
            </p>
          ) : null}

          <label className="field switch-row">
            <span>{t(lang, "alarm.lineToggle")}</span>
            <input
              type="checkbox"
              className="toggle toggle-line"
              checked={settings.enableLineNotification}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  enableLineNotification: event.target.checked,
                }))
              }
            />
          </label>
          {settings.enableLineNotification && !lineToken.trim() ? (
            <p className="meta-text" style={{ margin: "0 0 8px" }}>
              {t(lang, "alarm.lineNeedToken")}
            </p>
          ) : null}

          <div className="alarm-actions-row" style={{ marginTop: "12px" }}>
            <button
              type="button"
              className="warning-btn"
              onClick={refreshAlarmStatus}
              disabled={checkingAlarm}
            >
              {checkingAlarm
                ? t(lang, "alarm.checking")
                : t(lang, "alarm.check")}
            </button>
            <button
              type="button"
              className="warning-btn"
              onClick={testAlarmPopup}
            >
              {t(lang, "alarm.testRing")}
            </button>
          </div>
          {alarmMessage ? <p className="meta-text">{alarmMessage}</p> : null}
        </div>

        <button
          className="primary-btn"
          style={{ marginTop: "16px" }}
          onClick={handleSaveSettings}
          disabled={savingSettings}
        >
          {savingSettings
            ? t(lang, "button.saving")
            : t(lang, "button.saveSettings")}
        </button>
      </section>

      <section className="panel panel-water">
        <h2>{t(lang, "water.title")}</h2>
        <p className="meta-text" style={{ marginBottom: "10px" }}>
          {t(lang, "water.desc")}
        </p>

        <label className="field switch-row">
          <span>{t(lang, "water.enable")}</span>
          <input
            type="checkbox"
            className="toggle toggle-water"
            checked={settings.enableWaterReminder}
            onChange={(event) =>
              void persistWaterSettings({ enableWaterReminder: event.target.checked })
            }
          />
        </label>

        <label className="field">
          <span>{t(lang, "water.interval")}</span>
          <input
            type="number"
            min={5}
            max={180}
            step={1}
            value={settings.waterReminderMinutes}
            disabled={!settings.enableWaterReminder}
            onChange={(event) =>
              setSettings((prev) => ({
                ...prev,
                waterReminderMinutes: Number(event.target.value),
              }))
            }
            onBlur={() =>
              void persistWaterSettings({
                waterReminderMinutes: roundToStep(
                  settings.waterReminderMinutes,
                  5,
                  180,
                  1,
                  50,
                ),
              })
            }
          />
        </label>

        <div className="field">
          <span>{t(lang, "water.cupSize")}</span>
          <div className="water-cup-row">
            {WATER_CUP_SIZES_ML.map((size) => (
              <button
                key={size}
                type="button"
                className={
                  settings.waterCupSizeMl === size ? "primary-btn" : "ghost-btn"
                }
                onClick={() => void persistWaterSettings({ waterCupSizeMl: size })}
              >
                {t(lang, size === 250 ? "water.cup.250" : size === 500 ? "water.cup.500" : "water.cup.1000")}
              </button>
            ))}
          </div>
        </div>

        <p className="meta-text">
          {t(lang, "water.sessionTotal", {
            ml: sessionStats?.waterMl ?? 0,
            cups: sessionStats?.waterCups ?? 0,
          })}
        </p>
        <p className="meta-text">
          {settings.enableWaterReminder && sessionStats?.nextWaterAt
            ? t(lang, "water.nextAt", {
                countdown: formatCountdown(sessionStats.nextWaterAt, now, lang),
              })
            : t(lang, "water.nextAtNone")}
        </p>

        <button
          type="button"
          className="primary-btn"
          onClick={() => void logWaterCup(settings.waterCupSizeMl)}
        >
          {t(lang, "water.logCup")}
        </button>
      </section>

      <section className="panel panel-line">
        <h2>{t(lang, "line.title")}</h2>
        <p className="meta-text" style={{ marginBottom: "10px" }}>
          {t(lang, "line.desc")}
        </p>

        {!settings.enableLineNotification ? (
          <p className="meta-text">{t(lang, "line.notInUseHint")}</p>
        ) : hasLineToken && !showLineTokenInput ? (
          <>
            <div className="quota-header" style={{ gap: "8px" }}>
              <span className="meta-text" style={{ margin: 0 }}>
                {t(lang, "line.tokenInUse")}
              </span>
              <button
                type="button"
                className="ghost-btn"
                style={{ width: "auto" }}
                onClick={handleSendLineStatus}
                disabled={sendingLineStatus}
              >
                {sendingLineStatus
                  ? t(lang, "line.sendStatusSending")
                  : t(lang, "line.sendStatus")}
              </button>
              <button
                type="button"
                className="warning-btn"
                style={{ width: "auto" }}
                onClick={handleChangeLineToken}
              >
                {t(lang, "line.changeToken")}
              </button>
            </div>
            {lineTokenMessage.text ? (
              <p
                className={
                  lineTokenMessage.isError ? "form-error" : "meta-text"
                }
                style={{ margin: "6px 0 0" }}
              >
                {lineTokenMessage.text}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <div className="callout-warning">
              ⚠️ {t(lang, "line.clipboardWarning")}
            </div>
            <p className="meta-text" style={{ margin: "8px 0 12px" }}>
              {t(lang, "line.pasteHint")}
            </p>

            {secretStorageOk ? null : (
              <div className="callout-warning">
                ⚠️ {t(lang, "settings.insecureStorage")}
              </div>
            )}

            <label className="field">
              <span>{t(lang, "line.tokenLabel")}</span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={t(lang, "line.tokenPlaceholder")}
                value={maskToken(lineToken)}
                onPaste={handleTokenPaste}
                onKeyDown={handleTokenKeyDown}
                // Controlled by the mask: every mutation goes through the paste
                // and key handlers above, so there is nothing for onChange to
                // apply.
                onChange={() => undefined}
              />
            </label>

            <div className="alarm-actions-row">
              <button
                className="primary-btn primary-btn-line"
                onClick={handleSaveLineCredentials}
                disabled={savingLineToken}
              >
                {savingLineToken
                  ? t(lang, "button.saving")
                  : t(lang, "line.save")}
              </button>
              <button
                className="ghost-btn"
                onClick={handleSendLineTest}
                disabled={testingLineToken || !settings.lineChannelAccessToken}
              >
                {testingLineToken
                  ? t(lang, "line.testSending")
                  : t(lang, "line.test")}
              </button>
              {hasLineToken ? (
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => setShowLineTokenInput(false)}
                >
                  {t(lang, "button.cancel")}
                </button>
              ) : null}
            </div>
            {lineTokenMessage.text ? (
              <p
                className={
                  lineTokenMessage.isError ? "form-error" : "meta-text"
                }
              >
                {lineTokenMessage.text}
              </p>
            ) : null}
          </>
        )}
      </section>

      <section className="panel">
        <button className="danger-btn" onClick={quitApp}>
          {t(lang, "button.quit")}
        </button>
      </section>

      <footer className="panel footer">
        <div className="footer-credits">
          <p className="footer-credit">
            {t(lang, "footer.support")}{" "}
            {lang === "zh" ? (
              <>
                <a
                  href={THREADS_URL}
                  className="footer-link"
                  onClick={(event) => {
                    event.preventDefault();
                    openSupportLink(THREADS_URL);
                  }}
                >
                  Threads
                </a>
                {" / "}
                <a
                  href={LINE_URL}
                  className="footer-link footer-link-line"
                  onClick={(event) => {
                    event.preventDefault();
                    openSupportLink(LINE_URL);
                  }}
                >
                  Line
                </a>
              </>
            ) : (
              <>
                <a
                  href={INSTAGRAM_URL}
                  className="footer-link"
                  onClick={(event) => {
                    event.preventDefault();
                    openSupportLink(INSTAGRAM_URL);
                  }}
                >
                  Instagram
                </a>
                {" / "}
                <a
                  href={WHATSAPP_URL}
                  className="footer-link"
                  onClick={(event) => {
                    event.preventDefault();
                    openSupportLink(WHATSAPP_URL);
                  }}
                >
                  WhatsApp
                </a>
              </>
            )}
          </p>
          <p className="footer-credit">
            {t(lang, "footer.developer")}{" "}
            <a
              href={LINKEDIN_URL}
              className="footer-link"
              onClick={(event) => {
                event.preventDefault();
                openSupportLink(LINKEDIN_URL);
              }}
            >
              LinkedIn
            </a>
            {" · "}
            {t(lang, "footer.developerHint")}
          </p>
        </div>
        <p className="footer-license">{t(lang, "footer.license")}</p>
      </footer>
    </main>
  );
};
