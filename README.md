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
- Available in Traditional Chinese, English, Japanese, and Korean from the in-app language menu.
- The app can be quit directly from the UI or the tray menu ("Quit Usage-Pulse").

### Security notes

#### What local data is read
- Cursor: `state.vscdb` (read-only)
- Claude Code: `CLAUDE_CODE_OAUTH_TOKEN`, macOS Keychain, or `~/.claude/.credentials.json` (read-only)

#### What it never does
- Never writes to Cursor's `state.vscdb`
- Never writes `~/.claude/.credentials.json`
- Never auto-refreshes tokens on your behalf

The one Keychain write is intentional: after you finish the official `claude setup-token` login from **Re-detect Credentials**, Usage-Pulse stores that long-lived token in the `Claude Code-credentials` item so the next re-detect can find it. It does not create a login of its own.

#### Data storage
- The app stores general settings (check interval, notification toggles, cooldown time, language) locally via `electron-store`.
- OAuth tokens are used in-memory for API requests. A long-lived `setup-token` is also stored in the official Keychain item (and the encrypted app store) after you complete that login.

### License and important notice

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Usage-Pulse uses an **MIT-style license with a non-commercial default** (full terms in [`LICENSE`](LICENSE)). **Personal use is free.** Commercial use, company use, or a full project buyout requires the author's agreement — please contact via [LinkedIn](https://www.linkedin.com/in/wenyu-li-1a9868bb/) (details in `LICENSE`).

**Only download Usage-Pulse from this repository's official GitHub Releases page.** Builds from any other source are not published by the original developer, and their handling of your credentials cannot be trusted.

### Support

If Usage-Pulse helps you, please consider sponsoring via [GitHub Sponsors](https://github.com/sponsors/xiaochen26wyl).

- Instagram: [@xiaochen26wyl](https://www.instagram.com/xiaochen26wyl/)
- WhatsApp: <https://wa.me/message/ZENT2RTQIGPEI1>

### Developer

- W.Y. LI — [LinkedIn](https://www.linkedin.com/in/wenyu-li-1a9868bb/) (commercial licensing & buyout)

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
- 配額重置／到期提醒可分別開關：Cursor 到期、Claude Code 5 小時到點、每週到點、訂閱到期（月繳／年繳）各自獨立。
- 通知冷卻時間可設定，避免同內容短時間重複提醒。
- 支援繁體中文、英文、日文、韓文介面，可在 App 標題列語言選單切換。
- 可在 UI 或 Tray 選單直接使用「結束 Usage-Pulse」。

### 安全性說明

#### 讀取哪些本機資料
- Cursor：`state.vscdb`（只讀）
- Claude Code：`CLAUDE_CODE_OAUTH_TOKEN`、macOS Keychain、或 `~/.claude/.credentials.json`（只讀）

#### 不會做的事情
- 不會寫入 Cursor `state.vscdb`
- 不會寫入 `~/.claude/.credentials.json`
- 不會替你自動刷新 token

唯一的 Keychain 寫入是刻意的：在「重新偵測憑證」裡用官方 `claude setup-token` 完成登入後，Usage-Pulse 會把那組永久 token 寫進 `Claude Code-credentials`，下次重新偵測才讀得到。不會自己做一套登入。

#### 資料落地
- 應用程式會在本機 `electron-store` 保存一般設定（檢查頻率、通知開關、冷卻時間、語言）。
- OAuth token 用於執行期間請求 API。`setup-token` 永久憑證在你完成官方登入後，會寫入 Keychain 與 App 自己的加密 store。

### 授權與重要聲明

Usage-Pulse 採用 **MIT 風格授權，預設僅限非商業使用**（完整條文見 [`LICENSE`](LICENSE)）。**個人使用完全免費**；商業使用、公司內使用或專案買斷須經作者同意，請透過 [LinkedIn](https://www.linkedin.com/in/wenyu-li-1a9868bb/) 洽談（細節見 `LICENSE`）。

若這個專案對你有幫助，歡迎透過 [GitHub Sponsors](https://github.com/sponsors/xiaochen26wyl) 贊助。

**請只從本 repo 官方的 GitHub Releases 頁面下載 Usage-Pulse。** 任何其他來源的安裝檔都不是原開發者發佈的版本，無法保證它如何處理你的憑證。

### 客服聯繫

- Threads：[@xiaochen26wyl](https://www.threads.com/@xiaochen26wyl)
- LINE：<https://lin.ee/6XYi49XZ>

### 開發者

- W.Y. LI — [LinkedIn](https://www.linkedin.com/in/wenyu-li-1a9868bb/)（商業授權／買斷）

---

## Usage-Pulse

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Personal use is free** | **Commercial use or buyout requires the author's agreement**

If this project helps you, please consider [GitHub Sponsors](https://github.com/sponsors/xiaochen26wyl).

For commercial licensing or buyout, contact via [LinkedIn](https://www.linkedin.com/in/wenyu-li-1a9868bb/). Full terms: [`LICENSE`](LICENSE).

