# Usage-Pulse

Usage-Pulse 是跨平台桌面選單列工具，用於監控 Cursor 與 Claude Code 配額，並在配額變化、低額度、重置時間到點時送出桌面通知。

本專案採用 **Sidecar Observer（旁路觀察者）** 架構：只讀取本機已登入的憑證與官方用量 API，不寫回 IDE 的憑證或設定檔。

## 使用者安裝指引（Release）

### 1) 從 GitHub Release 下載檔案
- Apple Silicon（M1/M2/M3...）：`Usage-Pulse-1.0.0-arm64.dmg`
- Intel Mac：`Usage-Pulse-1.0.0.dmg`（或 x64 標示檔）
- Windows x64：`Usage-Pulse Setup 1.0.0.exe`

### 2) 未簽章安裝提示
- macOS Gatekeeper：第一次打開時，於 Finder 對 App 右鍵 -> `打開` -> 再按一次 `打開`。
- Windows SmartScreen：若出現保護提示，選 `其他資訊` -> `仍要執行`。

### 3) 首次使用前置條件
- 先登入 **Cursor Desktop**（供 Cursor 配額讀取）。
- 先在終端機登入 **Claude Code**（`claude login`）。
- 桌面版可使用本程式補抓定時檢查與提醒。
- 允許系統通知權限（macOS/Windows 都會要求）。

> 不需要安裝任何額外 CLI、捷徑檔、外掛或第三方工具。

## 功能行為
- 背景定時檢查 Cursor / Claude 配額（預設 10 分鐘）。
- 低額度通知可分別開關（Cursor、Claude 各自控制）。
- 配額重置提醒可分別開關（Cursor、Claude 各自控制）。
- 通知冷卻時間可設定，避免同內容短時間重複提醒。
- 可在 UI 或 Tray 選單直接使用「結束 Usage-Pulse」。

## 安全性說明

### 讀取哪些本機資料
- Cursor：`state.vscdb`（只讀）
- Claude Code：`CLAUDE_CODE_OAUTH_TOKEN`、macOS Keychain、或 `~/.claude/.credentials.json`（只讀）

### 不會做的事情
- 不會寫入 Cursor `state.vscdb`
- 不會寫入 Claude credentials / Keychain
- 不會修改 IDE 的登入狀態
- 不會替你自動刷新 token

### 資料落地
- 應用程式會在本機 `electron-store` 保存一般設定（檢查頻率、通知開關、冷卻時間）。
- OAuth token 僅用於執行期間請求 API，不會被回寫到 IDE。
