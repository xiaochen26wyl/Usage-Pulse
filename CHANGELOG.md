# Changelog

Language / 語言：[English](#english) | [繁體中文](#繁體中文)

---

## English

All notable changes to Usage-Pulse are documented in this file.

### [2.0.0] - 2026-09-03

#### Added
- Codex quota monitoring: a new service alongside Cursor and Claude Code, with CLI-activity detection and automatic credential refresh.
- In-app timed alarm popup (top-right corner, always-on-top) for Cursor period-end and Claude Code 5-hour / weekly / subscription-renewal resets, replacing OS-level alarms; correctly catches up after sleep/wake.
- LINE Flex-card notifications for low-quota, quota-exhausted, and cooldown states, plus an end-of-session broadcast sent when the app actually quits.
- Water reminder: a periodic popup with selectable cup size (250 ml / 500 ml / 1 L) and a running total that resets each launch.
- Fallback Claude Code login: paste a token directly into the quota card; it is verified against the usage API before being stored, and encrypted at rest.
- Independent enable/disable and low-quota threshold settings per service (Cursor, Claude Code), with credential status shown directly on each quota card.
- Custom tray icon and a refined menu-bar quota display.
- Four-language interface (Traditional Chinese, English, Japanese, Korean) with an in-app language switcher.

#### Changed
- Claude Code authentication simplified to read-only use of the official CLI's `claude auth login` credential (an earlier in-app setup-token login flow was tried and then removed in favor of this safer, simpler approach).
- License terms broadened to allow free internal company use.

#### Fixed
- Cursor usage percentage no longer under-reports in LINE notifications (was missing a ×100 conversion, e.g. showing 0.46 instead of 46%).
- Clipboard-clearing preload bridge and its type definitions.
- Incomplete Electron installs after a fresh dependency install.

#### Security
- Hardened window, IPC, and credential-path boundaries against unexpected inputs.

### [1.0.0] - 2026-08-18
- Initial public release: Cursor and Claude Code quota monitoring from the menu bar, desktop notifications, and optional LINE broadcast.

---

## 繁體中文

本檔案記錄 Usage-Pulse 所有重要版本變更。

### [2.0.0] - 2026-09-03

#### 新增
- Codex 額度監控：與 Cursor、Claude Code 並列的新服務，具備 CLI 活動偵測與憑證自動刷新。
- App 內到點鬧鐘彈窗（螢幕右上角、置頂），涵蓋 Cursor 本期到期與 Claude Code 5 小時／每週／訂閱到期重置，取代舊有的作業系統鬧鐘；睡眠喚醒後可正確補發。
- LINE Flex 卡片通知：低額度、用盡、冷卻等狀態各自通知，並在 App 真正關閉時廣播結束現況。
- 喝水提醒：依間隔彈出提醒，可選杯量（250ml／500ml／1L），每次啟動重新累計。
- Claude Code 登入備援：可直接在配額卡片貼上 token，儲存前會先以 usage API 驗證，並加密存放。
- Cursor／Claude Code 各自獨立的啟用開關與低額度閾值設定，憑證狀態直接顯示在對應配額卡片上。
- 自訂選單列圖示，優化選單列配額顯示。
- 四語系介面（繁體中文／英文／日文／韓文），可在 App 內切換。

#### 變更
- Claude Code 登入簡化為唯讀使用官方 CLI 的 `claude auth login` 憑證（先前曾嘗試 App 內 setup-token 登入流程，後改採更安全簡單的做法並移除）。
- 放寬授權條款，允許公司內部免費使用。

#### 修復
- 修正 Cursor 使用率百分比未乘以 100 的問題，避免 LINE 通知顯示 0.46 而非 46%。
- 修正清除剪貼簿的 preload 橋接與型別定義。
- 修正依賴安裝後 Electron 安裝不完整的問題。

#### 安全性
- 強化視窗、IPC 與憑證路徑的邊界防護。

### [1.0.0] - 2026-08-18
- 首次公開發布：選單列監控 Cursor 與 Claude Code 額度、桌面通知，並支援可選的 LINE 廣播。
