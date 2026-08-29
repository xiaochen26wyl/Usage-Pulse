# Usage-Pulse

**Language / 語言：** [English](#english) | [繁體中文](#繁體中文)

---

## English

Usage-Pulse is a cross-platform desktop menu bar tool that monitors Cursor, Claude Code, and Codex quotas, sending desktop notifications when quota changes, runs low, or a reset time is reached.

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
- Install the **standalone Claude Code CLI** first (see below — required to create the long-lived token).
- Log in to the **Codex CLI** first (required for Codex quota reads; Usage-Pulse does not open a Codex login UI).
- The desktop app handles scheduled checks and alerts on its own.
- Allow system notification permissions (macOS/Windows will both prompt for this).

> Cursor Desktop and the Claude Desktop app are read for their own local session state, but Usage-Pulse does **not** read Claude Desktop's internal (encrypted) credentials. Even if you only use Claude through the Claude Desktop app day to day, Usage-Pulse still needs a Claude Code setup-token saved in the macOS Keychain.

#### Claude Code credential setup (about once a year)
Usage-Pulse reads its own macOS Keychain item (`Usage-Pulse-Claude-setup-token`, account `Usage-Pulse`) first for Claude Code quota checks, then falls back to the official CLI item `Claude Code-credentials` in read-only mode. If no usable item exists when the app opens, or the API rejects the credential, the Claude card shows **Get Credentials**.

```bash
npm install -g @anthropic-ai/claude-code
```

Click **Get Credentials** to open the in-app command window running the official `claude setup-token` flow. After browser login, paste the one-time `Authentication code` into the in-app command window and press Enter. When the CLI prints the long-lived `sk-ant-oat01-...` token, paste that back into Usage-Pulse and click **Save Credential**. Usage-Pulse writes that token to Keychain and runs one usage API check. The browser Authentication code is not a usage API token. Anthropic describes setup-tokens as valid for 1 year, so this is normally an annual manual step.

> Why the numbers can look different from Claude Desktop's own "Plan usage limits" panel: Usage-Pulse shows **remaining** quota, while Claude Desktop's panel shows **used** quota. `44%` remaining and `56%` used describe the same state (they add up to 100%) — not a data error.

### Behavior
- Periodic background checks of Cursor / Claude Code / Codex quota (about every 15 minutes; about every 10 minutes once a window is running low). Claude Code and Codex can skip the API entirely while their CLI has been idle (this can be turned off in Settings).
- Low-quota alerts are per window: Cursor models and advanced / other models separately; Claude Code and Codex each have 5-hour, weekly, and the 5-hour lockout (cooldown) separately.
- Quota-reset / due alerts are independent: Cursor period-end; Claude Code 5-hour, weekly, and subscription renewal (monthly / annual); Codex 5-hour and weekly. Each has its own switch.
- How you are notified is two peer switches: an always-on-top popup in the top-right (quota / reset popups are silent; the water reminder plays a short chime; auto-closes after about 1 minute; snooze 5 minutes) and LINE broadcast.
- Notification cooldown is configurable, avoiding repeated quota-change alerts with the same content in a short window.
- Available in Traditional Chinese, English, Japanese, and Korean from the in-app language menu.
- The app can be quit directly from the UI or the tray menu ("Quit Usage-Pulse"). If LINE is on, quit sends a final status from the last cached reading (no extra API call).

### Security notes

#### What local data is read
- Cursor: `state.vscdb` (read-only)
- Claude Code: Usage-Pulse's own Keychain item first, then `Claude Code-credentials` (read-only)
- Codex: `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`), read-only; OS keyring is also read-only when the CLI stores credentials there

#### What it never does
- Never writes to Cursor's `state.vscdb`
- Never writes `~/.claude/.credentials.json`
- Never writes `~/.codex/auth.json`
- Never auto-refreshes Cursor or Claude tokens. A Codex access token that has expired may be refreshed **in memory only** from the CLI's `refresh_token`; the new token is not written back. If that refresh fails, log in again with the Codex CLI so it can update the file.

The one Keychain write is intentional: **Get Credentials** opens an in-app window running the official `claude setup-token`. After browser authorization, paste the one-time Authentication code into the in-app command window. Once the CLI exchanges it and prints the long-lived token, paste that token into Settings — Usage-Pulse stores it in its own `Usage-Pulse-Claude-setup-token` / `Usage-Pulse` item and immediately tries one usage API read. The official `Claude Code-credentials` item is never modified. The browser code is not a usage API token. Usage-Pulse does not keep a second Claude token copy in the app settings.

#### Data storage
- The app stores general settings (notification toggles, cooldown time, language, and the rest of Settings) locally via `electron-store`. There is no user-facing check-interval setting.
- OAuth tokens are used in-memory for API requests. The long-lived `setup-token` is stored only in Usage-Pulse's own Keychain item after you complete that login.

### License and important notice

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Usage-Pulse uses an **MIT-style license with a non-commercial default** (full terms in [`LICENSE`](LICENSE)). **Personal use is free.** Commercial use, company use, or a full project buyout requires the author's agreement — please contact via [LinkedIn](https://www.linkedin.com/in/wenyu-li-1a9868bb/) (details in `LICENSE`).

**Only download Usage-Pulse from this repository's official GitHub Releases page.** Builds from any other source are not published by the original developer, and their handling of your credentials cannot be trusted.

### Support

If Usage-Pulse helps you, please consider sponsoring via [GitHub Sponsors](https://github.com/sponsors/xiaochen26wyl).

- Threads: [@xiaochen26wyl](https://www.threads.com/@xiaochen26wyl)
- LINE: <https://lin.ee/6XYi49XZ>
- Instagram: [@xiaochen26wyl](https://www.instagram.com/xiaochen26wyl/)
- WhatsApp: <https://wa.me/message/ZENT2RTQIGPEI1>
- LinkedIn: [W.Y. LI](https://www.linkedin.com/in/wenyu-li-1a9868bb/)

### Developer

- W.Y. LI — [LinkedIn](https://www.linkedin.com/in/wenyu-li-1a9868bb/) (commercial licensing & buyout)

---

## 繁體中文

Usage-Pulse 是跨平台桌面選單列工具，用於監控 Cursor、Claude Code 與 Codex 配額，並在配額變化、低額度、重置時間到點時送出桌面通知。

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
- 先安裝**獨立版 Claude Code CLI**（詳見下方，用來產生永久 token）。
- 先登入 **Codex CLI**（供 Codex 配額讀取；Usage-Pulse 不開 Codex 登入介面）。
- 桌面版可使用本程式補抓定時檢查與提醒。
- 允許系統通知權限（macOS/Windows 都會要求）。

> Usage-Pulse **不會**讀取 Claude Desktop App 內部（加密）的登入狀態。就算你平常只用 Claude Desktop，Usage-Pulse 仍然需要一組已存進 macOS Keychain 的 Claude Code setup-token。

#### Claude Code 憑證設定（約一年一次）
Usage-Pulse 會優先讀取自己的 macOS Keychain `Usage-Pulse-Claude-setup-token` / `Usage-Pulse` 項目，再以只讀方式讀取官方 CLI 的 `Claude Code-credentials` 項目來抓 Claude Code 配額。程式開啟時若找不到可用憑證，或 API 回報憑證失效，Claude 卡片會顯示「獲取憑證」。

```bash
npm install -g @anthropic-ai/claude-code
```

點「獲取憑證」會開啟 App 內指令視窗並執行官方 `claude setup-token` 流程。瀏覽器完成登入後會顯示 `Authentication code`，請把這串一次性 code 貼回 App 內的指令視窗並按 Enter；等 CLI 完成交換、印出 `sk-ant-oat01-...` 開頭的長效 token，再把它貼回 Usage-Pulse 按「儲存憑證」。Usage-Pulse 會把這組長效 token 寫入 Keychain，並立刻打一次 usage API 檢查能否取得數值。瀏覽器的 Authentication code 不是 usage API token。Anthropic 說 setup-token 有效期為 1 年，所以通常只需要每年手動處理一次。

> 為什麼數字看起來跟 Claude Desktop 自己的「Plan usage limits」面板不一樣：Usage-Pulse 顯示的是**剩餘**配額，Claude Desktop 面板顯示的是**已使用**配額。「剩餘 44%」跟「已使用 56%」其實是同一個狀態（相加等於 100%），不是資料錯誤。

### 功能行為
- 背景定時檢查 Cursor / Claude Code / Codex 配額（約每 15 分鐘；視窗偏低時約每 10 分鐘）。Claude Code 與 Codex 可在 CLI 無活動時完全跳過 API（可在設定關閉）。
- 低額度通知依視窗分開：Cursor 模型與進階／其他模型各自獨立；Claude Code 與 Codex 各自為 5 小時、每週，以及 5 小時用盡鎖定（cooldown）。
- 配額重置／到期提醒可分別開關：Cursor 到期、Claude Code 5 小時到點、每週到點、訂閱到期（月繳／年繳）、Codex 5 小時到點與每週到點各自獨立。
- 提醒方式是兩個平級開關：螢幕右上角置頂彈窗（配額／重置彈窗靜音；喝水提醒有短提示音；約 1 分鐘自動關閉；可延後 5 分鐘）與 LINE 廣播。
- 通知冷卻時間可設定，避免同內容短時間重複提醒配額變化。
- 支援繁體中文、英文、日文、韓文介面，可在 App 標題列語言選單切換。
- 可在 UI 或 Tray 選單直接使用「結束 Usage-Pulse」。若 LINE 開啟，結束時會用最後一次快取用量送出現況（不再打 API）。

### 安全性說明

#### 讀取哪些本機資料
- Cursor：`state.vscdb`（只讀）
- Claude Code：Usage-Pulse 自己的 Keychain 項目優先，再以只讀方式讀取 `Claude Code-credentials`
- Codex：`~/.codex/auth.json`（或 `$CODEX_HOME/auth.json`）只讀；CLI 若把憑證放在 OS 憑證庫也只讀

#### 不會做的事情
- 不會寫入 Cursor `state.vscdb`
- 不會寫入 `~/.claude/.credentials.json`
- 不會寫入 `~/.codex/auth.json`
- 不會替你自動刷新 Cursor 或 Claude 的 token。Codex 的 access token 過期時，可用 CLI 的 `refresh_token` **只在記憶體**換新，不會寫回檔案。若刷新失敗，請再開一次 Codex CLI 讓它自己改檔。

唯一的 Keychain 寫入是刻意的：「獲取憑證」會開啟 App 內視窗跑官方 `claude setup-token`。你在瀏覽器完成授權後，先把 Authentication code 貼進 App 內指令視窗，等 CLI 交換並印出長效 token，再把 token 貼到設定頁；Usage-Pulse 會把它寫進自己的 `Usage-Pulse-Claude-setup-token` service、`Usage-Pulse` account 項目，並立刻嘗試讀取一次用量。官方的 `Claude Code-credentials` 項目只讀、不會被修改。瀏覽器的 Authentication code 不是 usage API token，也不會在 App 設定內再保留第二份 Claude token。

#### 資料落地
- 應用程式會在本機 `electron-store` 保存一般設定（通知開關、冷卻時間、語言與其他設定項）。沒有使用者可調的檢查頻率。
- OAuth token 用於執行期間請求 API。`setup-token` 永久憑證在你完成官方登入後，只會寫入官方 Keychain 項目。

### 授權與重要聲明

Usage-Pulse 採用 **MIT 風格授權，預設僅限非商業使用**（完整條文見 [`LICENSE`](LICENSE)）。**個人使用完全免費**；商業使用、公司內使用或專案買斷須經作者同意，請透過 [LinkedIn](https://www.linkedin.com/in/wenyu-li-1a9868bb/) 洽談（細節見 `LICENSE`）。

若這個專案對你有幫助，歡迎透過 [GitHub Sponsors](https://github.com/sponsors/xiaochen26wyl) 贊助。

**請只從本 repo 官方的 GitHub Releases 頁面下載 Usage-Pulse。** 任何其他來源的安裝檔都不是原開發者發佈的版本，無法保證它如何處理你的憑證。

### 客服聯繫

- Threads：[@xiaochen26wyl](https://www.threads.com/@xiaochen26wyl)
- LINE：<https://lin.ee/6XYi49XZ>
- Instagram：[@xiaochen26wyl](https://www.instagram.com/xiaochen26wyl/)
- WhatsApp：<https://wa.me/message/ZENT2RTQIGPEI1>
- LinkedIn：[W.Y. LI](https://www.linkedin.com/in/wenyu-li-1a9868bb/)

### 開發者

- W.Y. LI — [LinkedIn](https://www.linkedin.com/in/wenyu-li-1a9868bb/)（商業授權／買斷）

---

## Usage-Pulse

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Personal use is free** | **Commercial use or buyout requires the author's agreement**

If this project helps you, please consider [GitHub Sponsors](https://github.com/sponsors/xiaochen26wyl).

For commercial licensing or buyout, contact via [LinkedIn](https://www.linkedin.com/in/wenyu-li-1a9868bb/). Full terms: [`LICENSE`](LICENSE).
