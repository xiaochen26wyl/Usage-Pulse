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
- Install the **standalone Claude Code CLI** and log in with it first.
- 先安裝**獨立版 Claude Code CLI** 並登入。
- Log in to the **Codex CLI** first (Usage-Pulse does not open a Codex login UI).
- 先登入 **Codex CLI** 或 **Codex Desktop**。
- Allow system notification permissions when prompted.
- 出現提示時請允許系統通知權限。

> Usage-Pulse does not read the Claude Desktop app's internal (encrypted) session. Even if you only use Claude through the Claude Desktop app day to day, you still need a Claude Code login saved via the official CLI.

> Usage-Pulse 不會讀取 Claude Desktop App 內部（加密）的登入狀態。就算你平常只用 Claude Desktop，仍然需要一組透過官方 CLI 完成的 Claude Code 登入。

### Claude Code credential setup Claude Code 憑證設定

Click **Update Values** in Usage-Pulse to detect the credential and fetch usage. Whenever the Claude card has no numbers to show, it opens a panel on the spot with the exact login command to run, a **Get Credentials** button that re-checks your credential, and a box you can paste a token into instead.  
在 Usage-Pulse 按「更新數值」偵測憑證並抓取用量。只要 Claude 卡片沒有數值可顯示，就會當場展開一個區塊，裡面有要執行的登入指令、重新檢查憑證的「獲取憑證」按鈕，以及一個可以直接貼上 token 的欄位。

A pasted token is tried against your real usage before it is kept: if it can't read your usage, it isn't saved and the panel tells you why.  
貼上的 token 會先實際查一次你的用量再決定是否保留：查不到就不會存起來，並且會告訴你原因。

> Why the numbers can look different from Claude Desktop's own "Plan usage limits" panel: Usage-Pulse shows **remaining** quota, while Claude Desktop's panel shows **used** quota. `44%` remaining and `56%` used describe the same state — not a data error.

> 為什麼數字看起來跟 Claude Desktop 自己的「Plan usage limits」面板不一樣：Usage-Pulse 顯示的是**剩餘**配額，Claude Desktop 面板顯示的是**已使用**配額。「剩餘 44%」跟「已使用 56%」是同一個狀態，不是資料錯誤。

## Behavior 功能行為

I. Checks Cursor / Claude Code / Codex quota periodically in the background and alerts you on changes.  
背景會定期檢查 Cursor / Claude Code / Codex 配額，並在變化時提醒你。
II. Low-quota and quota-reset alerts can each be toggled independently, per service and per window, in Settings.  
低額度與配額重置提醒都可以在設定中依服務、依視窗個別開關。
III. Two notification channels, each toggled independently in Settings: an in-app popup (no OS permission needed, always works — top-right, auto-closes, can be snoozed) and LINE notifications (needs a Channel Access Token).  
兩種通知管道，可在設定中個別開關：App 彈窗提醒（免權限、一定生效——顯示於右上角、自動關閉、可延後）與 LINE 通知（需要 Channel Access Token）。
IV. Available in Traditional Chinese, English, Japanese, and Korean from the in-app language menu.  
支援繁體中文、英文、日文、韓文介面，可在 App 語言選單切換。
V. Quit anytime from the UI or the tray menu; if LINE is on, quitting sends a final status from the last cached reading.  
可隨時從 UI 或選單列離開；若 LINE 開啟，離開時會用最後一次快取用量送出現況。

## Security notes 安全性說明

- What's read, all read-only: Cursor's local session file, the official Claude Code CLI's saved login, and Codex's local auth file.
- 讀取項目皆為唯讀：Cursor 本機工作階段資料、官方 Claude Code CLI 已存的登入資訊、Codex 本機憑證檔。
- Usage-Pulse never writes to or modifies any of these files or credentials.
- Usage-Pulse 不會寫入或修改這些檔案或憑證。
- General settings (notification toggles, language, and the rest of Settings) are stored locally only — there's no cloud sync.
- 一般設定（通知開關、語言等）只存在本機，沒有雲端同步。

If anything appears incorrect — such as a reading that seems wrong, a notification that should not have been triggered, or any other unexpected behavior — please open a question in [Discussions Q&A](https://github.com/xiaochen26wyl/Usage-Pulse/discussions/categories/q-a-%E8%A7%A3%E6%B1%BA%E5%95%8F%E9%A1%8C) instead of making assumptions.

如果有任何行為看起來不正確——例如數值異常、理應不會觸發的通知，或其他任何預期外的狀況——請不要自行推測，並請至 [Discussions Q&A](https://github.com/xiaochen26wyl/Usage-Pulse/discussions/categories/q-a-%E8%A7%A3%E6%B1%BA%E5%95%8F%E9%A1%8C)


## License and important notice 授權與重要聲明

Usage-Pulse uses an **MIT-style license with a non-commercial default** (full terms in [`LICENSE`](LICENSE)). **Personal use and use within a company for the company's own internal purposes are both free.** Since it's provided free for company use, please have your company assess the security risk on its own before adopting it.  
Usage-Pulse 採用 **MIT 風格授權，預設僅限非商業使用**（完整條文見 [`LICENSE`](LICENSE)）。**個人使用與公司內部使用皆完全免費。** 因為是免費提供給公司使用，請公司在採用前自行評估資安風險。

**Only download Usage-Pulse from this repository's official GitHub Releases page.** Builds from any other source are not published by the original developer, and their handling of your credentials cannot be trusted.  
**請只從本 repo 官方的 GitHub Releases 頁面下載 Usage-Pulse。** 任何其他來源的安裝檔都不是原開發者發佈的版本，無法保證它如何處理你的憑證。

## Support 支援
- LINE: <https://lin.ee/6XYi49XZ>
- WhatsApp: <https://wa.me/message/ZENT2RTQIGPEI1>

If Usage-Pulse has been helpful to you, please consider starring the project on GitHub ⭐ — it’s free, quick, and greatly appreciated. You can also support the project via [GitHub Sponsors](https://github.com/sponsors/xiaochen26wyl).  
如果 Usage-Pulse 對你有幫助，歡迎到 GitHub 幫專案點一顆 ⭐——這是免費、快速，而且對我非常有幫助。你也可以透過 [GitHub Sponsors](https://github.com/sponsors/xiaochen26wyl) 贊助支持。

## Follow Developer 追蹤開發者
- Instagram: [@xiaochen26wyl](https://www.instagram.com/xiaochen26wyl/)
- Threads: [@xiaochen26wyl](https://www.threads.com/@xiaochen26wyl)
W.Y. LI — [LinkedIn](https://www.linkedin.com/in/wenyu-li-1a9868bb/) (commercial licensing & buyout / 商業授權與買斷)
