import { useEffect, useState } from "react";
import type {
  AlarmStatusReport,
  AppSettings,
  AuthStatus,
  CombinedSnapshot,
  CredentialState,
  CredentialStatus,
  Language,
  QuotaSnapshot,
  QuotaWindow,
  ServiceType
} from "@shared/types";
import { t } from "@shared/i18n";

const THREADS_URL = "https://www.threads.com/@xiaochen26wyl";

const defaultSettings: AppSettings = {
  cursorIntervalMinutes: 10,
  claudeIntervalMinutes: 10,
  cursorLowThresholdPercent: 20,
  claudeLowThresholdPercent: 20,
  launchAtLogin: false,
  notifyCooldownMinutes: 15,
  enableCursorResetAlarm: true,
  enableClaudeResetAlarm: true,
  enableCursorLowQuotaAlert: true,
  enableClaudeLowQuotaAlert: true,
  language: "zh",
  enableAlarmPopup: true,
  alarmSoundEnabled: true,
  alarmPopupAutoDismissMinutes: 5,
  alarmCatchUpMinutes: 30,
  lineChannelAccessToken: "",
  lineChannelId: "",
  lineAssertionKid: "",
  lineAssertionPrivateKey: ""
};

const emptyCredential = (service: ServiceType): CredentialStatus => ({
  service,
  state: "missing",
  expiresAt: null,
  rotatedAt: null,
  checkedAt: ""
});

const defaultAuth: AuthStatus = {
  cursor: emptyCredential("cursor"),
  claude: emptyCredential("claude")
};

const credentialStateKeys: Record<CredentialState, "auth.state.ok" | "auth.state.expiring" | "auth.state.expired" | "auth.state.missing" | "auth.state.error"> = {
  ok: "auth.state.ok",
  expiring: "auth.state.expiring",
  expired: "auth.state.expired",
  missing: "auth.state.missing",
  error: "auth.state.error"
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
  claude: "Claude Code"
};

const authHintKeys: Record<ServiceType, "auth.hint.cursor" | "auth.hint.claude"> = {
  cursor: "auth.hint.cursor",
  claude: "auth.hint.claude"
};

const formatValue = (value: number | null, unit: QuotaSnapshot["unit"]): string => {
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
  return date.toLocaleString();
};

const formatCountdown = (iso: string | null, now: number, lang: Language): string => {
  if (!iso) return t(lang, "app.unknown");
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return t(lang, "app.unknown");

  const diff = date.getTime() - now;
  if (diff <= 0) return t(lang, "app.alreadyReset");

  const seconds = Math.floor(diff / 1000) % 60;
  const minutes = Math.floor(diff / 60000) % 60;
  const hours = Math.floor(diff / 3600000) % 24;
  const days = Math.floor(diff / 86400000);

  if (days > 0) return t(lang, "app.countdown.days", { days, hours, minutes });
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

const roundToStep = (value: unknown, min: number, max: number, step: number, fallback: number): number => {
  const numeric = Number(value) || fallback;
  const clamped = Math.min(max, Math.max(min, numeric));
  return Math.round(clamped / step) * step;
};

export const App = () => {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [authStatus, setAuthStatus] = useState<AuthStatus>(defaultAuth);
  const [snapshot, setSnapshot] = useState<CombinedSnapshot | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState<Record<ServiceType, boolean>>({ cursor: false, claude: false });
  const [authMessage, setAuthMessage] = useState<Record<ServiceType, string>>({ cursor: "", claude: "" });
  const [claudeCommandCopied, setClaudeCommandCopied] = useState(false);
  const [lineFields, setLineFields] = useState({
    lineChannelAccessToken: "",
    lineChannelId: "",
    lineAssertionKid: "",
    lineAssertionPrivateKey: ""
  });
  const [savingLineToken, setSavingLineToken] = useState(false);
  const [lineTokenMessage, setLineTokenMessage] = useState("");
  const [now, setNow] = useState<number>(Date.now());
  const [alarmStatus, setAlarmStatus] = useState<AlarmStatusReport | null>(null);
  const [alarmMessage, setAlarmMessage] = useState("");
  const [confirmingAlarm, setConfirmingAlarm] = useState(false);
  const [checkingAlarm, setCheckingAlarm] = useState(false);
  const [checkingQuota, setCheckingQuota] = useState(false);
  const [quotaCheckMessage, setQuotaCheckMessage] = useState("");
  const lang = settings.language;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const refreshBaseData = async () => {
    const [nextSettings, nextAuthStatus, latestSnapshot, nextAlarmStatus] = await Promise.all([
      window.usagePulse.getSettings(),
      window.usagePulse.getAuthStatus(),
      window.usagePulse.getLatestSnapshot(),
      window.usagePulse.getAlarmStatus()
    ]);
    setSettings(nextSettings);
    setAuthStatus(nextAuthStatus);
    setSnapshot(latestSnapshot);
    setAlarmStatus(nextAlarmStatus);
    setLineFields({
      lineChannelAccessToken: nextSettings.lineChannelAccessToken,
      lineChannelId: nextSettings.lineChannelId,
      lineAssertionKid: nextSettings.lineAssertionKid,
      lineAssertionPrivateKey: nextSettings.lineAssertionPrivateKey
    });
  };

  useEffect(() => {
    refreshBaseData().catch((error) => {
      console.error(error);
    });

    const unsubscribeSnapshot = window.usagePulse.onSnapshotUpdated((nextSnapshot) => {
      setSnapshot(nextSnapshot);
    });

    const unsubscribeAuth = window.usagePulse.onAuthUpdated((nextAuth) => {
      setAuthStatus(nextAuth);
    });

    return () => {
      unsubscribeSnapshot();
      unsubscribeAuth();
    };
  }, []);

  const clampSettings = (value: AppSettings): AppSettings => ({
    ...value,
    cursorIntervalMinutes: roundToStep(value.cursorIntervalMinutes, 5, 60, 5, 10),
    claudeIntervalMinutes: roundToStep(value.claudeIntervalMinutes, 5, 60, 5, 10),
    cursorLowThresholdPercent: roundToStep(value.cursorLowThresholdPercent, 5, 30, 5, 20),
    claudeLowThresholdPercent: roundToStep(value.claudeLowThresholdPercent, 5, 30, 5, 20),
    notifyCooldownMinutes: roundToStep(value.notifyCooldownMinutes, 5, 240, 5, 15),
    alarmPopupAutoDismissMinutes: roundToStep(value.alarmPopupAutoDismissMinutes, 1, 30, 1, 5),
    alarmCatchUpMinutes: roundToStep(value.alarmCatchUpMinutes, 5, 180, 5, 30)
  });

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      const next = await window.usagePulse.saveSettings(clampSettings(settings));
      setSettings(next);
      setAlarmStatus(await window.usagePulse.getAlarmStatus());
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
        t(lang, "alarm.checkFailed", { message: error instanceof Error ? error.message : String(error) })
      );
    } finally {
      setCheckingAlarm(false);
    }
  };

  // The one action that makes the whole alarm section true: persist what the
  // user just toggled, rebuild the in-app timers, re-sync the OS schedulers and
  // re-probe them — then report back when the next alarm actually rings.
  const confirmAlarmSettings = async () => {
    setConfirmingAlarm(true);
    try {
      setSettings(await window.usagePulse.saveSettings(clampSettings(settings)));
      const report = await window.usagePulse.rearmAlarm();
      setAlarmStatus(report);
      setAlarmMessage(
        report.nextTarget
          ? t(lang, "alarm.confirmed", {
              countdown: formatCountdown(report.nextTarget.fireAt, Date.now(), lang),
              resetTime: formatResetText(report.nextTarget.fireAt, lang)
            })
          : t(lang, "alarm.confirmedNoTarget")
      );
    } catch (error) {
      setAlarmMessage(
        t(lang, "alarm.confirmFailed", { message: error instanceof Error ? error.message : String(error) })
      );
    } finally {
      setConfirmingAlarm(false);
    }
  };

  const testAlarmPopup = async () => {
    try {
      await window.usagePulse.testAlarmPopup();
      setAlarmMessage("");
    } catch (error) {
      setAlarmMessage(error instanceof Error ? error.message : t(lang, "alarm.testFailed"));
    }
  };

  // Scoped to one service: the Cursor card re-reads only Cursor's credential and
  // the Claude Code card only Claude's, so retrying one never disturbs the other.
  const refreshAuthStatus = async (service: ServiceType) => {
    setCheckingAuth((prev) => ({ ...prev, [service]: true }));
    try {
      const next = await window.usagePulse.checkAuth(service);
      setAuthStatus((prev) => ({ ...prev, [service]: next }));
      setAuthMessage((prev) => ({ ...prev, [service]: t(lang, "app.authRefreshed") }));
    } catch (error) {
      setAuthMessage((prev) => ({
        ...prev,
        [service]: error instanceof Error ? error.message : t(lang, "app.authRefreshFailed")
      }));
    } finally {
      setCheckingAuth((prev) => ({ ...prev, [service]: false }));
    }
  };

  const handleSaveLineCredentials = async () => {
    setSavingLineToken(true);
    try {
      const next = await window.usagePulse.saveSettings({
        lineChannelAccessToken: lineFields.lineChannelAccessToken.trim(),
        lineChannelId: lineFields.lineChannelId.trim(),
        lineAssertionKid: lineFields.lineAssertionKid.trim(),
        lineAssertionPrivateKey: lineFields.lineAssertionPrivateKey.trim()
      });
      setSettings(next);
      setLineFields({
        lineChannelAccessToken: next.lineChannelAccessToken,
        lineChannelId: next.lineChannelId,
        lineAssertionKid: next.lineAssertionKid,
        lineAssertionPrivateKey: next.lineAssertionPrivateKey
      });
      setLineTokenMessage(t(lang, "line.saved"));
    } catch (error) {
      console.error(error);
    } finally {
      setSavingLineToken(false);
    }
  };

  const runManualQuotaCheck = async () => {
    setCheckingQuota(true);
    try {
      const result = await window.usagePulse.runManualCheck();
      setSnapshot(result.snapshot);
      setQuotaCheckMessage(result.reason);
    } catch (error) {
      setQuotaCheckMessage(error instanceof Error ? error.message : t(lang, "app.authRefreshFailed"));
    } finally {
      setCheckingQuota(false);
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

  const handleSensitivePaste = () => {
    window.usagePulse.clearClipboard().catch((error: unknown) => console.error(error));
  };

  const quitApp = async () => {
    try {
      await window.usagePulse.quitApp();
    } catch (error) {
      console.error(error);
    }
  };

  const openThreads = async () => {
    try {
      await window.usagePulse.openExternal(THREADS_URL);
    } catch {
      // best-effort: opening the support link failing is not worth surfacing.
    }
  };

  // Bar colour identifies the service, never the quota level — Cursor is always
  // green and Claude Code always blue. Low quota is signalled by the status tag
  // in the card header instead.
  const barClass = (service: ServiceType): string =>
    service === "cursor" ? "progress-fill progress-fill-cursor" : "progress-fill";

  // Lives inside each quota card rather than in a section of its own: a card
  // showing "no data" is almost always explained by the credential right above
  // it, and the re-detect button here only ever touches this one service.
  const renderCredentialRow = (service: ServiceType) => {
    const credential = authStatus[service];
    const message = authMessage[service];

    return (
      <div className="credential-row">
        <div className="quota-header">
          <span className={`status-tag ${credentialTagClass(credential.state)}`}>
            {t(lang, credentialStateKeys[credential.state])}
          </span>
          <button
            type="button"
            className="warning-btn"
            style={{ width: "auto" }}
            onClick={() => refreshAuthStatus(service)}
            disabled={checkingAuth[service]}
          >
            {checkingAuth[service] ? t(lang, "button.detecting") : t(lang, "button.redetect")}
          </button>
        </div>
        <p className="meta-text" style={{ margin: "6px 0 0" }}>
          {credential.checkedAt
            ? t(lang, "auth.lastChecked", { time: new Date(credential.checkedAt).toLocaleString() })
            : t(lang, "auth.lastCheckedNever")}
        </p>
        {credential.expiresAt ? (
          <p className="meta-text" style={{ margin: "2px 0 0" }}>
            {t(lang, "auth.expiresAt", { time: new Date(credential.expiresAt).toLocaleString() })}
          </p>
        ) : null}
        {credential.state === "missing" || credential.state === "error" ? (
          <p className="meta-text" style={{ margin: "2px 0 0" }}>{t(lang, authHintKeys[service])}</p>
        ) : null}
        {credential.message ? (
          <p className="meta-text" style={{ margin: "2px 0 0" }}>{credential.message}</p>
        ) : null}
        {message ? <p className="meta-text" style={{ margin: "2px 0 0" }}>{message}</p> : null}
      </div>
    );
  };

  const renderUsagePercentBar = (window: QuotaWindow, service: ServiceType) => (
    <div className="window-bar" key={window.key}>
      <div className="quota-header" style={{ marginBottom: "6px" }}>
        <span className="window-bar-label">{window.label}</span>
        <span className="meta-text" style={{ margin: 0 }}>
          {t(lang, "window.usagePercent", { percent: Math.round(window.percent ?? 0) })}
        </span>
      </div>
      <div className="progress-track">
        <div
          className={barClass(service)}
          style={{ width: `${Math.max(0, Math.min(100, window.percent ?? 0))}%` }}
        />
      </div>
      {window.message && (
        <p className="meta-text" style={{ margin: "6px 0 0" }}>{window.message}</p>
      )}
    </div>
  );

  const renderWindowBar = (window: QuotaWindow, unit: QuotaSnapshot["unit"], service: ServiceType) => (
    <div className="window-bar" key={window.key}>
      <div className="quota-header" style={{ marginBottom: "6px" }}>
        <span className="window-bar-label">{window.label}</span>
        <span className="meta-text" style={{ margin: 0 }}>
          {t(lang, "quota.remaining")} {formatValue(window.remaining, unit)} / {formatValue(window.total, unit)}
        </span>
      </div>
      <div className="progress-track">
        <div
          className={barClass(service)}
          style={{ width: `${window.percent ?? 0}%` }}
        />
      </div>
      {window.resetsAt && (
        <p className="meta-text" style={{ margin: "6px 0 0", color: "#8b949e", fontSize: "12px" }}>
          {t(lang, "app.liveCountdown", {
            countdown: formatCountdown(window.resetsAt, now, lang),
            resetTime: formatResetText(window.resetsAt, lang)
          })}
        </p>
      )}
    </div>
  );

  const toggleLanguage = async () => {
    const nextLang: Language = lang === "zh" ? "en" : "zh";
    setSettings((prev) => ({ ...prev, language: nextLang }));
    try {
      const next = await window.usagePulse.saveSettings(clampSettings({ ...settings, language: nextLang }));
      setSettings(next);
    } catch (error) {
      console.error(error);
    }
  };

  return (
    <main className="app">
      <section className="panel">
        <div className="quota-header">
          <h1>Usage-Pulse</h1>
          <button
            className="lang-toggle"
            onClick={toggleLanguage}
            title={t(lang, "settings.language")}
          >
            {lang === "zh" ? "EN" : "中文"}
          </button>
        </div>
        <p className="subtitle">{t(lang, "app.subtitle")}</p>
      </section>

      <section className="panel">
        <div className="quota-header">
          <h2>{t(lang, "section.realtimeQuota")}</h2>
          <button type="button" className="warning-btn" style={{ width: "auto" }} onClick={runManualQuotaCheck} disabled={checkingQuota}>
            {checkingQuota ? t(lang, "button.rechecking") : t(lang, "button.recheckNow")}
          </button>
        </div>
        {quotaCheckMessage ? <p className="meta-text" style={{ marginBottom: "8px" }}>{quotaCheckMessage}</p> : null}
        <div className="quota-grid">
          {(["claude", "cursor"] as ServiceType[]).map((service) => {
            const item = snapshot?.[service];

            if (service === "claude") {
              const windows = item?.windows ?? [];
              const sessionWindow = windows.find((window) => window.key === "session") ?? null;
              const weeklyWindow =
                windows.find((window) => window.key === "weekly_all") ??
                windows.find((window) => window.key === "weekly_scoped") ??
                windows.find((window) => window.key === "weekly") ??
                null;
              const barWindows = [sessionWindow, weeklyWindow].filter((window): window is QuotaWindow => window !== null);

              return (
                <div className="quota-card" key={service}>
                  <div className="quota-header">
                    <strong>{serviceNames[service]}</strong>
                    <span className={`status-tag status-${item?.status || "unknown"}`}>{item?.status || "unknown"}</span>
                  </div>
                  {renderCredentialRow(service)}
                  {barWindows.length ? (
                    <div className="window-bars">
                      {barWindows.map((window) => renderWindowBar(window, item!.unit, service))}
                    </div>
                  ) : (
                    <p className="meta-text" style={{ marginTop: "8px" }}>{item?.message || t(lang, "app.notFetchedYet")}</p>
                  )}
                  {item?.errorCode === "claudeLoginExpired" ? (
                    <div className="callout-warning" style={{ marginTop: "8px" }}>
                      <p style={{ margin: 0 }}>{t(lang, "auth.claude.reloginCta")}</p>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "8px" }}>
                        <code>claude</code>
                        <button
                          type="button"
                          className="warning-btn"
                          style={{ width: "auto" }}
                          onClick={copyClaudeLoginCommand}
                        >
                          {claudeCommandCopied ? t(lang, "auth.claude.copied") : t(lang, "auth.claude.copyCommand")}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            }

            const allWindows = item?.windows ?? [];
            const billingWindow = allWindows.find((window) => window.key === "billing_cycle") ?? null;
            const cursorModelsWindow = allWindows.find((window) => window.key === "cursor_models") ?? null;
            const billingUsed =
              billingWindow && billingWindow.remaining !== null && billingWindow.total !== null
                ? billingWindow.total - billingWindow.remaining
                : null;
            const billingUsedPercent =
              billingWindow?.percent !== null && billingWindow?.percent !== undefined
                ? 100 - billingWindow.percent
                : 0;
            return (
              <div className="quota-card" key={service}>
                <div className="quota-header">
                  <strong>{serviceNames[service]}</strong>
                  <span className={`status-tag status-${item?.status || "unknown"}`}>{item?.status || "unknown"}</span>
                </div>
                {renderCredentialRow(service)}
                {cursorModelsWindow ? (
                  <div className="window-bars" style={{ marginBottom: "12px" }}>
                    {renderUsagePercentBar(cursorModelsWindow, service)}
                  </div>
                ) : null}
                {billingWindow ? (
                  <div className="window-bar" key={`${service}-billing`}>
                    <div className="quota-header" style={{ marginBottom: "6px" }}>
                      <span className="window-bar-label">{billingWindow.label}</span>
                      <span className="meta-text" style={{ margin: 0 }}>
                        {t(lang, "quota.used")} {formatValue(billingUsed, item!.unit)} /{" "}
                        {formatValue(billingWindow.total, item!.unit)}
                      </span>
                    </div>
                    <div className="progress-track">
                      <div
                        className={barClass(service)}
                        style={{ width: `${Math.max(0, Math.min(100, billingUsedPercent))}%` }}
                      />
                    </div>
                    {billingWindow.resetsAt && (
                      <p className="meta-text" style={{ margin: "10px 0 0", color: "#8b949e", fontSize: "12px" }}>
                        {t(lang, "app.liveCountdown", {
                          countdown: formatCountdown(billingWindow.resetsAt, now, lang),
                          resetTime: formatResetText(billingWindow.resetsAt, lang)
                        })}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="meta-text" style={{ marginTop: "8px" }}>{item?.message || t(lang, "app.notFetchedYet")}</p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <h2>{t(lang, "section.settings")}</h2>

        <label className="field switch-row">
          <span>{t(lang, "settings.launchAtLogin")}</span>
          <input
            type="checkbox"
            className="toggle"
            checked={settings.launchAtLogin}
            onChange={(event) => setSettings((prev) => ({ ...prev, launchAtLogin: event.target.checked }))}
          />
        </label>

        {(["cursor", "claude"] as ServiceType[]).map((service) => {
          const thresholdKey: "cursorLowThresholdPercent" | "claudeLowThresholdPercent" =
            service === "cursor" ? "cursorLowThresholdPercent" : "claudeLowThresholdPercent";
          const lowQuotaKey: "enableCursorLowQuotaAlert" | "enableClaudeLowQuotaAlert" =
            service === "cursor" ? "enableCursorLowQuotaAlert" : "enableClaudeLowQuotaAlert";
          const resetKey: "enableCursorResetAlarm" | "enableClaudeResetAlarm" =
            service === "cursor" ? "enableCursorResetAlarm" : "enableClaudeResetAlarm";
          const resetsAt = snapshot?.[service]?.resetsAt ?? null;
          const weeklyResetAt = service === "claude" ? snapshot?.claude.weeklyResetAt ?? null : null;

          return (
            <div className="quota-card service-block" key={service}>
              <div className="quota-header">
                <strong>{serviceNames[service]}</strong>
              </div>

              <label className="field" style={{ marginTop: "10px" }}>
                <span>{t(lang, "settings.lowThreshold", { percent: settings[thresholdKey] })}</span>
                <input
                  type="range"
                  min={5}
                  max={30}
                  step={5}
                  value={settings[thresholdKey]}
                  onChange={(event) =>
                    setSettings((prev) => ({ ...prev, [thresholdKey]: Number(event.target.value) || prev[thresholdKey] }))
                  }
                />
              </label>

              <label className="field switch-row">
                <span>{t(lang, "settings.lowQuota.toggleLabel")}</span>
                <input
                  type="checkbox"
                  className="toggle"
                  checked={settings[lowQuotaKey]}
                  onChange={(event) => setSettings((prev) => ({ ...prev, [lowQuotaKey]: event.target.checked }))}
                />
              </label>

              <label className="field switch-row" style={{ marginTop: "10px" }}>
                <span>{t(lang, "alarm.when.service")}</span>
                <input
                  type="checkbox"
                  className="toggle"
                  checked={settings[resetKey]}
                  onChange={(event) => setSettings((prev) => ({ ...prev, [resetKey]: event.target.checked }))}
                />
              </label>
              {settings[resetKey] && resetsAt && (
                <p className="meta-text" style={{ margin: "2px 0 0", color: "#8b949e", fontSize: "12px" }}>
                  {t(lang, "settings.resetAlarm.nextFire", {
                    countdown: formatCountdown(resetsAt, now, lang),
                    resetTime: formatResetText(resetsAt, lang)
                  })}
                </p>
              )}
              {settings[resetKey] && weeklyResetAt && (
                <p className="meta-text" style={{ margin: "2px 0 0", color: "#8b949e", fontSize: "12px" }}>
                  {t(lang, "settings.resetAlarm.nextFire", {
                    countdown: formatCountdown(weeklyResetAt, now, lang),
                    resetTime: formatResetText(weeklyResetAt, lang)
                  })}
                </p>
              )}
            </div>
          );
        })}

        <div className="quota-card service-block" style={{ marginTop: "12px" }}>
          <label className="field">
            <span>{t(lang, "alarm.catchUp", { minutes: settings.alarmCatchUpMinutes })}</span>
            <input
              type="range"
              min={5}
              max={180}
              step={5}
              value={settings.alarmCatchUpMinutes}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  alarmCatchUpMinutes: Number(event.target.value) || prev.alarmCatchUpMinutes
                }))
              }
            />
          </label>
          <p className="meta-text" style={{ margin: "0 0 8px" }}>{t(lang, "alarm.catchUpHint")}</p>

          <p className="meta-text">
            {alarmStatus?.nextTarget
              ? t(lang, "alarm.nextFire", {
                  countdown: formatCountdown(alarmStatus.nextTarget.fireAt, now, lang),
                  resetTime: formatResetText(alarmStatus.nextTarget.fireAt, lang)
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
                setSettings((prev) => ({ ...prev, enableAlarmPopup: event.target.checked }))
              }
            />
          </label>

          {settings.enableAlarmPopup && (
            <div className="alarm-suboption">
              <label className="field switch-row">
                <span>{t(lang, "alarm.soundToggle")}</span>
                <input
                  type="checkbox"
                  className="toggle"
                  checked={settings.alarmSoundEnabled}
                  onChange={(event) =>
                    setSettings((prev) => ({ ...prev, alarmSoundEnabled: event.target.checked }))
                  }
                />
              </label>

              <label className="field" style={{ marginBottom: 0 }}>
                <span>{t(lang, "alarm.autoDismiss", { minutes: settings.alarmPopupAutoDismissMinutes })}</span>
                <input
                  type="range"
                  min={1}
                  max={30}
                  step={1}
                  value={settings.alarmPopupAutoDismissMinutes}
                  onChange={(event) =>
                    setSettings((prev) => ({
                      ...prev,
                      alarmPopupAutoDismissMinutes: Number(event.target.value) || prev.alarmPopupAutoDismissMinutes
                    }))
                  }
                />
              </label>
            </div>
          )}

          <button
            className="primary-btn"
            style={{ marginTop: "12px" }}
            onClick={confirmAlarmSettings}
            disabled={confirmingAlarm}
          >
            {confirmingAlarm ? t(lang, "alarm.confirming") : t(lang, "alarm.confirm")}
          </button>
          <div className="alarm-actions-row">
            <button type="button" className="warning-btn" onClick={refreshAlarmStatus} disabled={checkingAlarm}>
              {checkingAlarm ? t(lang, "alarm.checking") : t(lang, "alarm.check")}
            </button>
            <button type="button" className="warning-btn" onClick={testAlarmPopup}>
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
          {savingSettings ? t(lang, "button.saving") : t(lang, "button.saveSettings")}
        </button>
      </section>

      <section className="panel">
        <h2>{t(lang, "line.title")}</h2>
        <p className="meta-text" style={{ marginBottom: "10px" }}>{t(lang, "line.desc")}</p>
        <div className="callout-warning">⚠️ {t(lang, "line.clipboardWarning")}</div>
        <p className="meta-text" style={{ margin: "8px 0 12px" }}>{t(lang, "line.pasteHint")}</p>

        <label className="field">
          <span>{t(lang, "line.tokenLabel")}</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t(lang, "line.tokenPlaceholder")}
            value={lineFields.lineChannelAccessToken}
            onPaste={handleSensitivePaste}
            onChange={(event) => {
              setLineFields((prev) => ({ ...prev, lineChannelAccessToken: event.target.value }));
              setLineTokenMessage("");
            }}
          />
        </label>

        <label className="field">
          <span>{t(lang, "line.channelIdLabel")}</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t(lang, "line.channelIdPlaceholder")}
            value={lineFields.lineChannelId}
            onPaste={handleSensitivePaste}
            onChange={(event) => {
              setLineFields((prev) => ({ ...prev, lineChannelId: event.target.value }));
              setLineTokenMessage("");
            }}
          />
        </label>

        <label className="field">
          <span>{t(lang, "line.assertionKidLabel")}</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t(lang, "line.assertionKidPlaceholder")}
            value={lineFields.lineAssertionKid}
            onPaste={handleSensitivePaste}
            onChange={(event) => {
              setLineFields((prev) => ({ ...prev, lineAssertionKid: event.target.value }));
              setLineTokenMessage("");
            }}
          />
        </label>

        <label className="field">
          <span>{t(lang, "line.assertionPrivateKeyLabel")}</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t(lang, "line.assertionPrivateKeyPlaceholder")}
            value={lineFields.lineAssertionPrivateKey}
            onPaste={handleSensitivePaste}
            onChange={(event) => {
              setLineFields((prev) => ({ ...prev, lineAssertionPrivateKey: event.target.value }));
              setLineTokenMessage("");
            }}
          />
        </label>

        <button className="primary-btn" onClick={handleSaveLineCredentials} disabled={savingLineToken}>
          {savingLineToken ? t(lang, "button.saving") : t(lang, "line.save")}
        </button>
        {lineTokenMessage ? <p className="meta-text">{lineTokenMessage}</p> : null}
      </section>

      <section className="panel">
        <button className="danger-btn" onClick={quitApp}>
          {t(lang, "button.quit")}
        </button>
      </section>

      <footer className="panel footer">
        <p className="footer-credit">
          {t(lang, "footer.developer")} · {t(lang, "footer.support")} 程小晨{" "}
          <a
            href={THREADS_URL}
            className="footer-link"
            onClick={(event) => {
              event.preventDefault();
              openThreads();
            }}
          >
            Threads
          </a>
        </p>
      </footer>
    </main>
  );
};
