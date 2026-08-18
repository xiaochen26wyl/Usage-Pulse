# Usage-Pulse

**Language / 語言：** [English](#english) | [繁體中文](#繁體中文)

---

## English

Usage-Pulse is a cross-platform desktop menu bar tool that monitors Cursor and Claude Code quotas, sending desktop notifications when quota changes, runs low, or a reset time is reached.

This project follows a **Sidecar Observer** architecture: it only reads locally logged-in credentials and official usage APIs — it never writes back to any IDE's credential or config files.

### User installation guide (Release)

#### 1) Download from GitHub Release
- Apple Silicon (M1/M2/M3...): `Usage-Pulse-1.0.0-arm64.dmg`
- Intel Mac: `Usage-Pulse-1.0.0.dmg` (or the x64-labeled file)
- Windows x64: `Usage-Pulse Setup 1.0.0.exe`

#### 2) Unsigned build warnings
- macOS Gatekeeper: on first launch, right-click the app in Finder -> `Open` -> click `Open` again.
- Windows SmartScreen: if a protection prompt appears, choose `More info` -> `Run anyway`.

#### 3) Prerequisites before first use
- Log in to **Cursor Desktop** first (required for Cursor quota reads).
- Log in to **Claude Code** in a terminal first (`claude login`).
- The desktop app handles scheduled checks and alerts on its own.
- Allow system notification permissions (macOS/Windows will both prompt for this).

> No extra CLI, shortcut files, plugins, or third-party tools are required.

### Behavior
- Periodic background checks of Cursor / Claude quota (default: every 10 minutes).
- Low-quota alerts can be toggled independently for Cursor and Claude.
- Quota-reset alerts can be toggled independently for Cursor and Claude.
- Notification cooldown is configurable, avoiding repeated alerts with the same content in a short window.
- Available in both Traditional Chinese and English, switchable from the in-app settings panel.
- The app can be quit directly from the UI or the tray menu ("Quit Usage-Pulse").

### Security notes

#### What local data is read
- Cursor: `state.vscdb` (read-only)
- Claude Code: `CLAUDE_CODE_OAUTH_TOKEN`, macOS Keychain, or `~/.claude/.credentials.json` (read-only)

#### What it never does
- Never writes to Cursor's `state.vscdb`
- Never writes to Claude credentials / Keychain
- Never modifies any IDE's login state
- Never auto-refreshes tokens on your behalf

#### Data storage
- The app stores general settings (check interval, notification toggles, cooldown time, language) locally via `electron-store`.
- OAuth tokens are only used in-memory for API requests during runtime and are never written back to the IDE.

---

## 繁體中文

Usage-Pulse 是跨平台桌面選單列工具，用於監控 Cursor 與 Claude Code 配額，並在配額變化、低額度、重置時間到點時送出桌面通知。

本專案採用 **Sidecar Observer（旁路觀察者）** 架構：只讀取本機已登入的憑證與官方用量 API，不寫回 IDE 的憑證或設定檔。

### 使用者安裝指引（Release）

#### 1) 從 GitHub Release 下載檔案
- Apple Silicon（M1/M2/M3...）：`Usage-Pulse-1.0.0-arm64.dmg`
- Intel Mac：`Usage-Pulse-1.0.0.dmg`（或 x64 標示檔）
- Windows x64：`Usage-Pulse Setup 1.0.0.exe`

#### 2) 未簽章安裝提示
- macOS Gatekeeper：第一次打開時，於 Finder 對 App 右鍵 -> `打開` -> 再按一次 `打開`。
- Windows SmartScreen：若出現保護提示，選 `其他資訊` -> `仍要執行`。

#### 3) 首次使用前置條件
- 先登入 **Cursor Desktop**（供 Cursor 配額讀取）。
- 先在終端機登入 **Claude Code**（`claude login`）。
- 桌面版可使用本程式補抓定時檢查與提醒。
- 允許系統通知權限（macOS/Windows 都會要求）。

> 不需要安裝任何額外 CLI、捷徑檔、外掛或第三方工具。

### 功能行為
- 背景定時檢查 Cursor / Claude 配額（預設 10 分鐘）。
- 低額度通知可分別開關（Cursor、Claude 各自控制）。
- 配額重置提醒可分別開關（Cursor、Claude 各自控制）。
- 通知冷卻時間可設定，避免同內容短時間重複提醒。
- 支援繁體中文與英文介面，可在 App 設定面板內切換。
- 可在 UI 或 Tray 選單直接使用「結束 Usage-Pulse」。

### 安全性說明

#### 讀取哪些本機資料
- Cursor：`state.vscdb`（只讀）
- Claude Code：`CLAUDE_CODE_OAUTH_TOKEN`、macOS Keychain、或 `~/.claude/.credentials.json`（只讀）

#### 不會做的事情
- 不會寫入 Cursor `state.vscdb`
- 不會寫入 Claude credentials / Keychain
- 不會修改 IDE 的登入狀態
- 不會替你自動刷新 token

#### 資料落地
- 應用程式會在本機 `electron-store` 保存一般設定（檢查頻率、通知開關、冷卻時間、語言）。
- OAuth token 僅用於執行期間請求 API，不會被回寫到 IDE。
