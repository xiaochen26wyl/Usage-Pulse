import { useEffect, useMemo, useState } from "react";
import type { AppSettings, AuthStatus, CombinedSnapshot, QuotaSnapshot, ServiceType } from "@shared/types";

const defaultSettings: AppSettings = {
  intervalMinutes: 5,
  lowThresholdPercent: 20,
  lineChannelToken: "",
  enableLineNotify: false,
  launchAtLogin: false,
  notifyCooldownMinutes: 15
};

const defaultAuth: AuthStatus = {
  cursor: false,
  claude: false
};

const serviceNames: Record<ServiceType, string> = {
  cursor: "Cursor",
  claude: "Claude"
};

const toDisplay = (value: number | null): string => (value === null ? "N/A" : `${value}`);

const getBarPercent = (snapshot: QuotaSnapshot): number => {
  if (snapshot.percent !== null) {
    return snapshot.percent;
  }
  if (snapshot.remaining === null) {
    return 0;
  }
  return Math.min(100, Math.max(0, snapshot.remaining * 10));
};

export const App = () => {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [authStatus, setAuthStatus] = useState<AuthStatus>(defaultAuth);
  const [snapshot, setSnapshot] = useState<CombinedSnapshot | null>(null);
  const [busyService, setBusyService] = useState<ServiceType | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState("準備就緒");

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
      setMessage(error instanceof Error ? error.message : "初始化失敗");
    });

    const unsubscribe = window.usagePulse.onSnapshotUpdated((nextSnapshot) => {
      setSnapshot(nextSnapshot);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    setMessage("儲存設定中...");
    try {
      const next = await window.usagePulse.saveSettings({
        ...settings,
        intervalMinutes: Math.min(60, Math.max(1, Number(settings.intervalMinutes) || 5)),
        lowThresholdPercent: Math.min(99, Math.max(1, Number(settings.lowThresholdPercent) || 20)),
        notifyCooldownMinutes: Math.min(240, Math.max(1, Number(settings.notifyCooldownMinutes) || 15))
      });
      setSettings(next);
      setMessage("設定已儲存");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "儲存失敗");
    } finally {
      setSavingSettings(false);
    }
  };

  const handleLogin = async (service: ServiceType) => {
    setBusyService(service);
    setMessage(`開啟 ${serviceNames[service]} 登入視窗...`);
    try {
      await window.usagePulse.openLoginWindow(service);
      setMessage(`已開啟 ${serviceNames[service]} 登入視窗，請登入後按下「保存 Session」`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "開啟登入失敗");
    } finally {
      setBusyService(null);
    }
  };

  const handleSaveSession = async (service: ServiceType) => {
    setBusyService(service);
    setMessage(`保存 ${serviceNames[service]} Session 中...`);
    try {
      await window.usagePulse.saveLoginSession(service);
      const nextAuth = await window.usagePulse.getAuthStatus();
      setAuthStatus(nextAuth);
      setMessage(`${serviceNames[service]} Session 已保存`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存 Session 失敗");
    } finally {
      setBusyService(null);
    }
  };

  const handleClearSession = async (service: ServiceType) => {
    setBusyService(service);
    try {
      await window.usagePulse.clearLoginSession(service);
      const nextAuth = await window.usagePulse.getAuthStatus();
      setAuthStatus(nextAuth);
      setMessage(`${serviceNames[service]} Session 已清除`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "清除 Session 失敗");
    } finally {
      setBusyService(null);
    }
  };

  const runManualCheck = async () => {
    setChecking(true);
    setMessage("正在手動檢查...");
    try {
      const result = await window.usagePulse.runManualCheck();
      setSnapshot(result.snapshot);
      setMessage(`檢查完成：${result.reason}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "手動檢查失敗");
    } finally {
      setChecking(false);
    }
  };

  const hasLineToken = useMemo(() => settings.lineChannelToken.trim().length > 0, [settings.lineChannelToken]);

  return (
    <main className="app">
      <section className="panel">
        <h1>Usage-Pulse</h1>
        <p className="subtitle">跨平台配額監控工具（Cursor / Claude）</p>
      </section>

      <section className="panel">
        <h2>即時配額</h2>
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
                  {toDisplay(item?.remaining ?? null)} / {toDisplay(item?.total ?? null)}
                </div>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${percent}%` }} />
                </div>
                <p className="meta-text">{item?.message || "尚未抓取資料"}</p>
              </div>
            );
          })}
        </div>
        <button className="primary-btn" onClick={runManualCheck} disabled={checking}>
          {checking ? "檢查中..." : "立即手動檢查"}
        </button>
      </section>

      <section className="panel">
        <h2>Session 登入管理</h2>
        <div className="auth-list">
          {(["cursor", "claude"] as ServiceType[]).map((service) => (
            <div className="auth-card" key={service}>
              <div>
                <strong>{serviceNames[service]}</strong>
                <p className="meta-text">{authStatus[service] ? "已保存 Session" : "尚未保存 Session"}</p>
              </div>
              <div className="auth-actions">
                <button onClick={() => handleLogin(service)} disabled={busyService === service}>
                  登入視窗
                </button>
                <button onClick={() => handleSaveSession(service)} disabled={busyService === service}>
                  保存 Session
                </button>
                <button onClick={() => handleClearSession(service)} disabled={busyService === service}>
                  清除
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>設定</h2>
        <label className="field">
          <span>LINE Channel Access Token</span>
          <input
            type="password"
            value={settings.lineChannelToken}
            onChange={(event) => setSettings((prev) => ({ ...prev, lineChannelToken: event.target.value }))}
            placeholder="輸入 LINE Messaging API Token"
          />
        </label>

        <label className="field switch-row">
          <span>啟用 LINE 推播</span>
          <input
            type="checkbox"
            checked={settings.enableLineNotify}
            onChange={(event) => setSettings((prev) => ({ ...prev, enableLineNotify: event.target.checked }))}
          />
        </label>
        {!hasLineToken && settings.enableLineNotify ? (
          <p className="warning-text">尚未輸入 Token，無法送出 LINE 推播。</p>
        ) : null}

        <label className="field">
          <span>檢查頻率：{settings.intervalMinutes} 分鐘</span>
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
          <span>低額度預警閾值：{settings.lowThresholdPercent}%</span>
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
          <span>通知冷卻時間（分鐘）</span>
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
          <span>開機自動啟動</span>
          <input
            type="checkbox"
            checked={settings.launchAtLogin}
            onChange={(event) => setSettings((prev) => ({ ...prev, launchAtLogin: event.target.checked }))}
          />
        </label>

        <button className="primary-btn" onClick={handleSaveSettings} disabled={savingSettings}>
          {savingSettings ? "儲存中..." : "儲存設定"}
        </button>
      </section>

      <footer className="panel footer">
        <p>{message}</p>
      </footer>
    </main>
  );
};
