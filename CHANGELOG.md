# Changelog

Language / 語言：[English](#english) | [繁體中文](#繁體中文)

---

## English

All notable changes to Usage-Pulse are documented in this file.

### [2.1.0] - 2026-10-03

#### Added
- Popup and LINE are now switched per service (Cursor / Claude Code / Codex); settings from older versions carry over unchanged.
- "Clear older than 2 weeks" button on the Claude Code and Codex cards. It only acts after you confirm: pinned Codex conversations are kept, Claude Code files go to the Trash, and Codex refuses to run while the app is open.

#### Changed
- A 5-hour window reset now sends a single "quota recovered" notice (desktop + LINE) instead of one for the low-quota state and another for the cooldown.
- The 5-hour reset alarms (Claude Code and Codex) no longer send LINE messages; the popup and desktop notification are unchanged. Weekly and period-end / renewal alarms still send LINE.
- The status sent when the app quits is now one swipeable LINE message with a card per window, instead of up to four separate messages.

#### Fixed
- A cooldown no longer counts as recovered while the window sits at or just above 0%, or while its reset time is briefly unknown, which could send repeated "recovered" and "cooldown" notices back to back.

#### Removed
- The hydration reminder and the quit summary window.

### [2.0.4] - 2026-09-28

#### Added
- Windows auto-update: the app checks GitHub for a newer release on startup and every 6 hours (toggle in Settings), and on demand from the tray menu's "Check for Updates". An in-app banner shows the release notes in your language, and nothing is downloaded or installed until you click. macOS builds are unsigned, so they never self-update — download new versions from the Releases page.
- Per-release notes are now written in all four languages (`release-notes/<version>.json`) and reused for both the GitHub Release body and the in-app update banner.
- README now ships feature screenshots, a GitHub Watch callout, and full Traditional Chinese, Japanese, and Korean versions.

### [2.0.3] - 2026-09-10

#### Added
- One-shot desktop + LINE notice when a window recovers from low quota, exhausted, or cooldown (no popup — recovery isn't urgent). Already-healthy windows never get a spurious recovered message.

#### Changed
- Codex accent colour is now blue (`#60A5FA`) across the quota card, menu bar, and LINE cards, replacing the previous gold.

#### Fixed
- Window `resetsAt` is still pinned against poll jitter, but a candidate more than 60 seconds away is trusted immediately, so a genuine early reset can re-arm the one-shot alert gate instead of being treated as noise.

### [2.0.2] - 2026-09-08

#### Fixed
- Codex backend slot names (`primary_window` / `secondary_window`) that cannot occupy the 5-hour or weekly slot are discarded, so they never appear as extra cards in the UI.
- Window `resetsAt` is kept stable across polls (Codex's `reset_after_seconds` used to drift by a second or two), so a low-quota alert no longer re-fires for as long as the window stays low.
- Credential-expired notifications fire once per occurrence; a later recovery clears the latch so a genuine new failure can notify again.

### [2.0.1] - 2026-09-06

#### Changed
- Codex quota card now shows extra windows (for example code-review limits) and remaining credits when the API reports them.

#### Fixed
- Codex 5-hour and weekly windows are classified by duration, not backend slot names like `primary_window`, so a weekly window is no longer mislabeled as the 5-hour session.
- Cached Codex snapshots are normalized on read and write, so an older mislabeled window is repaired the next time the app loads it.

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

### [2.1.0] - 2026-10-03

#### 新增
- 彈窗與 LINE 改為各服務（Cursor／Claude Code／Codex）各自開關；舊版設定升級後維持原本行為。
- Claude Code 與 Codex 卡片新增「清除 2 週前對話紀錄」按鈕，確認後才會執行：Codex 已釘選的對話會保留，Claude Code 的檔案進垃圾桶，Codex 開著時會拒絕執行。

#### 變更
- 5 小時視窗重置時，只會收到一則「額度恢復」通知（桌面＋LINE），不再低額度與冷卻各發一則。
- Claude Code 與 Codex 的 5 小時到點提醒不再發 LINE，彈窗與桌面通知不變；每週與到期／續訂提醒仍會發 LINE。
- 關閉 App 時送出的現況，改為一則可左右滑動、每個視窗一張卡片的 LINE 訊息，不再最多分成四則。

#### 修復
- 冷卻中視窗停在 0% 或略高於 0%、或重置時間暫時讀不到時，不再被誤判為已恢復，避免連續收到「恢復」與「冷卻」通知。

#### 移除
- 喝水提醒與結束統計視窗。

### [2.0.4] - 2026-09-28

#### 新增
- Windows 自動更新：App 會在啟動時與每 6 小時向 GitHub 檢查是否有新版（可在設定中關閉），也能隨時從選單列右鍵選單的「檢查更新」手動觸發。App 內橫幅會以你的語言顯示版更說明，按下按鈕之前不會下載或安裝任何東西。macOS 版未簽章，不會自動更新——請至 Releases 頁面下載新版。
- 每個版本的版更說明改以四語言撰寫（`release-notes/<version>.json`），同時用於 GitHub Release 說明與 App 內更新橫幅。
- README 新增功能截圖、GitHub Watch 說明，並提供完整的繁體中文、日文、韓文版本。

### [2.0.3] - 2026-09-10

#### 新增
- 視窗從低額度、用盡或冷卻恢復時，會發一則一次性桌面＋LINE 通知（不含彈窗——恢復不算緊急）。本來就健康的視窗不會誤發。

#### 變更
- Codex 識別色改為藍色（`#60A5FA`），配額卡片、選單列與 LINE 卡片一併更新，取代原本的金色。

#### 修復
- 視窗 `resetsAt` 仍會釘住輪詢雜訊，但新值差距超過 60 秒就立即採用，視窗真的提早重置時才能重新打開一次性提醒閘門，不會被當成雜訊卡住。

### [2.0.2] - 2026-09-08

#### 修復
- 無法佔用 5 小時或每週槽位的 Codex 後端視窗名（`primary_window`／`secondary_window`）會被丟棄，不再以獨立卡片出現在 UI。
- 視窗 `resetsAt` 在輪詢之間保持穩定（Codex 的 `reset_after_seconds` 過去每次會差一兩秒），低額度提醒不會在視窗持續偏低時反覆觸發。
- 憑證失效通知依發生次數只發一次；之後若憑證恢復，會清掉閘門，真正的新失效才能再通知。

### [2.0.1] - 2026-09-06

#### 變更
- Codex 配額卡片會顯示額外視窗（例如 code-review 限額）以及 API 回報的剩餘 credits。

#### 修復
- Codex 的 5 小時與每週視窗改依時長分類，不再被 `primary_window` 這類後端槽位名稱誤標，避免把每週視窗顯示成 5 小時 session。
- 讀取與寫入快取時會正規化 Codex snapshot，下次載入即可修正舊的錯誤標籤。

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
