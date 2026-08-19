import { useEffect, useState } from "react";
import type {
  AppSettings,
  AuthStatus,
  CombinedSnapshot,
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
  lineChannelAccessToken: "",
  lineChannelId: "",
  lineAssertionKid: "",
  lineAssertionPrivateKey: ""
};

const defaultAuth: AuthStatus = {
  cursor: false,
  claude: false
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
  const [checkingAuth, setCheckingAuth] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [lineFields, setLineFields] = useState({
    lineChannelAccessToken: "",
    lineChannelId: "",
    lineAssertionKid: "",
    lineAssertionPrivateKey: ""
  });
  const [savingLineToken, setSavingLineToken] = useState(false);
  const [lineTokenMessage, setLineTokenMessage] = useState("");
  const [now, setNow] = useState<number>(Date.now());
  const lang = settings.language;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const refreshBaseData = async () => {
    const [nextSettings, nextAuthStatus, latestSnapshot] = await Promise.all([
      window.usagePulse.getSettings(),
      window.usagePulse.getAuthStatus(),
      window.usagePulse.getLatestSnapshot()
    ]);
    setSettings(nextSettings);
    setAuthStatus(nextAuthStatus);
    setSnapshot(latestSnapshot);
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

    const unsubscribe = window.usagePulse.onSnapshotUpdated((nextSnapshot) => {
      setSnapshot(nextSnapshot);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const clampSettings = (value: AppSettings): AppSettings => ({
    ...value,
    cursorIntervalMinutes: roundToStep(value.cursorIntervalMinutes, 5, 60, 5, 10),
    claudeIntervalMinutes: roundToStep(value.claudeIntervalMinutes, 5, 60, 5, 10),
    cursorLowThresholdPercent: roundToStep(value.cursorLowThresholdPercent, 5, 30, 5, 20),
    claudeLowThresholdPercent: roundToStep(value.claudeLowThresholdPercent, 5, 30, 5, 20),
    notifyCooldownMinutes: roundToStep(value.notifyCooldownMinutes, 5, 240, 5, 15)
  });

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      const next = await window.usagePulse.saveSettings(clampSettings(settings));
      setSettings(next);
    } catch (error) {
      console.error(error);
    } finally {
      setSavingSettings(false);
    }
  };

  const refreshAuthStatus = async () => {
    setCheckingAuth(true);
    try {
      const nextAuth = await window.usagePulse.getAuthStatus();
      setAuthStatus(nextAuth);
      setAuthMessage(t(lang, "app.authRefreshed"));
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : t(lang, "app.authRefreshFailed"));
    } finally {
      setCheckingAuth(false);
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

  const openClockApp = async () => {
    try {
      await window.usagePulse.openClockApp();
    } catch (error) {
      const isUnsupported = error instanceof Error && error.message.includes("macOS-only");
      console.error(t(lang, isUnsupported ? "settings.resetAlarm.openClockUnsupported" : "settings.resetAlarm.openClockFailed"));
    }
  };

  const renderUsagePercentBar = (window: QuotaWindow, isLow = false) => (
    <div className="window-bar" key={window.key}>
      <div className="quota-header" style={{ marginBottom: "6px" }}>
        <span className="window-bar-label">{window.label}</span>
        <span className="meta-text" style={{ margin: 0 }}>
          {t(lang, "window.usagePercent", { percent: Math.round(window.percent ?? 0) })}
        </span>
      </div>
      <div className="progress-track">
        <div
          className={`progress-fill${isLow ? " progress-fill-warning" : ""}`}
          style={{ width: `${Math.max(0, Math.min(100, window.percent ?? 0))}%` }}
        />
      </div>
      {window.message && (
        <p className="meta-text" style={{ margin: "6px 0 0" }}>{window.message}</p>
      )}
    </div>
  );

  const renderWindowBar = (window: QuotaWindow, unit: QuotaSnapshot["unit"], isLow = false) => (
    <div className="window-bar" key={window.key}>
      <div className="quota-header" style={{ marginBottom: "6px" }}>
        <span className="window-bar-label">{window.label}</span>
        <span className="meta-text" style={{ margin: 0 }}>
          {t(lang, "quota.remaining")} {formatValue(window.remaining, unit)} / {formatValue(window.total, unit)}
        </span>
      </div>
      <div className="progress-track">
        <div
          className={`progress-fill${isLow ? " progress-fill-warning" : ""}`}
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
        <h2>{t(lang, "section.realtimeQuota")}</h2>
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
                  {barWindows.length ? (
                    <div className="window-bars">
                      {barWindows.map((window) => renderWindowBar(window, item!.unit, item?.status === "low"))}
                    </div>
                  ) : (
                    <p className="meta-text" style={{ marginTop: "8px" }}>{t(lang, "app.notFetchedYet")}</p>
                  )}
                </div>
              );
            }

            const allWindows = item?.windows ?? [];
            const billingWindow = allWindows.find((window) => window.key === "billing_cycle") ?? null;
            const cursorModelsWindow = allWindows.find((window) => window.key === "cursor_models") ?? null;
            const isLow = item?.status === "low";
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
                {cursorModelsWindow ? (
                  <div className="window-bars" style={{ marginBottom: "12px" }}>
                    {renderUsagePercentBar(cursorModelsWindow, isLow)}
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
                        className={`progress-fill${isLow ? " progress-fill-warning" : ""}`}
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

              <label className="field switch-row">
                <span>{t(lang, "settings.resetAlarm.toggleLabel")}</span>
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

        <button
          className="primary-btn"
          style={{ marginTop: "16px" }}
          onClick={handleSaveSettings}
          disabled={savingSettings}
        >
          {savingSettings ? t(lang, "button.saving") : t(lang, "button.saveSettings")}
        </button>
        <button type="button" className="warning-btn" style={{ marginTop: "8px" }} onClick={openClockApp}>
          {t(lang, "settings.resetAlarm.openClock")}
        </button>
      </section>

      <section className="panel">
        <h2>{t(lang, "section.credentialDetection")}</h2>
        <div className="auth-list">
          {(["cursor", "claude"] as ServiceType[]).map((service) => (
            <div className="auth-card" key={service}>
              <div>
                <strong>{serviceNames[service]}</strong>
                <p className="meta-text">{authStatus[service] ? t(lang, "auth.detected") : t(lang, "auth.notDetected")}</p>
                {!authStatus[service] ? <p className="meta-text">{t(lang, authHintKeys[service])}</p> : null}
              </div>
            </div>
          ))}
        </div>
        <button className="primary-btn" onClick={refreshAuthStatus} disabled={checkingAuth}>
          {checkingAuth ? t(lang, "button.detecting") : t(lang, "button.redetect")}
        </button>
        {authMessage ? <p className="meta-text">{authMessage}</p> : null}

        <h3 className="subsection-title" style={{ marginTop: "20px" }}>
          {t(lang, "line.title")}
        </h3>
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
