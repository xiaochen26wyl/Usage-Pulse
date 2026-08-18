import type { Language } from "@shared/types";

const zh = {
  "app.subtitle": "跨平台配額監控工具（Cursor / Claude Code）",
  "app.readyMessage": "準備就緒",
  "app.initFailed": "初始化失敗",
  "app.savingSettings": "儲存設定中...",
  "app.settingsSaved": "設定已儲存",
  "app.saveFailed": "儲存失敗",
  "app.authRefreshed": "本機憑證狀態已更新",
  "app.authRefreshFailed": "重新偵測憑證失敗",
  "app.checking": "正在手動檢查...",
  "app.checkComplete": "檢查完成：{reason}",
  "app.checkFailed": "手動檢查失敗",
  "app.quitting": "正在結束 Usage-Pulse...",
  "app.quitFailed": "結束程式失敗",
  "app.naSlashNa": "N/A / N/A",
  "app.notFetchedYet": "尚未抓取資料",
  "app.unknown": "未知",
  "app.alreadyReset": "已重置",
  "app.countdown.days": "{days} 天 {hours} 小時 {minutes} 分鐘",
  "app.liveCountdown": "即時倒數：{countdown} ({resetTime})",

  "section.realtimeQuota": "即時配額",
  "section.credentialDetection": "本機憑證偵測",
  "section.settings": "設定",

  "button.manualCheck": "立即手動檢查",
  "button.checking": "檢查中...",
  "button.redetect": "重新偵測憑證",
  "button.detecting": "偵測中...",
  "button.saveSettings": "儲存設定",
  "button.saving": "儲存中...",
  "button.quit": "結束 Usage-Pulse",

  "auth.detected": "已偵測到可用憑證",
  "auth.notDetected": "尚未偵測到憑證",
  "auth.hint.cursor": "請先在 Cursor Desktop 登入後再檢查。",
  "auth.hint.claude": "請在終端機執行 claude 登入（或設定 CLAUDE_CODE_OAUTH_TOKEN）。",

  "settings.checkInterval": "檢查頻率：{minutes} 分鐘",
  "settings.lowThreshold": "低額度預警閾值：{percent}%",
  "settings.notifyCooldown": "通知冷卻時間（分鐘）",
  "settings.launchAtLogin": "開機自動啟動",
  "settings.language": "語言",
  "settings.resetAlarm.title": "重置提醒",
  "settings.resetAlarm.desc": "只使用內建桌面通知，不需要額外下載工具；提醒在程式執行中生效。",
  "settings.resetAlarm.enable": "啟用重置提醒",
  "settings.resetAlarm.cursor": "└ Cursor 重置提醒",
  "settings.resetAlarm.claude": "└ Claude Code 重置提醒",
  "settings.lowQuota.title": "低額度通知",
  "settings.lowQuota.cursor": "Cursor 低額度通知",
  "settings.lowQuota.claude": "Claude Code 低額度通知",

  "window.label.billingCycle": "本期 included usage",
  "window.label.session": "5 小時視窗",
  "window.label.weeklyAll": "每週總配額",
  "window.label.weeklyScoped": "每週模型配額",
  "window.label.weekly": "每週配額",
  "window.message.cursorSource": "資料來源：Cursor DashboardService",
  "window.message.claudeSource": "資料來源：Claude Code OAuth Usage API",

  "fallback.billingCycle": "計費週期",

  "error.cursorLoginExpired": "Cursor 登入已失效，請先重新登入 Cursor Desktop。",
  "error.cursorApiFailed": "Cursor 用量 API 請求失敗。",
  "error.cursorMissingFields": "Cursor 回應缺少可用的配額欄位。",
  "error.claudeLoginExpired": "Claude Code 登入已失效，請先在終端機執行 claude 重新登入。",
  "error.claudeRateLimited": "Claude Code 用量 API 暫時限流，請稍後再試。",
  "error.claudeApiFailed": "Claude Code 用量 API 請求失敗。",
  "error.claudeMissingFields": "Claude Code 回應缺少可解析的配額欄位。",

  "message.cursorSummary": "Cursor included usage 剩餘 {remaining} / {total}{suffix}",
  "message.cursorUsedSuffix": "（已用 {percent}%）",
  "message.claudeSummary": "Claude Code 配額剩餘：5h {session}｜週 {weekly}",

  "scrape.fetchFailed": "{service} 抓取失敗: {detail}",
  "scrape.unknownError": "未知錯誤",

  "reason.changedAndLow": "配額變化，且 {labels} 進入低額度預警",
  "reason.low": "{labels} 進入低額度預警",
  "reason.changed": "配額數值發生變化",
  "reason.noChange": "無變化",
  "reason.checkInProgress": "檢查作業執行中",
  "error.checkInProgressNoSnapshot": "目前有檢查作業執行中，且尚未有可用快照。",
  "reason.resetFired": "{service} {label} 已到重置時間",
  "reason.lowQuotaNotify": "{service} 額度低於 {threshold}%",

  "notification.title": "Usage-Pulse 配額通知",

  "tray.menu.open": "打開 Usage-Pulse",
  "tray.menu.quit": "結束 Usage-Pulse",
  "tray.tooltip.noData": "Usage-Pulse\n尚未抓取到配額資料",
  "tray.tooltip.claudeReset": "Claude 重置: {time}",
  "tray.tooltip.updated": "更新: {time}"
};

const en: Record<keyof typeof zh, string> = {
  "app.subtitle": "Cross-platform quota monitor (Cursor / Claude Code)",
  "app.readyMessage": "Ready",
  "app.initFailed": "Initialization failed",
  "app.savingSettings": "Saving settings...",
  "app.settingsSaved": "Settings saved",
  "app.saveFailed": "Save failed",
  "app.authRefreshed": "Local credential status updated",
  "app.authRefreshFailed": "Failed to re-detect credentials",
  "app.checking": "Checking manually...",
  "app.checkComplete": "Check complete: {reason}",
  "app.checkFailed": "Manual check failed",
  "app.quitting": "Quitting Usage-Pulse...",
  "app.quitFailed": "Failed to quit",
  "app.naSlashNa": "N/A / N/A",
  "app.notFetchedYet": "No data fetched yet",
  "app.unknown": "Unknown",
  "app.alreadyReset": "Already reset",
  "app.countdown.days": "{days}d {hours}h {minutes}m",
  "app.liveCountdown": "Live countdown: {countdown} ({resetTime})",

  "section.realtimeQuota": "Real-time Quota",
  "section.credentialDetection": "Local Credential Detection",
  "section.settings": "Settings",

  "button.manualCheck": "Check Now",
  "button.checking": "Checking...",
  "button.redetect": "Re-detect Credentials",
  "button.detecting": "Detecting...",
  "button.saveSettings": "Save Settings",
  "button.saving": "Saving...",
  "button.quit": "Quit Usage-Pulse",

  "auth.detected": "Credentials detected",
  "auth.notDetected": "No credentials detected",
  "auth.hint.cursor": "Please log in to Cursor Desktop first.",
  "auth.hint.claude": "Run `claude` login in your terminal (or set CLAUDE_CODE_OAUTH_TOKEN).",

  "settings.checkInterval": "Check interval: {minutes} min",
  "settings.lowThreshold": "Low quota alert threshold: {percent}%",
  "settings.notifyCooldown": "Notification cooldown (minutes)",
  "settings.launchAtLogin": "Launch at login",
  "settings.language": "Language",
  "settings.resetAlarm.title": "Reset Alerts",
  "settings.resetAlarm.desc": "Uses built-in desktop notifications only — no extra tools needed; alerts fire while the app is running.",
  "settings.resetAlarm.enable": "Enable reset alerts",
  "settings.resetAlarm.cursor": "└ Cursor reset alert",
  "settings.resetAlarm.claude": "└ Claude Code reset alert",
  "settings.lowQuota.title": "Low Quota Alerts",
  "settings.lowQuota.cursor": "Cursor low quota alert",
  "settings.lowQuota.claude": "Claude Code low quota alert",

  "window.label.billingCycle": "Current period included usage",
  "window.label.session": "5-hour window",
  "window.label.weeklyAll": "Weekly total quota",
  "window.label.weeklyScoped": "Weekly model quota",
  "window.label.weekly": "Weekly quota",
  "window.message.cursorSource": "Data source: Cursor DashboardService",
  "window.message.claudeSource": "Data source: Claude Code OAuth Usage API",

  "fallback.billingCycle": "Billing cycle",

  "error.cursorLoginExpired": "Cursor login has expired. Please log in to Cursor Desktop again.",
  "error.cursorApiFailed": "Cursor usage API request failed.",
  "error.cursorMissingFields": "Cursor response is missing usable quota fields.",
  "error.claudeLoginExpired": "Claude Code login has expired. Please run `claude` login again in your terminal.",
  "error.claudeRateLimited": "Claude Code usage API is temporarily rate-limited. Please try again later.",
  "error.claudeApiFailed": "Claude Code usage API request failed.",
  "error.claudeMissingFields": "Claude Code response has no parsable quota fields.",

  "message.cursorSummary": "Cursor included usage remaining {remaining} / {total}{suffix}",
  "message.cursorUsedSuffix": " (used {percent}%)",
  "message.claudeSummary": "Claude Code quota remaining: 5h {session} | Weekly {weekly}",

  "scrape.fetchFailed": "{service} fetch failed: {detail}",
  "scrape.unknownError": "unknown error",

  "reason.changedAndLow": "Quota changed, and {labels} entered low-quota alert",
  "reason.low": "{labels} entered low-quota alert",
  "reason.changed": "Quota values changed",
  "reason.noChange": "No change",
  "reason.checkInProgress": "A check is already running",
  "error.checkInProgressNoSnapshot": "A check is already running and no snapshot is available yet.",
  "reason.resetFired": "{service} {label} reset time reached",
  "reason.lowQuotaNotify": "{service} quota is below {threshold}%",

  "notification.title": "Usage-Pulse Quota Alert",

  "tray.menu.open": "Open Usage-Pulse",
  "tray.menu.quit": "Quit Usage-Pulse",
  "tray.tooltip.noData": "Usage-Pulse\nNo quota data fetched yet",
  "tray.tooltip.claudeReset": "Claude reset: {time}",
  "tray.tooltip.updated": "Updated: {time}"
};

const dictionaries: Record<Language, Record<string, string>> = { zh, en };

export type TranslationKey = keyof typeof zh;

export const t = (
  lang: Language,
  key: TranslationKey,
  params?: Record<string, string | number>
): string => {
  const template = dictionaries[lang]?.[key] ?? zh[key];
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
};
