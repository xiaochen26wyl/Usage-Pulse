# Usage-Pulse

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Usage-Pulse is a cross-platform desktop menu bar tool that monitors Cursor, Claude Code, and Codex quotas, sending notifications when quota changes, runs low, or resets.
Usage-Pulse 是跨平台桌面選單列工具，監控 Cursor、Claude Code 與 Codex 配額，在配額變化、額度偏低、或重置時發送通知。

It only reads credentials you're already logged in with locally and official usage data — it never writes back to any IDE's credential or config files.
它只讀取你本機已登入的憑證與官方用量資料，不會寫回任何 IDE 的憑證或設定檔。

## Installation 安裝指引

### Download 下載
- Apple Silicon (M1/M2/M3...): `Usage-Pulse-1.0.0-arm64.dmg`
- Intel Mac: `Usage-Pulse-1.0.0.dmg` (or the x64-labeled file)
- Windows x64: `Usage-Pulse Setup 1.0.0.exe`
- Apple Silicon（M1/M2/M3...）：`Usage-Pulse-1.0.0-arm64.dmg`
- Intel Mac：`Usage-Pulse-1.0.0.dmg`（或 x64 標示檔）
- Windows x64：`Usage-Pulse Setup 1.0.0.exe`

### Unsigned build warnings 未簽章安裝提示
- macOS Gatekeeper: on first launch, right-click the app in Finder -> `Open` -> click `Open` again.
- macOS Gatekeeper：第一次打開時，於 Finder 對 App 右鍵 -> `打開` -> 再按一次 `打開`。
- Windows SmartScreen: if a protection prompt appears, choose `More info` -> `Run anyway`.
- Windows SmartScreen：若出現保護提示，選 `其他資訊` -> `仍要執行`。

### Before first use 首次使用前
- Log in to **Cursor Desktop** first (required for Cursor quota reads).
- 先登入 **Cursor Desktop**（供 Cursor 配額讀取）。
- Install the **standalone Claude Code CLI** and log in with it first (see below).
- 先安裝**獨立版 Claude Code CLI** 並登入（詳見下方）。
- Log in to the **Codex CLI** first (Usage-Pulse does not open a Codex login UI).
- 先登入 **Codex CLI**（Usage-Pulse 不會開啟 Codex 登入介面）。
- Allow system notification permissions when prompted.
- 出現提示時請允許系統通知權限。

> Usage-Pulse does not read the Claude Desktop app's internal (encrypted) session. Even if you only use Claude through the Claude Desktop app day to day, you still need a Claude Code login saved via the official CLI.
> Usage-Pulse 不會讀取 Claude Desktop App 內部（加密）的登入狀態。就算你平常只用 Claude Desktop，仍然需要一組透過官方 CLI 完成的 Claude Code 登入。

### Claude Code credential setup Claude Code 憑證設定

```bash
npm install -g @anthropic-ai/claude-code
```

Then log in from a terminal:
接著在終端機執行登入：

```bash
claude auth login
```

Back in Usage-Pulse, click **Update Values** to detect the credential and fetch usage. If no usable credential is found, or it's expired, the Claude card shows **Get Credentials**, which just opens `https://claude.ai/login` for you — the login itself always happens in your own terminal via the command above.
回到 Usage-Pulse 後按「更新數值」偵測憑證並抓取用量。若找不到可用憑證，或憑證已過期，Claude 卡片會顯示「獲取憑證」，點下去只會用瀏覽器打開 `https://claude.ai/login` — 實際登入一律透過上面的指令在你自己的終端機完成。

Don't use `claude setup-token` for this — it won't satisfy what quota checks need. Use `claude auth login` instead.
請不要用 `claude setup-token` 做這件事——它無法滿足配額查詢的需求，請改用 `claude auth login`。

> Why the numbers can look different from Claude Desktop's own "Plan usage limits" panel: Usage-Pulse shows **remaining** quota, while Claude Desktop's panel shows **used** quota. `44%` remaining and `56%` used describe the same state — not a data error.
> 為什麼數字看起來跟 Claude Desktop 自己的「Plan usage limits」面板不一樣：Usage-Pulse 顯示的是**剩餘**配額，Claude Desktop 面板顯示的是**已使用**配額。「剩餘 44%」跟「已使用 56%」是同一個狀態，不是資料錯誤。

## Behavior 功能行為

- Checks Cursor / Claude Code / Codex quota periodically in the background and alerts you on changes.
- 背景會定期檢查 Cursor / Claude Code / Codex 配額，並在變化時提醒你。
- Low-quota and quota-reset alerts can each be toggled independently, per service and per window, in Settings.
- 低額度與配額重置提醒都可以在設定中依服務、依視窗個別開關。
- Two notification channels: an always-on-top popup in the top-right (auto-closes, can be snoozed) and an optional LINE broadcast.
- 兩種通知管道：螢幕右上角置頂彈窗（會自動關閉，可延後）與選用的 LINE 廣播。
- Notification cooldown is configurable, avoiding repeated alerts with the same content in a short window.
- 通知冷卻時間可調整，避免短時間內重複提醒同樣內容。
- Available in Traditional Chinese, English, Japanese, and Korean from the in-app language menu.
- 支援繁體中文、英文、日文、韓文介面，可在 App 語言選單切換。
- Quit anytime from the UI or the tray menu; if LINE is on, quitting sends a final status from the last cached reading.
- 可隨時從 UI 或選單列離開；若 LINE 開啟，離開時會用最後一次快取用量送出現況。

## Security notes 安全性說明

- What's read, all read-only: Cursor's local session file, the official Claude Code CLI's saved login, and Codex's local auth file.
- 讀取項目皆為唯讀：Cursor 本機工作階段資料、官方 Claude Code CLI 已存的登入資訊、Codex 本機憑證檔。
- Usage-Pulse never writes to or modifies any of these files or credentials.
- Usage-Pulse 不會寫入或修改這些檔案或憑證。
- It never auto-refreshes your Cursor or Claude login. If a credential expires, log in again with that tool's own CLI or app.
- 不會自動幫你刷新 Cursor 或 Claude 的登入。憑證過期時，請用該工具自己的 CLI 或 App 重新登入。
- General settings (notification toggles, cooldown, language, and the rest of Settings) are stored locally only — there's no cloud sync.
- 一般設定（通知開關、冷卻時間、語言等）只存在本機，沒有雲端同步。

If anything looks off — a reading that seems wrong, a notification that shouldn't have fired, anything unexpected — please open an issue rather than assuming; we'll look into it.
如果任何行為看起來不對勁——數值看起來錯誤、不該跳出的通知、任何預期外的狀況——歡迎直接開 issue 回報，不用自行猜測原因，我們會盡快確認。

## License and important notice 授權與重要聲明

Usage-Pulse uses an **MIT-style license with a non-commercial default** (full terms in [`LICENSE`](LICENSE)). **Personal use is free.** Commercial use, company use, or a full project buyout requires the author's agreement — please contact via [LinkedIn](https://www.linkedin.com/in/wenyu-li-1a9868bb/).
Usage-Pulse 採用 **MIT 風格授權，預設僅限非商業使用**（完整條文見 [`LICENSE`](LICENSE)）。**個人使用完全免費。** 商業使用、公司內使用或專案買斷須經作者同意，請透過 [LinkedIn](https://www.linkedin.com/in/wenyu-li-1a9868bb/) 洽談。

**Only download Usage-Pulse from this repository's official GitHub Releases page.** Builds from any other source are not published by the original developer, and their handling of your credentials cannot be trusted.
**請只從本 repo 官方的 GitHub Releases 頁面下載 Usage-Pulse。** 任何其他來源的安裝檔都不是原開發者發佈的版本，無法保證它如何處理你的憑證。

## Support 支援

If Usage-Pulse helps you, please consider sponsoring via [GitHub Sponsors](https://github.com/sponsors/xiaochen26wyl).
若這個專案對你有幫助，歡迎透過 [GitHub Sponsors](https://github.com/sponsors/xiaochen26wyl) 贊助。

- Threads: [@xiaochen26wyl](https://www.threads.com/@xiaochen26wyl)
- LINE: <https://lin.ee/6XYi49XZ>
- Instagram: [@xiaochen26wyl](https://www.instagram.com/xiaochen26wyl/)
- WhatsApp: <https://wa.me/message/ZENT2RTQIGPEI1>

## Developer 開發者

W.Y. LI — [LinkedIn](https://www.linkedin.com/in/wenyu-li-1a9868bb/) (commercial licensing & buyout / 商業授權與買斷)
