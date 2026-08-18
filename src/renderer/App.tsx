import { useEffect, useState } from "react";
import type { AppSettings, AuthStatus, CombinedSnapshot, Language, QuotaSnapshot, ServiceType } from "@shared/types";
import { t } from "@shared/i18n";

const defaultSettings: AppSettings = {
  intervalMinutes: 10,
  lowThresholdPercent: 20,
  launchAtLogin: false,
  notifyCooldownMinutes: 15,
  enableResetAlarm: true,
  enableCursorResetAlarm: true,
  enableClaudeResetAlarm: true,
  enableCursorLowQuotaAlert: true,
  enableClaudeLowQuotaAlert: true,
  language: "zh"
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

const formatQuotaLine = (snapshot: QuotaSnapshot): string =>
  `${formatValue(snapshot.remaining, snapshot.unit)} / ${formatValue(snapshot.total, snapshot.unit)}`;

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

const getBarPercent = (snapshot: QuotaSnapshot): number => {
  if (snapshot.percent !== null) {
    return snapshot.percent;
  }
  if (snapshot.unit === "percent" && snapshot.remaining !== null) {
    return Math.max(0, Math.min(100, snapshot.remaining));
  }
  return 0;
};

export const App = () => {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [authStatus, setAuthStatus] = useState<AuthStatus>(defaultAuth);
  const [snapshot, setSnapshot] = useState<CombinedSnapshot | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(false);
  const [message, setMessage] = useState(t(defaultSettings.language, "app.readyMessage"));
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
  };

  useEffect(() => {
    refreshBaseData().catch((error) => {
      setMessage(error instanceof Error ? error.message : t(lang, "app.initFailed"));
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
    intervalMinutes: Math.min(60, Math.max(1, Number(value.intervalMinutes) || 5)),
    lowThresholdPercent: Math.min(99, Math.max(1, Number(value.lowThresholdPercent) || 20)),
    notifyCooldownMinutes: Math.min(240, Math.max(1, Number(value.notifyCooldownMinutes) || 15))
  });

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    setMessage(t(lang, "app.savingSettings"));
    try {
      const next = await window.usagePulse.saveSettings(clampSettings(settings));
      setSettings(next);
      setMessage(t(next.language, "app.settingsSaved"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t(lang, "app.saveFailed"));
    } finally {
      setSavingSettings(false);
    }
  };

  const refreshAuthStatus = async () => {
    setCheckingAuth(true);
    try {
      const nextAuth = await window.usagePulse.getAuthStatus();
      setAuthStatus(nextAuth);
      setMessage(t(lang, "app.authRefreshed"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t(lang, "app.authRefreshFailed"));
    } finally {
      setCheckingAuth(false);
    }
  };

  const runManualCheck = async () => {
    setChecking(true);
    setMessage(t(lang, "app.checking"));
    try {
      const result = await window.usagePulse.runManualCheck();
      setSnapshot(result.snapshot);
      setMessage(t(lang, "app.checkComplete", { reason: result.reason }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t(lang, "app.checkFailed"));
    } finally {
      setChecking(false);
    }
  };

  const quitApp = async () => {
    setMessage(t(lang, "app.quitting"));
    try {
      await window.usagePulse.quitApp();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t(lang, "app.quitFailed"));
    }
  };

  const toggleLanguage = async () => {
    const nextLang: Language = lang === "zh" ? "en" : "zh";
    setSettings((prev) => ({ ...prev, language: nextLang }));
    try {
      const next = await window.usagePulse.saveSettings(clampSettings({ ...settings, language: nextLang }));
      setSettings(next);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t(nextLang, "app.saveFailed"));
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
          {(["cursor", "claude"] as ServiceType[]).map((service) => {
            const item = snapshot?.[service];
            const percent = item ? getBarPercent(item) : 0;
            return (
              <div className="quota-card" key={service}>
                <div className="quota-header">
                  <strong>{serviceNames[service]}</strong>
                  <span className={`status-tag status-${item?.status || "unknown"}`}>{item?.status || "unknown"}</span>
                </div>
                <div className="quota-value">
                  {item ? formatQuotaLine(item) : t(lang, "app.naSlashNa")}
                </div>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${percent}%` }} />
                </div>
                {item?.windows?.length ? (
                  <div className="window-list">
                    {item.windows.map((window) => (
                      <div key={`${service}-${window.key}`} style={{ marginBottom: "8px" }}>
                        <p className="meta-text" style={{ marginBottom: "4px" }}>
                          {window.label}：{formatValue(window.remaining, item.unit)} /{" "}
                          {formatValue(window.total, item.unit)}
                        </p>
                        {window.resetsAt && (
                          <p className="meta-text" style={{ margin: "0", color: "#8b949e", fontSize: "12px" }}>
                            {t(lang, "app.liveCountdown", {
                              countdown: formatCountdown(window.resetsAt, now, lang),
                              resetTime: formatResetText(window.resetsAt, lang)
                            })}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                ) : null}
                <p className="meta-text" style={{ marginTop: "8px" }}>{item?.message || t(lang, "app.notFetchedYet")}</p>
              </div>
            );
          })}
        </div>
        <button className="primary-btn" onClick={runManualCheck} disabled={checking}>
          {checking ? t(lang, "button.checking") : t(lang, "button.manualCheck")}
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
      </section>

      <section className="panel">
        <h2>{t(lang, "section.settings")}</h2>
        <label className="field">
          <span>{t(lang, "settings.checkInterval", { minutes: settings.intervalMinutes })}</span>
          <input
            type="range"
            min={1}
            max={60}
            value={settings.intervalMinutes}
            onChange={(event) =>
              setSettings((prev) => ({ ...prev, intervalMinutes: Number(event.target.value) || prev.intervalMinutes }))
            }
          />
        </label>

        <label className="field">
          <span>{t(lang, "settings.lowThreshold", { percent: settings.lowThresholdPercent })}</span>
          <input
            type="range"
            min={1}
            max={99}
            value={settings.lowThresholdPercent}
            onChange={(event) =>
              setSettings((prev) => ({
                ...prev,
                lowThresholdPercent: Number(event.target.value) || prev.lowThresholdPercent
              }))
            }
          />
        </label>

        <label className="field">
          <span>{t(lang, "settings.notifyCooldown")}</span>
          <input
            type="number"
            min={1}
            max={240}
            value={settings.notifyCooldownMinutes}
            onChange={(event) =>
              setSettings((prev) => ({
                ...prev,
                notifyCooldownMinutes: Number(event.target.value) || prev.notifyCooldownMinutes
              }))
            }
          />
        </label>

        <label className="field switch-row">
          <span>{t(lang, "settings.launchAtLogin")}</span>
          <input
            type="checkbox"
            checked={settings.launchAtLogin}
            onChange={(event) => setSettings((prev) => ({ ...prev, launchAtLogin: event.target.checked }))}
          />
        </label>

        <h3 style={{ marginTop: "16px", marginBottom: "8px", fontSize: "16px", color: "#e1e4e8" }}>
          {t(lang, "settings.resetAlarm.title")}
        </h3>
        <p className="meta-text" style={{ marginBottom: "10px" }}>
          {t(lang, "settings.resetAlarm.desc")}
        </p>
        <label className="field switch-row">
          <span>{t(lang, "settings.resetAlarm.enable")}</span>
          <input
            type="checkbox"
            checked={settings.enableResetAlarm}
            onChange={(event) => setSettings((prev) => ({ ...prev, enableResetAlarm: event.target.checked }))}
          />
        </label>
        <label className="field switch-row" style={{ paddingLeft: "20px", opacity: settings.enableResetAlarm ? 1 : 0.5 }}>
          <span>{t(lang, "settings.resetAlarm.cursor")}</span>
          <input
            type="checkbox"
            disabled={!settings.enableResetAlarm}
            checked={settings.enableCursorResetAlarm}
            onChange={(event) => setSettings((prev) => ({ ...prev, enableCursorResetAlarm: event.target.checked }))}
          />
        </label>
        <label className="field switch-row" style={{ paddingLeft: "20px", opacity: settings.enableResetAlarm ? 1 : 0.5 }}>
          <span>{t(lang, "settings.resetAlarm.claude")}</span>
          <input
            type="checkbox"
            disabled={!settings.enableResetAlarm}
            checked={settings.enableClaudeResetAlarm}
            onChange={(event) => setSettings((prev) => ({ ...prev, enableClaudeResetAlarm: event.target.checked }))}
          />
        </label>

        <h3 style={{ marginTop: "16px", marginBottom: "8px", fontSize: "16px", color: "#e1e4e8" }}>
          {t(lang, "settings.lowQuota.title")}
        </h3>
        <label className="field switch-row">
          <span>{t(lang, "settings.lowQuota.cursor")}</span>
          <input
            type="checkbox"
            checked={settings.enableCursorLowQuotaAlert}
            onChange={(event) => setSettings((prev) => ({ ...prev, enableCursorLowQuotaAlert: event.target.checked }))}
          />
        </label>
        <label className="field switch-row">
          <span>{t(lang, "settings.lowQuota.claude")}</span>
          <input
            type="checkbox"
            checked={settings.enableClaudeLowQuotaAlert}
            onChange={(event) => setSettings((prev) => ({ ...prev, enableClaudeLowQuotaAlert: event.target.checked }))}
          />
        </label>
        <div style={{ marginBottom: "16px" }} />

        <button className="primary-btn" onClick={handleSaveSettings} disabled={savingSettings}>
          {savingSettings ? t(lang, "button.saving") : t(lang, "button.saveSettings")}
        </button>
        <button style={{ width: "100%", marginTop: "8px" }} onClick={quitApp}>
          {t(lang, "button.quit")}
        </button>
      </section>

      <footer className="panel footer">
        <p>{message}</p>
      </footer>
    </main>
  );
};
