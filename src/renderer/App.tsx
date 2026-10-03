import {
  useEffect,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import {
  type AlarmStatusReport,
  type AppSettings,
  type ClaudeBillingCadence,
  type AuthStatus,
  type CombinedSnapshot,
  type CredentialState,
  type CredentialStatus,
  type ErrorCode,
  type HistoryCleanResult,
  type HistoryService,
  type HistoryStats,
  type Language,
  type QuotaSnapshot,
  type QuotaWindow,
  type ServiceType,
  type TrayValueColorMode,
  type UpdateInfo,
} from "@shared/types";
import { CLAUDE_TOKEN_MASK, LINE_TOKEN_MASK } from "@shared/types";
import {
  ALARM_POPUP_AUTO_DISMISS_SECONDS,
  formatCountdown,
} from "@shared/alarm-utils";
import { resolveClaudeBillingAt } from "@shared/claude-billing";
import { classifyHistoryFailure, formatBytes, hasHistoryApi } from "@shared/history";
import { isCodexBackendSlotKey } from "@shared/codex-usage";
import { localeForLanguage, t, type TranslationKey } from "@shared/i18n";
import {
  LINE_SETTING_KEY,
  POPUP_SETTING_KEY,
  isLineInUse,
} from "@shared/notify-channels";
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
  token === LINE_TOKEN_MASK || token === CLAUDE_TOKEN_MASK
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
  enableCodexMonitoring: true,
  cursorAdvancedModelsLowThresholdPercent: 20,
  enableCursorAdvancedModelsLowAlert: true,
  cursorModelsLowThresholdPercent: 20,
  enableCursorModelsLowAlert: true,
  claudeSessionLowThresholdPercent: 20,
  enableClaudeSessionLowAlert: true,
  claudeWeeklyLowThresholdPercent: 20,
  enableClaudeWeeklyLowAlert: true,
  enableClaudeCooldownAlert: true,
  codexSessionLowThresholdPercent: 20,
  enableCodexSessionLowAlert: true,
  codexWeeklyLowThresholdPercent: 20,
  enableCodexWeeklyLowAlert: true,
  enableCodexCooldownAlert: true,
  launchWithIde: false,
  notifyCooldownMinutes: 15,
  enableCursorResetAlarm: true,
  enableClaudeResetAlarm: true,
  enableClaudeWeeklyResetAlarm: true,
  enableClaudeBillingAlarm: true,
  claudeBillingCadence: "monthly",
  enableCodexResetAlarm: true,
  enableCodexWeeklyResetAlarm: true,
  language: "zh",
  trayValueColorMode: "system",
  enableCursorAlarmPopup: true,
  enableClaudeAlarmPopup: true,
  enableCodexAlarmPopup: true,
  enableCursorLineNotification: true,
  enableClaudeLineNotification: true,
  enableCodexLineNotification: true,
  lineChannelAccessToken: "",
  claudeManualToken: "",
  claudeUseCliActivityPolling: true,
  codexUseCliActivityPolling: false,
  autoCheckForUpdates: true,
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
  codex: emptyCredential("codex"),
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

const SCRAPE_FAILURE_CODES: ErrorCode[] = [
  "claudeLoginExpired",
  "claudeScopeInsufficient",
  "claudeRateLimited",
  "codexLoginExpired",
];

const resolveCredentialTag = (
  service: ServiceType,
  credential: CredentialStatus,
  errorCode?: ErrorCode,
): { labelKey: string; tagClass: string } => {
  if (service === "claude" && errorCode === "claudeScopeInsufficient") {
    return { labelKey: "auth.state.scopeInsufficient", tagClass: "status-error" };
  }
  if (service === "claude" && errorCode === "claudeLoginExpired") {
    return { labelKey: "auth.state.expired", tagClass: "status-error" };
  }
  if (service === "codex" && errorCode === "codexLoginExpired") {
    return { labelKey: "auth.state.expired", tagClass: "status-error" };
  }
  return {
    labelKey: credentialStateKeys[credential.state],
    tagClass: credentialTagClass(credential.state),
  };
};

const serviceNames: Record<ServiceType, string> = {
  cursor: "Cursor",
  claude: "Claude Code",
  codex: "Codex",
};

const authHintKeys: Record<ServiceType, "auth.hint.cursor" | "auth.hint.claude" | "auth.hint.codex"> = {
  cursor: "auth.hint.cursor",
  claude: "auth.hint.claude",
  codex: "auth.hint.codex",
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
  | "claudeWeeklyLowThresholdPercent"
  | "codexSessionLowThresholdPercent"
  | "codexWeeklyLowThresholdPercent";

type LowQuotaToggleKey =
  | "enableCursorAdvancedModelsLowAlert"
  | "enableCursorModelsLowAlert"
  | "enableClaudeSessionLowAlert"
  | "enableClaudeWeeklyLowAlert"
  | "enableCodexSessionLowAlert"
  | "enableCodexWeeklyLowAlert";

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
  >({ cursor: false, claude: false, codex: false });
  const [authMessage, setAuthMessage] = useState<Record<ServiceType, string>>({
    cursor: "",
    claude: "",
    codex: "",
  });
  const [claudeLoginCommandCopied, setClaudeLoginCommandCopied] = useState(false);
  const [claudeToken, setClaudeToken] = useState("");
  const [savingClaudeToken, setSavingClaudeToken] = useState(false);
  const [claudeTokenMessage, setClaudeTokenMessage] = useState<{
    text: string;
    isError: boolean;
  }>({
    text: "",
    isError: false,
  });
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
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [updateDownloading, setUpdateDownloading] = useState(false);
  const [updateDownloadPercent, setUpdateDownloadPercent] = useState(0);
  const [updateDownloaded, setUpdateDownloaded] = useState(false);
  const [historyStats, setHistoryStats] = useState<Record<
    HistoryService,
    HistoryStats
  > | null>(null);
  const [historyFailure, setHistoryFailure] = useState<{
    key: TranslationKey;
    detail: string;
  } | null>(null);
  const [historyBusy, setHistoryBusy] = useState<Record<HistoryService, boolean>>({
    claude: false,
    codex: false,
  });
  const [historyMessage, setHistoryMessage] = useState<
    Record<HistoryService, string>
  >({ claude: "", codex: "" });
  const canAutoUpdate = window.usagePulse.platform === "win32";
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
    const [nextSettings, nextAuthStatus, latestSnapshot, nextAlarmStatus] =
      await Promise.all([
        window.usagePulse.getSettings(),
        window.usagePulse.getAuthStatus(),
        window.usagePulse.getLatestSnapshot(),
        window.usagePulse.getAlarmStatus(),
      ]);
    setSettings(nextSettings);
    setAuthStatus(nextAuthStatus);
    setSnapshot(latestSnapshot);
    setAlarmStatus(nextAlarmStatus);
    setLineToken(nextSettings.lineChannelAccessToken);
  };

  useEffect(() => {
    window.usagePulse
      .isSecretStorageAvailable()
      .then(setSecretStorageOk)
      .catch(() => setSecretStorageOk(true));
  }, []);

  // Counted when the window opens and each time it regains focus — not on every
  // quota poll, so the disk is only walked when someone is looking.
  const refreshHistoryStats = async () => {
    try {
      // Checked up front: a long-running dev session keeps the old main and
      // preload while the screen hot-reloads, and says so instead of failing
      // with no explanation.
      if (!hasHistoryApi(window.usagePulse)) {
        throw new Error("history API missing");
      }
      setHistoryStats(await window.usagePulse.getHistoryStats());
      setHistoryFailure(null);
    } catch (error) {
      setHistoryFailure(classifyHistoryFailure(window.usagePulse, error));
    }
  };

  useEffect(() => {
    void refreshHistoryStats();
    const onFocus = () => void refreshHistoryStats();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    refreshBaseData().catch((error) => {
      console.error(error);
    });

    const unsubscribeSnapshot = window.usagePulse.onSnapshotUpdated(
      (nextSnapshot) => {
        setSnapshot(nextSnapshot);
        // main rearms alarms after every poll, so the next-fire target may have moved.
        window.usagePulse
          .getAlarmStatus()
          .then(setAlarmStatus)
          .catch((error) => console.error(error));
      },
    );

    const unsubscribeAuth = window.usagePulse.onAuthUpdated((nextAuth) => {
      setAuthStatus(nextAuth);
    });

    const unsubscribeUpdateAvailable = window.usagePulse.onUpdateAvailable((info) => {
      setUpdateInfo(info);
      setUpdateDismissed(false);
    });
    const unsubscribeUpdateProgress = window.usagePulse.onUpdateDownloadProgress((progress) => {
      setUpdateDownloadPercent(progress.percent);
    });
    const unsubscribeUpdateDownloaded = window.usagePulse.onUpdateDownloaded(() => {
      setUpdateDownloading(false);
      setUpdateDownloaded(true);
    });

    return () => {
      unsubscribeSnapshot();
      unsubscribeAuth();
      unsubscribeUpdateAvailable();
      unsubscribeUpdateProgress();
      unsubscribeUpdateDownloaded();
    };
  }, []);

  const handleUpdateNow = () => {
    setUpdateDownloading(true);
    setUpdateDownloadPercent(0);
    void window.usagePulse.startUpdateDownload().catch((error) => {
      console.error(error);
      setUpdateDownloading(false);
    });
  };

  const handleRestartAndInstall = () => {
    void window.usagePulse.quitAndInstallUpdate();
  };

  const handleUpdateLater = () => {
    setUpdateDismissed(true);
  };

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
  });

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      const next = await window.usagePulse.saveSettings(
        clampSettings(settings),
      );
      setSettings(next);
      setAlarmStatus(await window.usagePulse.getAlarmStatus());
    } catch (error) {
      console.error(error);
    } finally {
      setSavingSettings(false);
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
  // Claude has one action, "Update Values": it hits the usage API and
  // re-reads Keychain. Valid numbers land on screen immediately — there is
  // no extra confirmation click. While the credential is missing, the
  // instructions callout below (driven by credential.state) tells the user
  // to run `claude auth login` in their own terminal — the app never touches
  // the login itself.
  const pullClaudeOntoScreen = async (message: string) => {
    const [nextAuth, latestSnapshot, nextSettings] = await Promise.all([
      window.usagePulse.checkAuth("claude"),
      window.usagePulse.getLatestSnapshot(),
      window.usagePulse.getSettings(),
    ]);
    setAuthStatus((prev) => ({ ...prev, claude: nextAuth }));
    setSnapshot(latestSnapshot);
    setSettings(nextSettings);
    setAuthMessage((prev) => ({ ...prev, claude: message }));
  };

  const refreshClaudeQuota = async () => {
    setCheckingAuth((prev) => ({ ...prev, claude: true }));
    try {
      const result = await window.usagePulse.runManualCheck("claude");
      await pullClaudeOntoScreen(result.message);
    } catch (error) {
      setAuthMessage((prev) => ({
        ...prev,
        claude: error instanceof Error ? error.message : t(lang, "app.authRefreshFailed"),
      }));
    } finally {
      setCheckingAuth((prev) => ({ ...prev, claude: false }));
    }
  };

  const refreshCodexQuota = async () => {
    setCheckingAuth((prev) => ({ ...prev, codex: true }));
    try {
      const result = await window.usagePulse.runManualCheck("codex");
      const [nextAuth, latestSnapshot, nextSettings] = await Promise.all([
        window.usagePulse.checkAuth("codex"),
        window.usagePulse.getLatestSnapshot(),
        window.usagePulse.getSettings(),
      ]);
      setAuthStatus((prev) => ({ ...prev, codex: nextAuth }));
      setSnapshot(latestSnapshot);
      setSettings(nextSettings);
      setAuthMessage((prev) => ({ ...prev, codex: result.message }));
    } catch (error) {
      setAuthMessage((prev) => ({
        ...prev,
        codex: error instanceof Error ? error.message : t(lang, "app.authRefreshFailed"),
      }));
    } finally {
      setCheckingAuth((prev) => ({ ...prev, codex: false }));
    }
  };

  const refreshAuthStatus = async (service: ServiceType) => {
    setCheckingAuth((prev) => ({ ...prev, [service]: true }));

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

  const copyClaudeLoginCommand = async () => {
    try {
      await window.usagePulse.copyToClipboard("claude auth login");
      setClaudeLoginCommandCopied(true);
      setTimeout(() => setClaudeLoginCommandCopied(false), 3000);
    } catch (error) {
      console.error(error);
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

  const clearSystemClipboard = () => {
    window.usagePulse
      .clearClipboard()
      .catch((error: unknown) => console.error(error));
  };

  // The pasted text is applied by hand instead of letting the browser do it:
  // clearing the system clipboard raced the default paste action, which is why
  // pasting a token used to leave the field empty.
  // Both secret fields in this app behave the same way: the input only ever
  // renders asterisks, so every edit has to be applied to the real value held
  // in state rather than to what is on screen. Shared rather than duplicated,
  // so the two fields cannot drift apart on the details that make masking safe.
  const maskedTokenHandlers = (
    value: string,
    setValue: (updater: (prev: string) => string) => void,
    storedMask: string,
    clearMessage: () => void,
  ) => ({
    onPaste: (event: ClipboardEvent<HTMLInputElement>) => {
      event.preventDefault();
      const pasted = event.clipboardData.getData("text").trim();
      if (pasted) {
        setValue(() => pasted);
        clearMessage();
      }
      clearSystemClipboard();
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
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
      const startsFresh = wholeMaskSelected || value === storedMask;

      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        setValue((prev) => (startsFresh ? "" : prev.slice(0, -1)));
        clearMessage();
        return;
      }
      if (event.key.length === 1) {
        event.preventDefault();
        setValue((prev) => (startsFresh ? event.key : prev + event.key));
        clearMessage();
      }
    },
  });

  const lineTokenHandlers = maskedTokenHandlers(lineToken, setLineToken, LINE_TOKEN_MASK, () =>
    setLineTokenMessage({ text: "", isError: false }),
  );
  const claudeTokenHandlers = maskedTokenHandlers(
    claudeToken,
    setClaudeToken,
    CLAUDE_TOKEN_MASK,
    () => setClaudeTokenMessage({ text: "", isError: false }),
  );

  // Verification happens in main, against the real usage API, and only its
  // verdict comes back — so what is shown here is the outcome of an actual
  // request, never a guess made from the token's shape.
  const handleSaveClaudeToken = async () => {
    const token = claudeToken.trim();
    if (!token || token === CLAUDE_TOKEN_MASK) {
      setClaudeTokenMessage({ text: t(lang, "claudeToken.empty"), isError: true });
      return;
    }
    setSavingClaudeToken(true);
    setClaudeTokenMessage({ text: "", isError: false });
    try {
      const result = await window.usagePulse.saveClaudeToken(token);
      setClaudeTokenMessage({ text: result.message, isError: !result.ok });
      if (result.ok) {
        setClaudeToken("");
        await pullClaudeOntoScreen("");
      }
    } catch (error) {
      setClaudeTokenMessage({
        text: error instanceof Error ? error.message : t(lang, "claudeToken.apiFailed"),
        isError: true,
      });
    } finally {
      setSavingClaudeToken(false);
    }
  };

  const handleClearClaudeToken = async () => {
    setSavingClaudeToken(true);
    try {
      const result = await window.usagePulse.clearClaudeToken();
      setClaudeToken("");
      setClaudeTokenMessage({ text: result.message, isError: false });
      await pullClaudeOntoScreen("");
    } catch (error) {
      setClaudeTokenMessage({
        text: error instanceof Error ? error.message : t(lang, "app.authRefreshFailed"),
        isError: true,
      });
    } finally {
      setSavingClaudeToken(false);
    }
  };

  // settings:get never hands back the real LINE token, only whether one is
  // stored.
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
  const barClass = (service: ServiceType): string => {
    if (service === "cursor") {
      return "progress-fill progress-fill-cursor";
    }
    if (service === "codex") {
      return "progress-fill progress-fill-codex";
    }
    return "progress-fill";
  };

  // Every outcome is worded from what main actually reported; a refusal says
  // which state it found, never a guess at what to do about it.
  const describeHistoryResult = (result: HistoryCleanResult): string => {
    if (result.status === "cancelled") {
      return "";
    }
    if (result.status === "blocked") {
      return t(
        lang,
        `history.blocked.${result.reason ?? "dbFailed"}` as TranslationKey,
        { detail: result.detail ?? "" },
      );
    }
    let text = t(lang, "history.result.done", { trashed: result.trashed });
    if (result.dbRowsDeleted > 0) {
      text += t(lang, "history.result.dbRows", { rows: result.dbRowsDeleted });
    }
    if (result.failed > 0) {
      text += t(lang, "history.result.failed", { failed: result.failed });
    }
    return text;
  };

  const cleanHistory = async (service: HistoryService) => {
    setHistoryBusy((prev) => ({ ...prev, [service]: true }));
    setHistoryMessage((prev) => ({ ...prev, [service]: "" }));
    try {
      const result = await window.usagePulse.cleanHistory(service);
      setHistoryMessage((prev) => ({
        ...prev,
        [service]: describeHistoryResult(result),
      }));
    } catch (error) {
      const failure = classifyHistoryFailure(window.usagePulse, error);
      setHistoryMessage((prev) => ({
        ...prev,
        [service]: t(lang, failure.key, { detail: failure.detail }),
      }));
    } finally {
      setHistoryBusy((prev) => ({ ...prev, [service]: false }));
      await refreshHistoryStats();
    }
  };

  // Sits at the bottom of the Claude Code and Codex cards. Cursor has none: its
  // conversations share a file with its login credential.
  const renderHistoryRow = (service: HistoryService) => {
    const stats = historyStats?.[service];
    const busy = historyBusy[service];
    const statusText = stats
      ? t(
          lang,
          stats.staleFileCount > 0 ? "history.status" : "history.status.noStale",
          {
            count: stats.fileCount,
            size: formatBytes(stats.totalBytes),
            stale: stats.staleFileCount,
            staleSize: formatBytes(stats.staleBytes),
          },
        )
      : historyFailure
        ? t(lang, historyFailure.key, { detail: historyFailure.detail })
        : t(lang, "history.statusLoading");
    return (
      <div className="history-row">
        <p className="meta-text" style={{ margin: 0, color: "var(--color-text)" }}>
          {statusText}
        </p>
        <button
          type="button"
          className="danger-btn"
          style={{ marginTop: "8px" }}
          disabled={busy || !stats || stats.staleFileCount === 0}
          title={t(
            lang,
            service === "claude" ? "history.tooltip.claude" : "history.tooltip.codex",
          )}
          onClick={() => void cleanHistory(service)}
        >
          {busy ? t(lang, "history.cleaning") : t(lang, "history.clean")}
        </button>
        <p
          className="meta-text"
          style={{ marginTop: "6px", marginBottom: 0, color: "var(--color-danger)" }}
        >
          {t(lang, "history.warning")}
        </p>
        {historyMessage[service] ? (
          <p
            className="meta-text"
            style={{ marginTop: "6px", marginBottom: 0, color: "var(--color-text)" }}
          >
            {historyMessage[service]}
          </p>
        ) : null}
      </div>
    );
  };

  // Lives inside each quota card rather than in a section of its own: a card
  // showing "no data" is almost always explained by the credential right above
  // it, and the re-detect button here only ever touches this one service.
  const renderCredentialRow = (service: ServiceType, item?: QuotaSnapshot, hasData = true) => {
    const errorCode = item?.errorCode;
    const credential = authStatus[service];
    const message = authMessage[service];
    const credentialTag = resolveCredentialTag(service, credential, errorCode);

    const cursorCredentialBroken =
      service === "cursor" &&
      (credential.state === "expired" || credential.state === "missing" || credential.state === "error");
    const codexCredentialBroken =
      service === "codex" &&
      (errorCode === "codexLoginExpired" ||
        credential.state === "expired" ||
        credential.state === "missing" ||
        credential.state === "error");
    const needsAttention = cursorCredentialBroken || codexCredentialBroken;
    // Claude deliberately shows only "Update Values": that path already re-reads
    // the credential (monitor:run-manual runs credentialMonitor.check, and the
    // renderer follows up with the same auth:check the re-detect button used), so
    // a second button bought nothing but confusion.
    // Codex keeps both as separate actions so a login failure never hides
    // "Update Values" behind a single swapped button. Cursor has no quota refresh
    // of its own, so re-detect is its only way out of a broken credential.
    const showRefreshQuota = service === "claude" || service === "codex";
    const showRedetect = service === "codex" || cursorCredentialBroken;

    return (
      <div className="credential-row">
        <div className="quota-header">
          <span className={`status-tag ${credentialTag.tagClass}`}>
            {t(lang, credentialTag.labelKey as typeof credentialStateKeys[CredentialState])}
          </span>
          {showRefreshQuota || showRedetect ? (
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end" }}>
              {showRefreshQuota ? (
                <button
                  type="button"
                  className="ghost-btn"
                  style={{ width: "auto" }}
                  onClick={() =>
                    service === "codex" ? refreshCodexQuota() : refreshClaudeQuota()
                  }
                  disabled={checkingAuth[service]}
                  title={t(lang, "button.refreshQuota.tooltip")}
                >
                  {checkingAuth[service]
                    ? t(lang, "button.detecting")
                    : t(lang, "button.refreshQuota")}
                </button>
              ) : null}
              {showRedetect ? (
                <button
                  type="button"
                  className={needsAttention ? "warning-btn" : "ghost-btn"}
                  style={{ width: "auto" }}
                  onClick={() => refreshAuthStatus(service)}
                  disabled={checkingAuth[service]}
                  title={t(lang, "button.redetect.tooltip")}
                >
                  {checkingAuth[service]
                    ? t(lang, "button.detecting")
                    : t(lang, "button.redetect")}
                </button>
              ) : null}
            </div>
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
        {service === "claude" && errorCode === "claudeScopeInsufficient" ? (
          <p className="meta-text" style={{ margin: "2px 0 0" }}>
            {t(lang, "auth.hint.claudeScope")}
          </p>
        ) : null}
        {credential.message ? (
          <p className="meta-text" style={{ margin: "2px 0 0" }}>
            {credential.message}
          </p>
        ) : null}
        {message && !(errorCode && SCRAPE_FAILURE_CODES.includes(errorCode)) ? (
          <p className="meta-text" style={{ margin: "2px 0 0" }}>
            {message}
          </p>
        ) : null}
        {service === "claude" && !hasData ? renderClaudeCredentialBlock(credential, item) : null}
      </div>
    );
  };

  /**
   * What actually stopped the Claude card from showing numbers this time.
   *
   * The block below appears whenever there are no numbers, whatever the cause —
   * but it must not blame the credential for a rate limit or a dropped
   * connection, so the reason comes from what the fetch really returned rather
   * than from a guess about the credential.
   */
  const claudeNoDataReasonKey = (
    credential: CredentialStatus,
    item?: QuotaSnapshot,
  ): TranslationKey => {
    if (item?.errorCode === "claudeScopeInsufficient") {
      return "error.claudeScopeInsufficient";
    }
    if (item?.errorCode === "claudeRateLimited") {
      return "error.claudeRateLimited";
    }
    if (item?.errorCode === "claudeLoginExpired") {
      return "error.claudeLoginExpired";
    }
    if (credential.state === "missing") {
      return "error.claudeCredentialMissing";
    }
    if (item?.status === "error") {
      return "error.claudeApiFailed";
    }
    if (!item) {
      return "app.notFetchedYet";
    }
    return "quotaCheck.noUsageYet";
  };

  /**
   * The one gate that matters: no usable quota on screen means the user gets a
   * way out, immediately and without hunting for a button.
   *
   * Deliberately NOT gated on credential.state. That state is inferred locally
   * from an expiry timestamp and the presence of a Keychain item, and it has
   * repeatedly disagreed with what the usage API actually does — which is how
   * the card ended up telling users to press a button that was never rendered.
   * Whether the last fetch returned data is the only signal that cannot lie.
   */
  const renderClaudeCredentialBlock = (credential: CredentialStatus, item?: QuotaSnapshot) => {
    const hasStoredToken = Boolean(settings.claudeManualToken);
    // macOS already auto-detects the Keychain credential written by
    // `claude auth login`, so the paste-a-token fallback only needs to show
    // there if a legacy token is still stored (so it stays clearable). On
    // every other platform there is no automatic detection at all, so this
    // is the only way to supply a credential.
    const showManualTokenInput = window.usagePulse.platform !== "darwin" || hasStoredToken;
    return (
      <div style={{ marginTop: "8px" }}>
        <p className="meta-text" style={{ margin: 0 }}>
          {t(lang, claudeNoDataReasonKey(credential, item))}
        </p>
        {renderClaudeLoginInstructions()}
        {secretStorageOk ? null : (
          <div className="callout-warning" style={{ marginTop: "8px" }}>
            ⚠️ {t(lang, "settings.insecureStorage")}
          </div>
        )}
        {showManualTokenInput ? (
          <>
            <label className="field" style={{ marginTop: "8px" }}>
              <span>{t(lang, "claudeToken.title")}</span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={t(lang, "claudeToken.placeholder")}
                value={maskToken(claudeToken)}
                onPaste={claudeTokenHandlers.onPaste}
                onKeyDown={claudeTokenHandlers.onKeyDown}
                // Controlled by the mask: every mutation goes through the paste and
                // key handlers above, so there is nothing for onChange to apply.
                onChange={() => undefined}
              />
            </label>
            <p className="meta-text" style={{ margin: "6px 0 0" }}>
              {t(lang, "claudeToken.hint")}
            </p>
            <div className="alarm-actions-row">
              <button
                type="button"
                className="primary-btn"
                onClick={handleSaveClaudeToken}
                disabled={savingClaudeToken}
              >
                {savingClaudeToken ? t(lang, "claudeToken.saving") : t(lang, "claudeToken.save")}
              </button>
              {hasStoredToken ? (
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={handleClearClaudeToken}
                  disabled={savingClaudeToken}
                >
                  {t(lang, "claudeToken.clear")}
                </button>
              ) : null}
            </div>
            {hasStoredToken ? (
              <p className="meta-text" style={{ margin: "6px 0 0" }}>
                {t(lang, "claudeToken.stored")}
              </p>
            ) : null}
            {claudeTokenMessage.text ? (
              <p
                className={claudeTokenMessage.isError ? "form-error" : "meta-text"}
                style={{ margin: "6px 0 0" }}
              >
                {claudeTokenMessage.text}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    );
  };

  // Claude Code only. Shown while the Keychain credential is missing: the
  // user runs `claude auth login` in their own terminal — the official CLI
  // opens the browser and writes the credential itself — then clicks
  // "Update Values" here once done. Usage-Pulse never touches the login.
  const renderClaudeLoginInstructions = () => (
    <div className="callout-warning" style={{ marginTop: "8px" }}>
      <p style={{ margin: 0 }}>{t(lang, "claudeLogin.prompt")}</p>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          marginTop: "8px",
        }}
      >
        <code>claude auth login</code>
        <button
          type="button"
          className="warning-btn"
          style={{ width: "auto" }}
          onClick={copyClaudeLoginCommand}
        >
          {claudeLoginCommandCopied ? t(lang, "claudeLogin.copied") : t(lang, "claudeLogin.copyCommand")}
        </button>
      </div>
      <p className="meta-text" style={{ margin: "8px 0 0" }}>
        {t(lang, "claudeLogin.afterLoginHint")}
      </p>
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
  const renderSessionCountdownBar = (resetsAt: string, service: ServiceType) => {
    const msRemaining = Date.parse(resetsAt) - now;
    const elapsedPercent = Number.isNaN(msRemaining)
      ? 0
      : Math.max(
          0,
          Math.min(100, 100 - (msRemaining / SESSION_WINDOW_MS) * 100),
        );

    return (
      <div className="window-bar" key={`${service}-session-countdown`}>
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
            className={barClass(service)}
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

  // Takes effect immediately rather than waiting on the "save settings"
  // button — the menu-bar icon should reflect the choice as soon as it's
  // made, same immediacy as changeLanguage above.
  const changeTrayValueColorMode = async (mode: TrayValueColorMode) => {
    setSettings((prev) => ({ ...prev, trayValueColorMode: mode }));
    try {
      const next = await window.usagePulse.saveSettings({ trayValueColorMode: mode });
      setSettings(next);
    } catch (error) {
      console.error(error);
    }
  };

  // Lives on the quota card itself (not the batched Settings panel below), so
  // it takes effect immediately rather than waiting on the "save settings"
  // button — same immediacy as changeLanguage above.
  const setMonitoringEnabled = async (service: ServiceType, enabled: boolean) => {
    const key =
      service === "cursor"
        ? "enableCursorMonitoring"
        : service === "claude"
          ? "enableClaudeMonitoring"
          : "enableCodexMonitoring";
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

  // Per-service "how to remind me": two checkboxes on one wrapping row, so the
  // choice sits inside the service's own block without costing a row each.
  const renderNotifyChannels = (service: ServiceType) => {
    const popupKey = POPUP_SETTING_KEY[service];
    const lineKey = LINE_SETTING_KEY[service];
    return (
      <div className="notify-channels">
        <p className="notify-channels-title">{t(lang, "alarm.how.title")}</p>
        <div className="check-row">
          <label className="check-item">
            <input
              type="checkbox"
              checked={settings[popupKey]}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  [popupKey]: event.target.checked,
                }))
              }
            />
            <span>{t(lang, "alarm.popupToggle")}</span>
          </label>
          <label className="check-item">
            <input
              type="checkbox"
              className="check-line"
              checked={settings[lineKey]}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  [lineKey]: event.target.checked,
                }))
              }
            />
            <span>{t(lang, "alarm.lineToggle")}</span>
          </label>
        </div>
        {settings[popupKey] ? (
          <p className="meta-text" style={{ margin: "6px 0 0" }}>
            {t(lang, "alarm.autoDismiss", {
              seconds: ALARM_POPUP_AUTO_DISMISS_SECONDS,
            })}
          </p>
        ) : null}
        {settings[lineKey] && !lineToken.trim() ? (
          <p className="meta-text" style={{ margin: "6px 0 0" }}>
            {t(lang, "alarm.lineNeedToken")}
          </p>
        ) : null}
      </div>
    );
  };

  const renderToggleOnlyRow = (
    labelKey: TranslationKey,
    toggleKey: "enableClaudeCooldownAlert" | "enableCodexCooldownAlert",
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
      {canAutoUpdate && updateInfo && !updateDismissed && (
        <section className="panel panel-update">
          <div className="quota-header">
            <h2>{t(lang, "update.available.title", { version: updateInfo.version })}</h2>
          </div>
          {updateInfo.releaseNotes && (
            <p className="callout-warning update-notes">{updateInfo.releaseNotes}</p>
          )}
          {updateDownloading && !updateDownloaded && (
            <>
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${updateDownloadPercent}%` }}
                />
              </div>
              <p className="meta-text">
                {t(lang, "update.banner.downloading", { percent: updateDownloadPercent })}
              </p>
            </>
          )}
          {updateDownloaded ? (
            <button type="button" className="primary-btn" onClick={handleRestartAndInstall}>
              {t(lang, "update.banner.restartAndInstall")}
            </button>
          ) : (
            <div className="update-banner-actions">
              <button
                type="button"
                className="primary-btn"
                disabled={updateDownloading}
                onClick={handleUpdateNow}
              >
                {t(lang, "update.banner.updateNow")}
              </button>
              <button type="button" className="ghost-btn" onClick={handleUpdateLater}>
                {t(lang, "update.banner.later")}
              </button>
            </div>
          )}
        </section>
      )}

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
          {(["claude", "codex", "cursor"] as ServiceType[]).map((service) => {
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
                  {renderCredentialRow(service, item, barWindows.length > 0)}
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
                        renderSessionCountdownBar(sessionWindow.resetsAt, service)}
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
                  {renderHistoryRow("claude")}
                    </>
                  )}
                </div>
              );
            }

            if (service === "codex") {
              const windows = item?.windows ?? [];
              const sessionWindow =
                windows.find((window) => window.key === "session") ?? null;
              const weeklyWindow =
                windows.find((window) => window.key === "weekly") ?? null;
              // Backend slot names (primary_window / secondary_window) are not
              // real windows — main already drops them, this keeps a stale
              // snapshot from ever drawing one as a nameless bar.
              const extraWindows = windows.filter(
                (window) =>
                  window.key !== "session" &&
                  window.key !== "weekly" &&
                  window.percent !== null &&
                  !isCodexBackendSlotKey(window.key),
              );
              const hasBars =
                Boolean(sessionWindow || weeklyWindow || extraWindows.length || item?.creditsText);

              return (
                <div className="quota-card quota-card-codex" key={service}>
                  <div className="quota-header">
                    <label className="field switch-row" style={{ margin: 0 }}>
                      <span>{t(lang, "monitor.enableCodex")}</span>
                      <input
                        type="checkbox"
                        className="toggle"
                        checked={settings.enableCodexMonitoring}
                        onChange={(event) =>
                          setMonitoringEnabled("codex", event.target.checked)
                        }
                      />
                    </label>
                  </div>
                  {!settings.enableCodexMonitoring ? (
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
                  {renderCredentialRow(service, item)}
                  {hasBars ? (
                    <div className="window-bars">
                      {sessionWindow &&
                        renderWindowBar(
                          sessionWindow,
                          item!.unit,
                          service,
                          false,
                        )}
                      {sessionWindow?.resetsAt &&
                        renderSessionCountdownBar(sessionWindow.resetsAt, service)}
                      {weeklyWindow &&
                        renderWindowBar(weeklyWindow, item!.unit, service)}
                      {extraWindows.map((window) =>
                        renderWindowBar(window, item!.unit, service),
                      )}
                      {item?.creditsText ? (
                        <p className="meta-text" style={{ marginTop: "8px" }}>
                          {item.creditsText}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="meta-text" style={{ marginTop: "8px" }}>
                      {item?.message || t(lang, "app.notFetchedYet")}
                    </p>
                  )}
                  {renderHistoryRow("codex")}
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
                }))
              }
            />
          </label>
          <p className="meta-text" style={{ margin: 0 }}>
            {t(lang, "settings.launchWithIde.hint")}
          </p>
        </div>

        {canAutoUpdate && (
          <div className="field">
            <label className="field switch-row" style={{ marginBottom: 0 }}>
              <span>{t(lang, "settings.autoCheckForUpdates")}</span>
              <input
                type="checkbox"
                className="toggle"
                checked={settings.autoCheckForUpdates}
                onChange={(event) =>
                  setSettings((prev) => ({
                    ...prev,
                    autoCheckForUpdates: event.target.checked,
                  }))
                }
              />
            </label>
            <p className="meta-text" style={{ margin: 0 }}>
              {t(lang, "settings.autoCheckForUpdates.hint")}
            </p>
          </div>
        )}

        <label className="field">
          <span>{t(lang, "settings.trayValueColor")}</span>
          <select
            value={settings.trayValueColorMode}
            onChange={(event) =>
              void changeTrayValueColorMode(event.target.value as TrayValueColorMode)
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

          {renderNotifyChannels("cursor")}
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

          {renderNotifyChannels("claude")}
        </div>
        )}

        {settings.enableCodexMonitoring && (
        <div className="quota-card service-block service-block-codex">
          <div className="quota-header">
            <strong>{serviceNames.codex}</strong>
          </div>

          {renderLowQuotaRow(
            "alertLabel.codexSession",
            "codexSessionLowThresholdPercent",
            "enableCodexSessionLowAlert",
          )}
          {renderLowQuotaRow(
            "alertLabel.codexWeekly",
            "codexWeeklyLowThresholdPercent",
            "enableCodexWeeklyLowAlert",
          )}
          {renderToggleOnlyRow(
            "alertLabel.codexCooldown",
            "enableCodexCooldownAlert",
          )}

          <label className="field switch-row" style={{ marginTop: "10px" }}>
            <span>{t(lang, "settings.codexActivityPolling")}</span>
            <input
              type="checkbox"
              className="toggle"
              checked={settings.codexUseCliActivityPolling}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  codexUseCliActivityPolling: event.target.checked,
                }))
              }
            />
          </label>

          <label className="field switch-row" style={{ marginTop: "10px" }}>
            <span>{t(lang, "alarm.when.codexSession")}</span>
            <input
              type="checkbox"
              className="toggle"
              checked={settings.enableCodexResetAlarm}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  enableCodexResetAlarm: event.target.checked,
                }))
              }
            />
          </label>
          {settings.enableCodexResetAlarm && snapshot?.codex.resetsAt && (
            <p
              className="meta-text"
              style={{ margin: "2px 0 0", color: "#8b949e", fontSize: "12px" }}
            >
              {t(lang, "settings.resetAlarm.nextFire", {
                countdown: formatCountdown(snapshot.codex.resetsAt, now, lang),
                resetTime: formatResetText(snapshot.codex.resetsAt, lang),
              })}
            </p>
          )}

          <label className="field switch-row" style={{ marginTop: "10px" }}>
            <span>{t(lang, "alarm.when.codexWeekly")}</span>
            <input
              type="checkbox"
              className="toggle"
              checked={settings.enableCodexWeeklyResetAlarm}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  enableCodexWeeklyResetAlarm: event.target.checked,
                }))
              }
            />
          </label>
          {settings.enableCodexWeeklyResetAlarm && snapshot?.codex.weeklyResetAt && (
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
                  snapshot.codex.weeklyResetAt,
                  now,
                  lang,
                ),
                resetTime: formatResetText(
                  snapshot.codex.weeklyResetAt,
                  lang,
                ),
              })}
            </p>
          )}

          {renderNotifyChannels("codex")}
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

          <div className="alarm-actions-row" style={{ marginTop: "12px" }}>
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

      <section className="panel panel-line">
        <h2>{t(lang, "line.title")}</h2>
        <p className="meta-text" style={{ marginBottom: "10px" }}>
          {t(lang, "line.desc")}
        </p>

        {!isLineInUse(settings) ? (
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
                onPaste={lineTokenHandlers.onPaste}
                onKeyDown={lineTokenHandlers.onKeyDown}
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
