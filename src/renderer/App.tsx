import { useEffect, useMemo, useState } from "react";
import type { AppSettings, AuthStatus, CombinedSnapshot, QuotaSnapshot, ServiceType } from "@shared/types";

const defaultSettings: AppSettings = {
  intervalMinutes: 5,
  lowThresholdPercent: 20,
  lineChannelToken: "",
  enableLineNotify: false,
  launchAtLogin: false,
  notifyCooldownMinutes: 15,
  enableResetAlarm: true,
  enableLowQuotaAlarm: true,
  enableResetAlarmLine: false,
  enableLowQuotaAlarmLine: false
};

const defaultAuth: AuthStatus = {
  cursor: false,
  claude: false
};

const serviceNames: Record<ServiceType, string> = {
  cursor: "Cursor",
  claude: "Claude Code"
};

const authHints: Record<ServiceType, string> = {
  cursor: "請先在 Cursor Desktop 登入後再檢查。",
  claude: "請在終端機執行 claude 登入（或設定 CLAUDE_CODE_OAUTH_TOKEN）。"
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

const formatResetText = (iso: string | null): string => {
  if (!iso) {
    return "未知";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "未知";
  }
  return date.toLocaleString();
};

const formatCountdown = (iso: string | null, now: number): string => {
  if (!iso) return "未知";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "未知";
  
  const diff = date.getTime() - now;
  if (diff <= 0) return "已重置";

  const seconds = Math.floor(diff / 1000) % 60;
  const minutes = Math.floor(diff / 60000) % 60;
  const hours = Math.floor(diff / 3600000) % 24;
  const days = Math.floor(diff / 86400000);

  if (days > 0) return `${days} 天 ${hours} 小時 ${minutes} 分鐘`;
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
  const [alarmSyncStatus, setAlarmSyncStatus] = useState<string>("unknown");
  const [message, setMessage] = useState("準備就緒");
  const [now, setNow] = useState<number>(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const refreshBaseData = async () => {
    const [nextSettings, nextAuthStatus, latestSnapshot, alarmStatus] = await Promise.all([
      window.usagePulse.getSettings(),
      window.usagePulse.getAuthStatus(),
      window.usagePulse.getLatestSnapshot(),
      window.usagePulse.getAlarmSyncStatus()
    ]);
    setSettings(nextSettings);
    setAuthStatus(nextAuthStatus);
    setSnapshot(latestSnapshot);
    setAlarmSyncStatus(alarmStatus);
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

  const refreshAuthStatus = async () => {
    setCheckingAuth(true);
    try {
      const nextAuth = await window.usagePulse.getAuthStatus();
      setAuthStatus(nextAuth);
      setMessage("本機憑證狀態已更新");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "重新偵測憑證失敗");
    } finally {
      setCheckingAuth(false);
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
        <p className="subtitle">跨平台配額監控工具（Cursor / Claude Code）</p>
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
                  {item ? formatQuotaLine(item) : "N/A / N/A"}
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
                            即時倒數：{formatCountdown(window.resetsAt, now)} ({formatResetText(window.resetsAt)})
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                ) : null}
                {service === "claude" && (
                  <p className="meta-text" style={{ marginTop: "8px", fontSize: "12px" }}>
                    系統鬧鐘狀態：
                    {alarmSyncStatus === "synced" ? "已同步" : 
                     alarmSyncStatus === "no-shortcuts" ? "捷徑未安裝" : 
                     alarmSyncStatus === "unsupported" ? "不支援" : "未知"}
                  </p>
                )}
                <p className="meta-text" style={{ marginTop: "8px" }}>{item?.message || "尚未抓取資料"}</p>
              </div>
            );
          })}
        </div>
        <button className="primary-btn" onClick={runManualCheck} disabled={checking}>
          {checking ? "檢查中..." : "立即手動檢查"}
        </button>
      </section>

      <section className="panel">
        <h2>本機憑證偵測</h2>
        <div className="auth-list">
          {(["cursor", "claude"] as ServiceType[]).map((service) => (
            <div className="auth-card" key={service}>
              <div>
                <strong>{serviceNames[service]}</strong>
                <p className="meta-text">{authStatus[service] ? "已偵測到可用憑證" : "尚未偵測到憑證"}</p>
                {!authStatus[service] ? <p className="meta-text">{authHints[service]}</p> : null}
              </div>
            </div>
          ))}
        </div>
        <button className="primary-btn" onClick={refreshAuthStatus} disabled={checkingAuth}>
          {checkingAuth ? "偵測中..." : "重新偵測憑證"}
        </button>
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

        <h3 style={{ marginTop: "16px", marginBottom: "8px", fontSize: "16px", color: "#e1e4e8" }}>鬧鐘設定 (Claude Code)</h3>
        {alarmSyncStatus === "no-shortcuts" && (
          <p className="warning-text">
            ⚠️ 偵測到 macOS 尚未安裝「Usage-Pulse Update Alarm」捷徑。<br/>
            重置鬧鐘將無法同步至系統「時鐘」App。<br/>
            請建立一個捷徑，名稱命名為 <strong>Usage-Pulse Update Alarm</strong>，
            並接收文字作為輸入。
          </p>
        )}
        <label className="field switch-row">
          <span>啟用「配額重置」桌面鬧鐘</span>
          <input
            type="checkbox"
            checked={settings.enableResetAlarm}
            onChange={(event) => setSettings((prev) => ({ ...prev, enableResetAlarm: event.target.checked }))}
          />
        </label>
        <label className="field switch-row" style={{ paddingLeft: "20px", opacity: settings.enableResetAlarm ? 1 : 0.5 }}>
          <span>└ 鬧鐘響時，同時送出 LINE 推播</span>
          <input
            type="checkbox"
            disabled={!settings.enableResetAlarm}
            checked={settings.enableResetAlarmLine}
            onChange={(event) => setSettings((prev) => ({ ...prev, enableResetAlarmLine: event.target.checked }))}
          />
        </label>

        <label className="field switch-row">
          <span>啟用「低額度」桌面鬧鐘</span>
          <input
            type="checkbox"
            checked={settings.enableLowQuotaAlarm}
            onChange={(event) => setSettings((prev) => ({ ...prev, enableLowQuotaAlarm: event.target.checked }))}
          />
        </label>
        <label className="field switch-row" style={{ paddingLeft: "20px", opacity: settings.enableLowQuotaAlarm ? 1 : 0.5 }}>
          <span>└ 鬧鐘響時，同時送出 LINE 推播</span>
          <input
            type="checkbox"
            disabled={!settings.enableLowQuotaAlarm}
            checked={settings.enableLowQuotaAlarmLine}
            onChange={(event) => setSettings((prev) => ({ ...prev, enableLowQuotaAlarmLine: event.target.checked }))}
          />
        </label>
        <div style={{ marginBottom: "16px" }} />

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
