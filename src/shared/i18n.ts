import type { Language } from "@shared/types";

const zh = {
  "app.subtitle": "跨平台配額監控工具（Cursor / Claude Code）",
  "app.authRefreshed": "本機憑證狀態已更新",
  "app.authRefreshFailed": "重新偵測憑證失敗",
  "app.naSlashNa": "N/A / N/A",
  "app.notFetchedYet": "尚未抓取資料",
  "app.unknown": "未知",
  "app.alreadyReset": "已重置",
  "app.countdown.days": "{days} 天 {hours} 小時 {minutes} 分鐘",
  "app.liveCountdown": "即時倒數：{countdown} ({resetTime})",

  "section.realtimeQuota": "即時配額",
  "section.credentialDetection": "本機憑證偵測",
  "section.settings": "提醒設定",

  "button.redetect": "重新偵測憑證",
  "button.detecting": "偵測中...",
  "button.saveSettings": "儲存設定",
  "button.saving": "儲存中...",
  "button.quit": "結束 Usage-Pulse",

  "auth.detected": "已偵測到可用憑證",
  "auth.notDetected": "尚未偵測到憑證",
  "auth.hint.cursor": "請先在 Cursor Desktop 登入後再檢查。",
  "auth.hint.claude": "請先安裝獨立 Claude Code CLI 並在終端機執行 claude 完成登入（僅用 Claude Desktop 不會產生這組憑證；或改設定 CLAUDE_CODE_OAUTH_TOKEN）。",

  "line.title": "LINE 通知（選填）",
  "line.desc": "本專案不提供公用 LINE 服務，也不會將金鑰上傳雲端。請自行申請 LINE Messaging API 官方帳號，把以下憑證貼在對應欄位。",
  "line.pasteHint": "貼上後請立即點擊「儲存」：內容會用你 macOS 系統的 Keychain 加密後才寫入磁碟，尚未儲存前僅暫存在畫面上，離開此頁或關閉程式就會消失。",
  "line.clipboardWarning": "你輸入的 Token／金鑰僅儲存在你自己的電腦，不會上傳到任何伺服器。貼上後系統剪貼簿會自動清除，避免殘留在其他地方。",
  "line.tokenLabel": "Channel Access Token",
  "line.tokenPlaceholder": "貼上你的 Channel Access Token（若改用下方私鑰簽章方式可留空）",
  "line.channelIdLabel": "Channel ID",
  "line.channelIdPlaceholder": "Console > Basic settings 的 Channel ID",
  "line.assertionKidLabel": "Assertion Kid",
  "line.assertionKidPlaceholder": "已註冊 public key JWK 的 kid",
  "line.assertionPrivateKeyLabel": "Assertion Private Key",
  "line.assertionPrivateKeyPlaceholder": "private key（PKCS8 PEM，base64 編碼後貼上）",
  "line.save": "儲存 LINE 金鑰",
  "line.saved": "LINE 金鑰已加密儲存在本機",

  "settings.lowThreshold": "低額度預警閾值：{percent}%",
  "settings.launchAtLogin": "開機自動啟動",
  "settings.language": "語言",
  "settings.resetAlarm.toggleLabel": "重置提醒",
  "settings.resetAlarm.nextFire": "└ 下次觸發倒數：{countdown}（{resetTime}）",
  "settings.resetAlarm.openClock": "開啟「時鐘」App 檢查系統鬧鐘",
  "settings.resetAlarm.openClockFailed": "開啟「時鐘」App 失敗",
  "settings.resetAlarm.openClockUnsupported": "此功能僅支援 macOS",
  "settings.lowQuota.toggleLabel": "低額度通知",

  "window.label.billingCycle": "本期 included usage",
  "window.label.session": "5 小時視窗",
  "window.label.weeklyAll": "每週總配額",
  "window.label.weeklyScoped": "每週模型配額",
  "window.label.weekly": "每週配額",
  "window.label.cursorModels": "Cursor 模型 · 包含 Cursor Grok 與 Composer",
  "window.label.otherModels": "其他模型",
  "window.desc.cursorModels": "超出額度後，將消耗其他模型配額或按用量計費。",
  "window.desc.otherModels": "超出額度後，將以按用量計費方式收費。你的方案至少包含 $20 的 API 用量。",
  "window.usagePercent": "已使用 {percent}%",
  "quota.remaining": "剩餘",
  "quota.used": "已使用",
  "window.message.cursorSource": "資料來源：Cursor DashboardService",
  "window.message.claudeSource": "資料來源：Claude Code OAuth Usage API",

  "fallback.billingCycle": "計費週期",

  "error.cursorLoginExpired": "Cursor 登入已失效，請先重新登入 Cursor Desktop。",
  "error.cursorApiFailed": "Cursor 用量 API 請求失敗。",
  "error.cursorMissingFields": "Cursor 回應缺少可用的配額欄位。",
  "error.claudeLoginExpired": "Claude Code 登入已失效，請先在終端機執行 claude 重新登入（獨立 CLI，非 Claude Desktop）。",
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
  "tray.tooltip.updated": "更新: {time}",

  "footer.developer": "開發者 W.Y. LI",
  "footer.support": "客服"
};

const en: Record<keyof typeof zh, string> = {
  "app.subtitle": "Cross-platform quota monitor (Cursor / Claude Code)",
  "app.authRefreshed": "Local credential status updated",
  "app.authRefreshFailed": "Failed to re-detect credentials",
  "app.naSlashNa": "N/A / N/A",
  "app.notFetchedYet": "No data fetched yet",
  "app.unknown": "Unknown",
  "app.alreadyReset": "Already reset",
  "app.countdown.days": "{days}d {hours}h {minutes}m",
  "app.liveCountdown": "Live countdown: {countdown} ({resetTime})",

  "section.realtimeQuota": "Real-time Quota",
  "section.credentialDetection": "Local Credential Detection",
  "section.settings": "Reminder Settings",

  "button.redetect": "Re-detect Credentials",
  "button.detecting": "Detecting...",
  "button.saveSettings": "Save Settings",
  "button.saving": "Saving...",
  "button.quit": "Quit Usage-Pulse",

  "auth.detected": "Credentials detected",
  "auth.notDetected": "No credentials detected",
  "auth.hint.cursor": "Please log in to Cursor Desktop first.",
  "auth.hint.claude": "Install the standalone Claude Code CLI and run `claude` in your terminal to log in (using Claude Desktop alone does not create this credential; or set CLAUDE_CODE_OAUTH_TOKEN instead).",

  "line.title": "LINE Notifications (Optional)",
  "line.desc": "This project doesn't run a shared LINE service and never uploads your key anywhere. Create your own LINE Messaging API official account and paste your credentials into the fields below.",
  "line.pasteHint": "Click \"Save\" right after pasting: the value is encrypted with your macOS Keychain before it's written to disk. Until you save, it only stays on screen and disappears if you leave this page or quit the app.",
  "line.clipboardWarning": "Your tokens and keys are stored only on your own computer and never uploaded to any server. After pasting, the system clipboard is cleared automatically so it doesn't linger elsewhere.",
  "line.tokenLabel": "Channel Access Token",
  "line.tokenPlaceholder": "Paste your Channel Access Token (leave blank if using the private-key signing method below)",
  "line.channelIdLabel": "Channel ID",
  "line.channelIdPlaceholder": "Channel ID from Console > Basic settings",
  "line.assertionKidLabel": "Assertion Kid",
  "line.assertionKidPlaceholder": "kid of the registered public key JWK",
  "line.assertionPrivateKeyLabel": "Assertion Private Key",
  "line.assertionPrivateKeyPlaceholder": "Private key (PKCS8 PEM, base64-encoded before pasting)",
  "line.save": "Save LINE Key",
  "line.saved": "LINE key encrypted and saved locally",

  "settings.lowThreshold": "Low quota alert threshold: {percent}%",
  "settings.launchAtLogin": "Launch at login",
  "settings.language": "Language",
  "settings.resetAlarm.toggleLabel": "Reset alert",
  "settings.resetAlarm.nextFire": "└ Next alert in: {countdown} ({resetTime})",
  "settings.resetAlarm.openClock": "Open Clock App to check system alarms",
  "settings.resetAlarm.openClockFailed": "Failed to open Clock app",
  "settings.resetAlarm.openClockUnsupported": "This feature is macOS-only",
  "settings.lowQuota.toggleLabel": "Low quota alert",

  "window.label.billingCycle": "Current period included usage",
  "window.label.session": "5-hour window",
  "window.label.weeklyAll": "Weekly total quota",
  "window.label.weeklyScoped": "Weekly model quota",
  "window.label.weekly": "Weekly quota",
  "window.label.cursorModels": "Cursor Models · Includes Cursor Grok and Composer",
  "window.label.otherModels": "Other Models",
  "window.desc.cursorModels": "Additional usage beyond limits consumes Other Models quota or on-demand spend.",
  "window.desc.otherModels": "Additional usage beyond limits consumes on-demand spend. Your plan includes at least $20 of API usage.",
  "window.usagePercent": "{percent}% used",
  "quota.remaining": "Remaining",
  "quota.used": "Used",
  "window.message.cursorSource": "Data source: Cursor DashboardService",
  "window.message.claudeSource": "Data source: Claude Code OAuth Usage API",

  "fallback.billingCycle": "Billing cycle",

  "error.cursorLoginExpired": "Cursor login has expired. Please log in to Cursor Desktop again.",
  "error.cursorApiFailed": "Cursor usage API request failed.",
  "error.cursorMissingFields": "Cursor response is missing usable quota fields.",
  "error.claudeLoginExpired": "Claude Code login has expired. Please run `claude` again in your terminal to log back in (the standalone CLI, not Claude Desktop).",
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
  "tray.tooltip.updated": "Updated: {time}",

  "footer.developer": "Developer W.Y. LI",
  "footer.support": "Support"
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
