import {
  useEffect,
  useState,
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
  cursorIntervalMinutes: 10,
  claudeIntervalMinutes: 10,
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
  const [claudeCommandCopied, setClaudeCommandCopied] = useState(false);
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

    return () => {
      unsubscribeSnapshot();
      unsubscribeAuth();
      unsubscribeSession();
    };
  }, []);

  const clampSettings = (value: AppSettings): AppSettings => ({
    ...value,
    cursorIntervalMinutes: roundToStep(
      value.cursorIntervalMinutes,
      5,
      60,
      5,
      10,
    ),
    claudeIntervalMinutes: roundToStep(
      value.claudeIntervalMinutes,
      5,
      60,
      5,
      10,
    ),
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
  const refreshAuthStatus = async (service: ServiceType) => {
    setCheckingAuth((prev) => ({ ...prev, [service]: true }));
    try {
      if (service === "claude") {
        setAuthMessage((prev) => ({
          ...prev,
          claude: t(lang, "setupToken.waiting"),
        }));
        const result = await window.usagePulse.runSetupToken();
        const [next, latestSnapshot, nextSettings] = await Promise.all([
          window.usagePulse.checkAuth("claude"),
          window.usagePulse.getLatestSnapshot(),
          window.usagePulse.getSettings(),
        ]);
        setAuthStatus((prev) => ({ ...prev, claude: next }));
        setSnapshot(latestSnapshot);
        setSettings(nextSettings);
        setAuthMessage((prev) => ({
          ...prev,
          claude: result.message || t(lang, result.ok ? "app.authRefreshed" : "app.authRefreshFailed"),
        }));
        return;
      }

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
      setLineTokenMessage({ text: t(lang, "line.saved"), isError: false });
    } catch (error) {
      console.error(error);
    } finally {
      setSavingLineToken(false);
    }
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

  const copyClaudeLoginCommand = async () => {
    try {
      await window.usagePulse.copyToClipboard("claude");
      setClaudeCommandCopied(true);
      setTimeout(() => setClaudeCommandCopied(false), 3000);
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

  // settings:get hands back a placeholder for the manual token, never the token
  // itself, so all the UI can know is whether one is stored.
  const hasManualToken = Boolean(settings.claudeManualOAuthToken);

  const clearManualToken = async () => {
    try {
      await window.usagePulse.clearManualCredential("claude");
      await refreshBaseData();
    } catch (error) {
      console.error(error);
    }
  };

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
  const renderCredentialRow = (service: ServiceType) => {
    const credential = authStatus[service];
    const message = authMessage[service];

    return (
      <div className="credential-row">
        <div className="quota-header">
          <span
            className={`status-tag ${credentialTagClass(credential.state)}`}
          >
            {t(lang, credentialStateKeys[credential.state])}
          </span>
          <button
            type="button"
            className="warning-btn"
            style={{ width: "auto" }}
            onClick={() => refreshAuthStatus(service)}
            disabled={checkingAuth[service]}
          >
            {checkingAuth[service]
              ? t(lang, "button.detecting")
              : t(lang, "button.redetect")}
          </button>
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
        {service === "claude" ? renderManualCredentialRow() : null}
      </div>
    );
  };

  // Claude Code only. Shows whether the token the re-detect flow captured is
  // still the one in use, with a way to drop it if it turns out to be bad.
  const renderManualCredentialRow = () =>
    hasManualToken ? (
      <div className="quota-header" style={{ marginTop: "8px", gap: "8px" }}>
        <span className="meta-text" style={{ margin: 0 }}>
          {t(lang, "manualToken.inUse")}
        </span>
        <button
          type="button"
          className="danger-btn"
          style={{ width: "auto" }}
          onClick={clearManualToken}
        >
          {t(lang, "manualToken.clearButton")}
        </button>
      </div>
    ) : null;

  const renderUsagePercentBar = (window: QuotaWindow, service: ServiceType) => (
    <div className="window-bar" key={window.key}>
      <div className="quota-header" style={{ marginBottom: "6px" }}>
        <span className="window-bar-label">{window.label}</span>
        <span className="meta-text" style={{ margin: 0 }}>
          {t(lang, "window.usagePercent", {
            percent: Math.round(window.percent ?? 0),
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
                    <strong>{serviceNames[service]}</strong>
                    <span
                      className={`status-tag status-${item?.status || "unknown"}`}
                    >
                      {item?.status || "unknown"}
                    </span>
                  </div>
                  {renderCredentialRow(service)}
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
                  {item?.errorCode === "claudeLoginExpired" ? (
                    <div
                      className="callout-warning"
                      style={{ marginTop: "8px" }}
                    >
                      <p style={{ margin: 0 }}>
                        {t(lang, "auth.claude.reloginCta")}
                      </p>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          marginTop: "8px",
                        }}
                      >
                        <code>claude</code>
                        <button
                          type="button"
                          className="warning-btn"
                          style={{ width: "auto" }}
                          onClick={copyClaudeLoginCommand}
                        >
                          {claudeCommandCopied
                            ? t(lang, "auth.claude.copied")
                            : t(lang, "auth.claude.copyCommand")}
                        </button>
                      </div>
                    </div>
                  ) : null}
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
            // Controlled by the mask: every mutation goes through the paste and
            // key handlers above, so there is nothing for onChange to apply.
            onChange={() => undefined}
          />
        </label>

        <div className="alarm-actions-row">
          <button
            className="primary-btn primary-btn-line"
            onClick={handleSaveLineCredentials}
            disabled={savingLineToken}
          >
            {savingLineToken ? t(lang, "button.saving") : t(lang, "line.save")}
          </button>
          <button
            className="ghost-btn"
            onClick={handleSendLineTest}
            disabled={testingLineToken || !settings.lineChannelAccessToken}
          >
            {testingLineToken ? t(lang, "line.testSending") : t(lang, "line.test")}
          </button>
        </div>
        {lineTokenMessage.text ? (
          <p className={lineTokenMessage.isError ? "form-error" : "meta-text"}>
            {lineTokenMessage.text}
          </p>
        ) : null}
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
