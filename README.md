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
- Install and log in to the **standalone Claude Code CLI** first (see below — required for Claude Code quota reads).
- The desktop app handles scheduled checks and alerts on its own.
- Allow system notification permissions (macOS/Windows will both prompt for this).

> Cursor Desktop and the Claude Desktop app are read for their own local session state, but Usage-Pulse does **not** read Claude Desktop's internal (encrypted) credentials. Even if you only use Claude through the Claude Desktop app day to day, Usage-Pulse still needs the standalone CLI's credential file to exist on disk.

#### Claude Code credential setup (one-time)
Usage-Pulse only reads credentials created by the standalone `claude` CLI — `CLAUDE_CODE_OAUTH_TOKEN`, the macOS Keychain entry `Claude Code-credentials`, or `~/.claude/.credentials.json`. Simply having Claude Desktop installed and logged in does **not** create any of these; its own session token is stored separately and encrypted, and Usage-Pulse cannot (and, by design, will not try to) read it.

```bash
npm install -g @anthropic-ai/claude-code
claude
```

Running `claude` the first time opens a browser to complete OAuth login, which writes the credential file/Keychain entry above. This is a one-time setup step — afterwards you can keep using Claude Desktop as usual; you don't need to keep using the CLI day to day, Usage-Pulse just needs the credential to exist.

> Why the numbers can look different from Claude Desktop's own "Plan usage limits" panel: Usage-Pulse shows **remaining** quota, while Claude Desktop's panel shows **used** quota. `44%` remaining and `56%` used describe the same state (they add up to 100%) — not a data error.

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

### License and important notice

Usage-Pulse is released under the **MIT License with additional terms** (see [`LICENSE`](LICENSE)):

1. **Attribution required.** Any copy, substantial portion, or derivative work that is distributed must keep the copyright notice and clearly credit the original developer, **W.Y. LI**.
2. **Non-commercial use only.** The software and any derivative of it may **not** be sold, sublicensed, bundled into a paid product or service, or otherwise used to generate revenue without prior written permission from W.Y. LI.
3. **No sale of copies**, modified or unmodified.

**Why the extra restriction:** Usage-Pulse ships with LINE Messaging API notification support, which means users enter their own LINE channel credentials into the app. Those credentials are encrypted locally, but a modified build distributed by someone else could remove or subvert that protection. Forbidding commercial redistribution is intended to reduce the incentive to repackage this project into a paid, look-alike installer that tricks users into handing over their tokens.

**Only download Usage-Pulse from this repository's official GitHub Releases page.** Builds from any other source are not published by the original developer, and their handling of your credentials cannot be trusted.

**Usage-Pulse is free forever.** The original developer never charges for this software. If anyone asks you to pay for it, it is not the official release.

### Support

- Threads: [@xiaochen26wyl](https://www.threads.com/@xiaochen26wyl)
- LINE: <https://lin.ee/6XYi49XZ>

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
- 先安裝並登入**獨立版 Claude Code CLI**（詳見下方，供 Claude Code 配額讀取）。
- 桌面版可使用本程式補抓定時檢查與提醒。
- 允許系統通知權限（macOS/Windows 都會要求）。

> Usage-Pulse **不會**讀取 Claude Desktop App 內部（加密）的登入狀態。就算你平常只用 Claude Desktop、完全沒開過終端機，Usage-Pulse 仍然需要獨立 CLI 產生的憑證檔案才能抓到 Claude Code 配額。

#### Claude Code 憑證設定（一次性）
Usage-Pulse 只會讀取獨立 `claude` CLI 產生的憑證：`CLAUDE_CODE_OAUTH_TOKEN`、macOS Keychain 的 `Claude Code-credentials` 項目，或 `~/.claude/.credentials.json`。只安裝並登入 Claude Desktop **不會**產生這些憑證——它自己的登入狀態是分開加密儲存的，Usage-Pulse 讀不到，設計上也不會嘗試去讀。

```bash
npm install -g @anthropic-ai/claude-code
claude
```

第一次執行 `claude` 會開啟瀏覽器完成 OAuth 登入，並寫入上述憑證檔案 / Keychain 項目。這只需要做一次；之後你可以照常只用 Claude Desktop，不需要繼續使用終端機的 `claude`，Usage-Pulse 只是需要這組憑證存在於本機。

> 為什麼數字看起來跟 Claude Desktop 自己的「Plan usage limits」面板不一樣：Usage-Pulse 顯示的是**剩餘**配額，Claude Desktop 面板顯示的是**已使用**配額。「剩餘 44%」跟「已使用 56%」其實是同一個狀態（相加等於 100%），不是資料錯誤。

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

### 授權與重要聲明

Usage-Pulse 採用 **MIT 授權並附加條款**（完整條文見 [`LICENSE`](LICENSE)）：

1. **需標示原作者**：任何散布的副本、實質部分或改作版本，都必須保留著作權聲明，並清楚標示原開發者 **W.Y. LI**。
2. **僅限非商業使用**：本軟體及其任何改作版本，**不得**販售、再授權、包裝進付費產品或服務，或以任何方式用於營利；如需商業使用，須事先取得 W.Y. LI 的書面同意。
3. **不得販售副本**：無論是否經過修改，都不得販售本軟體的副本。

**為什麼要加上這條限制：** Usage-Pulse 內建 LINE Messaging API 通知功能，使用者會在 App 內填入自己的 LINE 憑證。這些憑證在本機是加密保存的，但若有人拿走原始碼、做出修改過的版本再散布，就可能移除或繞過這層保護。禁止商業散布的目的，是降低有心人士把本專案重新包裝成付費或仿冒安裝檔、誘導使用者交出 token 的動機。

**請只從本 repo 官方的 GitHub Releases 頁面下載 Usage-Pulse。** 任何其他來源的安裝檔都不是原開發者發佈的版本，無法保證它如何處理你的憑證。

**Usage-Pulse 永久免費。** 原開發者絕不會對本軟體收費；若有人要你付費取得，那就不是官方版本。

### 客服聯繫

- Threads：[@xiaochen26wyl](https://www.threads.com/@xiaochen26wyl)
- LINE：<https://lin.ee/6XYi49XZ>

