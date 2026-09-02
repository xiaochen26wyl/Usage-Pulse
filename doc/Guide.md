# Developer Guide / 專案開發指南

**Language / 語言：** [English](#english) | [繁體中文](#繁體中文)

---

## English

### Project overview
- Project name: Usage-Pulse
- Goal: monitor Cursor and Claude Code quotas from a menu bar tool on Mac / Windows, reporting changes via desktop notifications and optional LINE broadcast.
- Distribution: installers are provided via GitHub Release; no website, no app store listing.
- Architecture principle: Sidecar Observer — only reads local credentials and usage APIs, never writes back to IDE state.

### Data model
- `AppSettings` (see `src/shared/types.ts`; there is no user-facing check interval):
  - Per-service monitoring: `enableCursorMonitoring` / `enableClaudeMonitoring`
  - Cursor low-quota: `cursorModels` (`autoPercentUsed`) and advanced / other models (`apiPercentUsed`) each have their own threshold and toggle
  - Claude Code low-quota: 5-hour and weekly each have their own threshold and toggle; `enableClaudeCooldownAlert` is a lockout alert when the 5-hour window hits 0%, not a percent threshold
  - Launch: `launchWithIde` and `launchAtStartup` are mutually exclusive
  - Alarms: Cursor period-end; Claude Code 5-hour / weekly / subscription-renewal as three independent switches plus `claudeBillingCadence`
  - Other: `trayValueColorMode`, `enableAlarmPopup`, `enableLineNotification`, `claudeUseCliActivityPolling`, water-reminder interval / cup size, UI language (`zh` / `en` / `ja` / `ko`), notification cooldown
- `SessionStats`: per-launch duration, water logged, and Cursor / Claude Code usage delta since this process started
- `CombinedSnapshot`: Cursor and Claude quota snapshots
- `QuotaSnapshot.windows`: multi-window quotas (Cursor billing / cursor models / other models; Claude Code 5-hour / weekly)

### Quota sources (read-only)

#### Cursor
- Local source: `state.vscdb` (read-only query of `cursorAuth/accessToken`)
- Remote source: `https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` (falls back to `GetPlanInfo` when the included-usage limit is missing)
- Windows (`src/main/collectors/cursor.ts`):
  - `billing_cycle`: remaining included-usage amount (USD) and `billingCycleEnd`
  - `cursor_models`: `autoPercentUsed` (**used %**)
  - `other_models`: `apiPercentUsed` (**used %**)
- `monitor-engine.ts` `cursorWindowState` converts Cursor used% to remaining% before the low-quota check, so downstream alerts never have to care which way a collector counts.

#### Claude Code
- Local source: the official Claude CLI's macOS Keychain item, `Claude Code-credentials`
  (read-only — written only by `claude auth login`, never by Usage-Pulse)
- Remote source: `https://api.anthropic.com/api/oauth/usage`
- Corroborating local source: `~/.claude/projects/**/*.jsonl`, read-only, only the
  `quotaLimits` records — see "Restraint on the usage API" below
- Metrics: remaining percentage for the 5-hour window and weekly quota

#### Re-detecting a Claude Code credential
On startup, `credentialMonitor.checkAll()` reads the official, read-only
`Claude Code-credentials` Keychain item. The startup usage pass then calls the
usage API once so the interface reflects the stored credential immediately. If
Keychain is missing, or the usage API returns `claudeLoginExpired`, the Claude
card shows **Get Credentials**.

Usage-Pulse deliberately does not spawn the `claude` CLI or implement any OAuth
flow of its own. `claude setup-token`'s authorize request only ever asks for the
`user:inference` scope — a hard limitation of the official CLI, confirmed in
`anthropics/claude-code#22450` / `#11985` and unrelated to how the token is
obtained — so any workflow built around it can never satisfy the usage API's
`user:profile` requirement. Only `claude auth login` (the CLI's normal
interactive login) requests `user:profile`. Clicking **Get Credentials**
therefore just opens `https://claude.ai/login` for the user, and Settings shows
a "copy `claude auth login`" button plus instructions to run it in a terminal.
The user completes that login entirely outside Usage-Pulse — the official CLI
opens its own browser page and writes `Claude Code-credentials` itself — then
clicks **Update Values** to re-read Keychain and fetch usage. If Keychain
already holds a credential when **Get Credentials** is clicked, the app skips
straight to a quota refresh instead of reopening the login page.

A leftover `Usage-Pulse-Claude-setup-token` Keychain item from the retired
setup-token flow (pre-System-1) is removed once on startup, since it could only
ever hold a `user:inference`-only token.

### Restraint on the usage API

Usage-Pulse deliberately keeps its request volume to Anthropic low.

- **Activity-driven polling.** Claude Code re-arms a timeout after each tick
  rather than running on a fixed interval. If `claudeUseCliActivityPolling` is on
  and neither the CLI's session logs nor the credential have changed since the last
  fetch, the request is skipped entirely. The next tick still uses the normal
  schedule — the old idle stretch (`claudeIdleIntervalMinutes`, default 30 min)
  was removed.
- **Schedule.** Automatic polls run every 15 minutes (`NORMAL_POLL_INTERVAL_MS`).
  Once any of a service's windows is at or below 20% remaining, that service
  tightens to 10 minutes (`FAST_POLL_INTERVAL_MS`).
- **A single rate floor.** Every automatic trigger — the schedule, the credential
  sweep's self-heal, a rotation — passes through one minimum gap (5 minutes,
  `MIN_CLAUDE_FETCH_GAP_MS`). Only an explicit user action and the single-shot
  confirmation re-read may pass.
- **Local corroboration first (always on).** When a held alert needs a second
  opinion, the CLI's own `quotaLimits` records are consulted before any request
  is made; a rejection recorded for the same window settles it for free. This
  is built-in, not a setting.
- **Why this hasn't been shortened.** `https://api.anthropic.com/api/oauth/usage`
  — the exact endpoint Usage-Pulse calls — is the subject of two open issues on
  `anthropics/claude-code`
  ([#31021](https://github.com/anthropics/claude-code/issues/31021),
  [#31637](https://github.com/anthropics/claude-code/issues/31637)): it returns
  429s aggressively, community reports say even 30–60 second polling triggers
  it, and once tripped it can keep returning 429 for hours even after backing
  off to 5-minute retries. The community's rough safe floor is ~180 seconds,
  and only with the `User-Agent: claude-code/` header set — which
  [claude-code.ts:18](../src/main/collectors/claude-code.ts) already sends.
  Anthropic closed both issues "not planned" with no official guidance. Given
  that, the current 15/10-minute schedule plus the 5-minute
  `MIN_CLAUDE_FETCH_GAP_MS` floor is already more conservative than the
  community-observed minimum, so it is being kept as-is rather than tightened.
- **Cursor is not held to the same floor.** `api2.cursor.sh`'s
  `DashboardService/GetCurrentPeriodUsage` is an internal, undocumented RPC the
  Cursor IDE itself uses — unrelated to Cursor's public Team/Admin API docs at
  cursor.com/docs/api — so there is no official rate-limit number to check it
  against. Cursor keeps the same 15/10-minute schedule as Claude but has no
  minimum-gap floor and no CLI-activity gating; that remains an unforced,
  conservative default rather than a documented requirement.

### Codex polling

Codex does not share Claude/Cursor's fast/normal schedule. It polls on a
single fixed cadence — every 5 minutes (`CODEX_POLL_INTERVAL_MS`) — with no
separate minimum-gap floor, since the fixed interval already is the floor.
`codexUseCliActivityPolling` (on by default) still applies on top of that: if
neither the Codex CLI's session logs nor its credential have changed since the
last fetch, that tick is skipped and no request is made.

### Completed features
- Electron + React + TypeScript project skeleton (Electron `^43.4.1`)
- Sidecar Observer refactor (removed web session login flow)
- Local credential detection + API quota fetching
- Background scheduled monitoring (15 minutes normally, 10 minutes when a window is low)
- Desktop notifications (quota change / low quota / reset alerts)
- Timed alarm: an always-on-top popup in the top-right corner when due (Cursor period end / Claude window reset / subscription renewal)
- Four-language UI (Traditional Chinese / English / Japanese / Korean), switchable in Settings
- GitHub Actions Release (tag-triggered `.dmg` / `.exe`)
- CI quality gates (typecheck, readonly guard, unit tests, build, smoke build)
- Water reminder: interval popup (default 50 minutes) with “I'll go drink now” / “No, thanks”, three cup sizes (250 ml / 500 ml / 1 L), totals reset each launch
- LINE quit status: a real quit (UI or tray) calls `app.quit()`; if LINE is on, `before-quit` broadcasts up to three Flex bubbles from the cached snapshot (Cursor / Claude 5-hour / weekly). No session-summary window is shown.


### Alarm trigger precision

An alarm is only raised from a reading the app can stand behind.

- **Cold readings are held.** A reading is "cold" when it, or the reading before
  it, was a failed fetch, an unparseable payload, or no data at all. A credential
  that could not be read looks exactly like a quota that ran out, so a cold
  reading raises nothing on any channel — no popup, no LINE bubble, no desktop
  notification. If it nevertheless looks like an emergency, one confirmation is
  scheduled 90 seconds later; the alert fires only if the state survives it.
- **A reset alarm only rings for a firing it watched.** A `fireAt` is recorded
  when it is first seen while still in the future, and only such a `fireAt` may
  ring. A reset time first seen when it was already past is a gap in the app's
  own observation — the machine was off, the credential was unreadable — not a
  reset that just happened. Sleep and restart catch-up is unaffected, because the
  previous session recorded the firing as pending.
- **An outage does not disarm a real alarm.** A failed fetch blanks `resetsAt`,
  which used to silently cancel a pending alarm. The last trustworthy reset time
  per source is remembered and armed from instead.
- **Low-quota / exhausted alerts are one-shot.** Crossing a threshold or running
  out notifies once (desktop + LINE + popup) and then stays quiet in that same
  state. `notifyCooldownMinutes` only applies to quota-change and credential
  notices, not to low-quota alerts. One "event" is identified by threshold plus
  that window's reset time (`monitor-engine.ts` `fireWindowAlert`): changing the
  threshold, or the window actually resetting, is a new event and will alert
  again; quota recovering above the threshold clears the last record so the next
  drop is treated as fresh.

### Timed alarm

Usage-Pulse never touches any OS-level alarm or scheduler — the only reminder mechanism is an
in-app popup, which needs no permission of any kind. At the reset time `alarm-service.ts` opens a
frameless, always-on-top window (`alarm.html`) positioned in the
**top-right corner** of the primary display (recomputed on every show, so a resolution or
monitor-arrangement change never leaves it off-screen). Quota / reset / low-quota popups are
**silent** (`soundEnabled: false`); the water reminder uses a synthesised chime. It is shown with
`showInactive()` so it never steals the keystroke you are in the middle of typing, and closes
itself after `ALARM_POPUP_AUTO_DISMISS_SECONDS` (30 seconds; not a setting). Quota popups can be
snoozed for 5 minutes (`SNOOZE_MS`).
OS-native desktop notifications are also closed by `sendPlainDesktopNotification` after the
same 30-second window.

How to be notified is two peer switches: the app popup (`enableAlarmPopup`) and LINE
(`enableLineNotification`; a token must still be pasted below before anything is sent). Each
service's reminder switches sit on the same card as that service's low-quota threshold — no
separate "Reset Alarm" card, no OS-level configuration. Cursor's switch is **period-end**
(`billingCycleEnd`, which is both the included-usage reset and the billing date). Claude Code
splits three independent switches: **5-hour reset**, **weekly reset** (usage windows from
`/api/oauth/usage`), and **subscription renewal** (derived from
`/api/oauth/profile` `subscription_created_at` plus the monthly/annual cadence
setting). The subscription date does not refill quota. Max plans are monthly
only; an annual Pro plan uses the yearly anniversary of that anchor. Switching from monthly
to annual mid-stream may still use the original subscribe date as the anchor.

Two failure modes of the old reset alert are fixed here:

- **Catch-up.** A firing that came due while the machine slept used to be dropped outright. A
  `fireAt` that was observed while still in the future may ring after wake **no matter how late**
  — there is no `alarmCatchUpMinutes` window and no catch-up marker. `alarmFires` in the store
  records which `fireAt` already rang, so re-arming never double-fires.
- **Sleep and wake.** `powerMonitor` `resume` / `unlock-screen` rebuild the schedule, because
  Chromium timers do not advance while the machine is asleep.


### Security constraints
- OAuth tokens are only held briefly in memory.
- Writing to `state.vscdb` or `.credentials.json` is forbidden.
- Claude Code credentials are entirely read-only: Usage-Pulse never spawns the `claude` CLI, never implements OAuth itself, and never writes to the official `Claude Code-credentials` Keychain item. The only Keychain write it ever performs is a one-time, best-effort deletion of the retired `Usage-Pulse-Claude-setup-token` item left over from the old setup-token flow.
- **Get Credentials** only opens `https://claude.ai/login` via `shell.openExternal`; the user completes `claude auth login` entirely in their own terminal, outside the app.
- On a 401 or missing quota data, return an actionable error message; never perform automatic token refresh.

### Development and packaging

#### Common commands
- `pnpm dev`: start Electron in development mode
- `pnpm typecheck`: TypeScript type checking
- `pnpm check:readonly`: readonly-boundary guard check
- `pnpm test:unit`: unit tests
- `pnpm build`: build the application
- `pnpm smoke:build`: smoke test on the build output
- `pnpm dist:mac`: produce a macOS `.dmg`
- `pnpm dist:win`: produce a Windows `.exe`
- Git daily workflow (`start-work` / `push-wip` / `finish-work`) → [`doc/Git_Workflow.md`](Git_Workflow.md)

#### Before every release (local)
1. `pnpm install`
2. `pnpm typecheck`
3. `pnpm check:readonly`
4. `pnpm test:unit`
5. `pnpm build`
6. `pnpm smoke:build`
7. `pnpm dist:mac` and `pnpm dist:win`
8. Actually open the installer and confirm the app launches

#### Releasing (tag)
1. Confirm `package.json`'s `version` matches the intended tag (e.g. `1.0.0` for `v1.0.0`)
2. Create and push the tag:
   - `git tag v1.0.0`
   - `git push origin v1.0.0`
3. GitHub Actions will automatically build and publish the Release artifacts

---

## 繁體中文

### 專案概述
- 專案名稱：Usage-Pulse
- 目標：在 Mac / Windows 以選單列工具方式監控 Cursor 與 Claude Code 配額，並以桌面通知與可選的 LINE 廣播回報變化。
- 發布方式：使用 GitHub Release 提供安裝檔，不建立網站，不上架 Store。
- 架構原則：Sidecar Observer（旁路觀察者），僅讀取本機憑證與用量 API，不寫回 IDE 狀態。

### 資料架構
- `AppSettings`（見 `src/shared/types.ts`；沒有使用者可調的檢查頻率）：
  - 服務開關：`enableCursorMonitoring` / `enableClaudeMonitoring`
  - Cursor 低額度：`cursorModels`（`autoPercentUsed`）與進階／其他模型（`apiPercentUsed`）各自有閾值與開關
  - Claude Code 低額度：5 小時與每週各自有閾值與開關；`enableClaudeCooldownAlert` 是 5 小時視窗用盡鎖定的提醒，不是百分比閾值
  - 啟動：`launchWithIde` 與 `launchAtStartup` 互斥
  - 鬧鐘：Cursor 本期到期；Claude Code 5 小時／每週／訂閱到期三個獨立開關，加上 `claudeBillingCadence`
  - 其他：`trayValueColorMode`、`enableAlarmPopup`、`enableLineNotification`、`claudeUseCliActivityPolling`、喝水提醒間隔／杯量、介面語言（`zh`／`en`／`ja`／`ko`）、通知冷卻時間
- `SessionStats`：本次啟動的使用時長、已記喝水量，以及 Cursor／Claude Code 相對啟動時的用量增量
- `CombinedSnapshot`：Cursor 與 Claude 配額快照
- `QuotaSnapshot.windows`：多視窗配額（Cursor 計費週期／Cursor 模型／其他模型；Claude Code 的 5 小時／每週）

### 配額來源（唯讀）

#### Cursor
- 本機來源：`state.vscdb`（唯讀查詢 `cursorAuth/accessToken`）
- 遠端來源：`https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`（included-usage 上限缺失時再打 `GetPlanInfo`）
- 視窗（`src/main/collectors/cursor.ts`）：
  - `billing_cycle`：included usage 剩餘金額（USD）與 `billingCycleEnd`
  - `cursor_models`：`autoPercentUsed`（**已使用 %**）
  - `other_models`：`apiPercentUsed`（**已使用 %**）
- `monitor-engine.ts` 的 `cursorWindowState` 會把 Cursor 的 used% 轉成 remaining% 再判斷低額度，下游警告不必管 collector 怎麼計。

#### Claude Code
- 本機來源：官方 Claude CLI 的 macOS Keychain `Claude Code-credentials`（唯讀——只由
  `claude auth login` 寫入，Usage-Pulse 不曾寫入）
- 遠端來源：`https://api.anthropic.com/api/oauth/usage`
- 佐證用本機來源：`~/.claude/projects/**/*.jsonl`，唯讀，且只取 `quotaLimits`
  紀錄——詳見下方「對 usage API 的節制」
- 指標：5 小時視窗與每週配額剩餘百分比

#### 重新偵測 Claude Code 憑證
啟動時，`credentialMonitor.checkAll()` 會以唯讀方式檢查官方的
`Claude Code-credentials` 項目。接著 startup usage pass 會打一次 usage API，讓介面立刻反映
已存憑證的數值。若 Keychain 沒有憑證，或 usage API 回 `claudeLoginExpired`，Claude
卡片會顯示「獲取憑證」。

Usage-Pulse 刻意不 spawn `claude` CLI，也不自己實作任何 OAuth 流程。`claude
setup-token` 的授權請求天生只會要求 `user:inference` scope——這是官方 CLI 本身
的限制（見 `anthropics/claude-code#22450` / `#11985`），跟呼叫方式無關，任何圍繞它
建的流程都不可能滿足 usage API 需要的 `user:profile`。只有 `claude auth login`
（CLI 的一般互動登入）會要求 `user:profile`。因此點擊「獲取憑證」只會用
`shell.openExternal` 打開 `https://claude.ai/login`，Settings 同時顯示複製
`claude auth login` 指令的按鈕與說明，請使用者在自己的終端機執行。整個登入完全
在 Usage-Pulse 之外完成——官方 CLI 自己開瀏覽器、自己寫入 `Claude Code-credentials`
——使用者完成後點「更新數值」重新讀取 Keychain 並抓用量。若點擊「獲取憑證」時
Keychain 已經有憑證，App 會直接更新用量，不會再打開登入頁。

啟動時會一次性靜默刪除舊 setup-token 流程（System 1 之前）留下的
`Usage-Pulse-Claude-setup-token` Keychain 項目，因為它天生只可能裝著
`user:inference`-only 的 token。

### 對 usage API 的節制

Usage-Pulse 刻意把送往 Anthropic 的請求次數壓到最低。

- **活動驅動輪詢**：Claude Code 不跑固定 interval，而是每次 tick 後自行重排。若
  `claudeUseCliActivityPolling` 開啟，且 CLI 的 session 紀錄與憑證自上次抓取以來都沒有
  動靜，就**完全跳過**這次請求。下一次 tick 仍用一般排程——舊的閒置拉長
  （`claudeIdleIntervalMinutes`，預設 30 分鐘）已刪除。
- **排程**：自動輪詢一般每 15 分鐘（`NORMAL_POLL_INTERVAL_MS`）。任一視窗 remaining
  ≤ 20% 時，該服務收緊到 10 分鐘（`FAST_POLL_INTERVAL_MS`）。
- **單一最小間隔**：排程、憑證掃描的自我修復、憑證輪替等所有自動觸發，都要通過同一道
  5 分鐘的最小間隔（`MIN_CLAUDE_FETCH_GAP_MS`）；只有使用者明確操作與那一次單發的補確認
  可以通過。
- **先查本機再打 API（一律開啟）**：被暫緩的警告需要第二意見時，先看 CLI 自己的
  `quotaLimits` 紀錄；同一個視窗有被拒絕的紀錄就直接成立，一個請求都不用花。這是內建行為，沒有開關。
- **為什麼沒有把這段縮短**：Usage-Pulse 打的正是
  `https://api.anthropic.com/api/oauth/usage` 這支端點，而它正是
  `anthropics/claude-code` repo 上兩個公開 issue 的主角
  （[#31021](https://github.com/anthropics/claude-code/issues/31021)、
  [#31637](https://github.com/anthropics/claude-code/issues/31637)）：這支端點會
  很激進地回 429，社群回報連 30-60 秒的輪詢都會觸發，一旦卡住即使退避到 5 分鐘
  間隔仍可能持續 429 好幾個小時不會自己恢復；社群測出來「較安全」的下限大約是
  180 秒，且前提是要帶對 `User-Agent: claude-code/`——
  [claude-code.ts:18](../src/main/collectors/claude-code.ts) 已經在送這個
  header。這兩個 issue 都被 Anthropic 標記「not planned」關閉，官方沒有給出正式
  的輪詢頻率建議。既然如此，目前 15/10 分鐘排程加上 5 分鐘的
  `MIN_CLAUDE_FETCH_GAP_MS` floor 本來就比社群回報的下限更保守，這次維持原樣，
  不調快。
- **Cursor 不套用同一道 floor**：`api2.cursor.sh` 的
  `DashboardService/GetCurrentPeriodUsage` 是 Cursor IDE 自己用的內部、未公開
  RPC，跟 cursor.com/docs/api 上給 Team/Admin 用的公開 API 是兩回事，找不到任何
  針對這支內部端點的官方頻率限制數字可以比對。Cursor 沿用跟 Claude 一樣的
  15/10 分鐘排程，但沒有最短間隔 floor，也沒有 CLI 活動閘門；這只是一個沒有官方
  數字背書、自我克制的預設值，這次不變動。

### Codex 輪詢

Codex 不套用 Claude/Cursor 的正常/低額度雙檔排程，而是走單一固定間隔——每 5
分鐘一次（`CODEX_POLL_INTERVAL_MS`），沒有獨立的最短間隔 floor，因為固定間隔本身
就是 floor。`codexUseCliActivityPolling`（預設開啟）仍然會疊加在上面：若 Codex
CLI 的 session 紀錄與憑證自上次抓取以來都沒有動靜，這次 tick 就會跳過，不打
API。

### 已完成功能
- Electron + React + TypeScript 專案骨架（Electron `^43.4.1`）
- Sidecar Observer 改造（移除網頁 Session 登入流程）
- 本機憑證偵測 + API 配額抓取
- 背景抓取與排程監控（一般 15 分鐘；視窗偏低時 10 分鐘）
- 桌面通知（配額變化 / 低額度 / 重置提醒）
- 到點／到期提醒：時間到點在螢幕右上角彈出置頂視窗（Cursor 為本期到期，Claude 為視窗重置／訂閱到期）
- 四語介面（繁體中文／英文／日文／韓文），可在設定內切換
- GitHub Actions Release（tag 觸發 `.dmg` / `.exe`）
- CI 品質檢查（typecheck、readonly guard、unit test、build、smoke build）
- 喝水提醒：依間隔彈窗（預設 50 分鐘），按鈕為「我現在去喝／不，謝謝」；杯量僅 250 ml／500 ml／1 L，水量每次開啟 App 後重新累計
- LINE 結束現況：真正關閉（UI 或 tray）都是 `app.quit()`；若 LINE 開啟，`before-quit` 用快取 snapshot 最多送 3 則 Flex（Cursor／Claude 5 小時／每週）。不會跳出結束統計視窗。


### 警告觸發精確度

只有站得住腳的資料才會觸發警告。

- **冷讀一律暫緩**：當這一筆、或前一筆是抓取失敗、無法解析、或根本沒資料時，這次讀數就算「冷讀」。
  讀不到憑證跟配額真的用完長得一模一樣，所以冷讀不會從任何管道發出東西——沒有彈窗、沒有 LINE、
  沒有桌面通知。若它看起來仍像緊急狀況，會在 90 秒後安排一次補確認，狀態撐過去才真的發警告。
- **到點鬧鐘只為自己看著跑完的那一次響**：某個 `fireAt` 要在還沒到期時被觀察到才會被記錄，也只有
  被記錄過的 `fireAt` 才有資格響。第一次看到就已經是過去式的重置時間，是我們自己觀察上的空窗
  （機器關著、憑證讀不到），不是剛剛發生了重置。睡眠與重啟的補發不受影響，因為上一輪 session
  早就把它記成 pending 了。
- **中斷不會把真的鬧鐘解除掉**：抓取失敗會讓 `resetsAt` 變成 null，過去這會靜靜取消一個待響的
  鬧鐘。現在每個來源最後一次可信的重置時間都會被記住，中斷期間改用它來排程。
- **低額度／用盡提醒是一次性的**：跨過閾值或配額用盡時只通知一次（桌面通知＋LINE＋彈窗），之後
  即使一直卡在同一個狀態也不會再重複——`notifyCooldownMinutes` 只影響配額變化通知與憑證通知，
  跟低額度提醒無關。同一次「事件」由「閾值＋該視窗的重置時間」共同識別（`monitor-engine.ts` 的
  `fireWindowAlert`）：改動閾值設定，或視窗真的重置到下一輪，都算新事件，會重新提醒一次；額度
  真的回升到閾值之上，則會清掉上一次的紀錄，下次再跌破閾值就當作全新事件重新提醒。

### 到點提醒

Usage-Pulse 完全不碰任何作業系統層級的鬧鐘或排程器——App 內彈窗不需要任何權限。時間到點時，
`alarm-service.ts` 會開啟一個無邊框、置頂的視窗（`alarm.html`），顯示位置固定在主螢幕的
**右上角**（每次顯示時都會重新計算座標，所以解析度或多螢幕排列變動也不會讓視窗跑到畫面外）。
配額／重置／低額度彈窗**靜音**（`soundEnabled: false`）；喝水提醒才用合成 chime。用
`showInactive()` 顯示，所以不會搶走你正在輸入的鍵盤焦點。經過
`ALARM_POPUP_AUTO_DISMISS_SECONDS`（30 秒，不是設定項）後自動關閉。配額彈窗可延後 5 分鐘
（`SNOOZE_MS`）。
OS 原生桌面通知也會由 `sendPlainDesktopNotification` 在同樣的 30 秒後主動關閉。

「用什麼方式提醒」是兩個平級開關：App 彈窗（`enableAlarmPopup`）與 LINE 通知
（`enableLineNotification`；仍須在下方區塊貼 Token 才會真的送出）。各服務的開關跟該服務的
低額度預警閾值放在同一張卡片裡——沒有獨立的「重置鬧鐘」卡片，也沒有任何作業系統層級的設定。
Cursor 是「到期提醒」（本期 `billingCycleEnd`，用量重設與計費同一天）。Claude Code 拆成三個獨立開關：5 小時到點、每週配額到點（`/api/oauth/usage` 的用量視窗），以及訂閱到期（`/api/oauth/profile` 的 `subscription_created_at` 加上月繳／年繳週年推算）。訂閱到期**不會**重設 5 小時或每週配額。Max 目前只有月繳；年繳 Pro 用該錨點的年週年。若中途從月繳改年繳，錨點可能仍是原始訂閱日。

這個機制同時修掉舊版重置提醒的兩個缺陷：

- **補發**：過去只要到點時機器在睡覺，那次提醒就直接被丟棄。曾在未來被觀察到的 `fireAt`，喚醒後
  **不論多晚**都可以響——沒有 `alarmCatchUpMinutes` 時間窗，也沒有補發標記。store 的 `alarmFires`
  記錄哪個 `fireAt` 已經響過，所以重新排程不會重複觸發。
- **睡眠與喚醒**：`powerMonitor` 的 `resume` / `unlock-screen` 會重建排程——Chromium 的計時器在系統
  睡眠期間不會前進。


### 安全約束
- OAuth token 僅在記憶體中短暫使用。
- 禁止寫入 `state.vscdb`、`.credentials.json`。
- Claude Code 憑證完全唯讀：Usage-Pulse 不 spawn `claude` CLI、不自己實作 OAuth，也不寫入官方的 `Claude Code-credentials` Keychain 項目。唯一會做的 Keychain 寫入，是啟動時一次性、盡力刪除舊 setup-token 流程留下的 `Usage-Pulse-Claude-setup-token` 項目。
- 「獲取憑證」只會用 `shell.openExternal` 打開 `https://claude.ai/login`；使用者完全在自己的終端機執行 `claude auth login` 完成登入，App 不參與。
- 發生 401 / 配額資料缺失時，回傳可行動的錯誤訊息，不做自動 token refresh。

### 開發與打包

#### 常用指令
- `pnpm dev`：啟動 Electron 開發模式
- `pnpm typecheck`：TypeScript 型別檢查
- `pnpm check:readonly`：唯讀防護檢查
- `pnpm test:unit`：單元測試
- `pnpm build`：建置應用程式
- `pnpm smoke:build`：建置產物煙測
- `pnpm dist:mac`：輸出 macOS `.dmg`
- `pnpm dist:win`：輸出 Windows `.exe`
- Git 日常流程（開工／推送／收工）→ [`doc/Git_Workflow.md`](Git_Workflow.md)

#### 發版前必做（本機）
1. `pnpm install`
2. `pnpm typecheck`
3. `pnpm check:readonly`
4. `pnpm test:unit`
5. `pnpm build`
6. `pnpm smoke:build`
7. `pnpm dist:mac` 與 `pnpm dist:win`
8. 實際打開安裝檔，確認應用程式可啟動

#### 發版（tag）
1. 確認 `package.json` 的 `version` 與預計 tag 一致（例如 `1.0.0` 對 `v1.0.0`）
2. 建立並推送 tag：
   - `git tag v1.0.0`
   - `git push origin v1.0.0`
3. GitHub Actions 會自動建置並發佈 Release 檔案
