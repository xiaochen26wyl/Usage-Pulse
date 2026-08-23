# Developer Guide / 專案開發指南

**Language / 語言：** [English](#english) | [繁體中文](#繁體中文)

---

## English

### Project overview
- Project name: Usage-Pulse
- Goal: monitor Cursor and Claude Code quotas from a menu bar tool on Mac / Windows, reporting changes via desktop notifications.
- Distribution: installers are provided via GitHub Release; no website, no app store listing.
- Architecture principle: Sidecar Observer — only reads local credentials and usage APIs, never writes back to IDE state.

### Data model
- `AppSettings`: check interval, low-quota threshold, launch-with-Cursor-or-Claude-Code, notification cooldown, reset/low-quota alert toggles, UI language, water-reminder interval / cup size
- `SessionStats`: per-launch duration, water logged, and Cursor / Claude Code usage delta since this process started
- `CombinedSnapshot`: Cursor and Claude quota snapshots
- `QuotaSnapshot.windows`: multi-window quotas (e.g. Claude Code's 5-hour / weekly windows)

### Quota sources (read-only)

#### Cursor
- Local source: `state.vscdb` (read-only query of `cursorAuth/accessToken`)
- Remote source: `https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`
- Metrics: remaining included-usage amount (USD) and reset time

#### Claude Code
- Local source (priority order):
  - `CLAUDE_CODE_OAUTH_TOKEN`
  - A token the user pasted in by hand (`claude setup-token`), stored encrypted
  - macOS Keychain `Claude Code-credentials`
  - `~/.claude/.credentials.json` (or `CLAUDE_CONFIG_DIR/.credentials.json`)
- Remote source: `https://api.anthropic.com/api/oauth/usage`
- Corroborating local source: `~/.claude/projects/**/*.jsonl`, read-only, only the
  `quotaLimits` records — see "Restraint on the usage API" below
- Metrics: remaining percentage for the 5-hour window and weekly quota

#### Manual credential entry (CLI users)
Automatic detection gets two goes before the user is interrupted. After two
consecutive sweeps conclude the Claude Code credential is unusable, a focusable
window opens with the `claude setup-token` command and a field to paste the
result into. The token is verified against the usage API before it is stored,
never written if it fails, encrypted at rest, and never handed back to a
renderer — `settings:get` returns a placeholder. Settings has a button to
reopen the window or clear the stored token.

Claude's **Re-detect Credentials** button looks in the `Claude Code-credentials`
Keychain item first. If that item is missing it opens a system terminal running
`claude setup-token`; after you finish the official login page the app reads the
printed `sk-ant-oat01-` token itself and writes it back to that same Keychain
item (and to the encrypted app store). The paste window remains as a fallback.

### Restraint on the usage API

Usage-Pulse deliberately keeps its request volume to Anthropic low.

- **Activity-driven polling.** Claude Code re-arms a timeout after each tick
  rather than running on a fixed interval. If neither the CLI's session logs nor
  the credential have changed since the last fetch, the request is skipped
  entirely and the next tick is pushed out to the idle interval (default 30 min).
- **A single rate floor.** Every automatic trigger — the schedule, the credential
  sweep's self-heal, a rotation — passes through one minimum gap (5 minutes).
  Only an explicit user action and the single-shot confirmation re-read may pass.
- **Local corroboration first (always on).** When a held alert needs a second
  opinion, the CLI's own `quotaLimits` records are consulted before any request
  is made; a rejection recorded for the same window settles it for free. This
  is built-in, not a setting.

### Completed features
- Electron + React + TypeScript project skeleton
- Sidecar Observer refactor (removed web session login flow)
- Local credential detection + API quota fetching
- Background scheduled monitoring (default: every 10 minutes)
- Desktop notifications (quota change / low quota / reset alerts)
- Timed alarm: an always-on-top popup in the top-right corner when due, with catch-up for alarms missed during sleep (Cursor period end / Claude window reset)
- Bilingual UI (Traditional Chinese / English), switchable in Settings
- GitHub Actions Release (tag-triggered `.dmg` / `.exe`)
- CI quality gates (typecheck, readonly guard, unit tests, build, smoke build)
- Water reminder: interval popup (default 50 minutes) with “I'll go drink now” / “No, thanks”, three cup sizes (250 ml / 500 ml / 1 L), totals reset each launch
- Session summary on quit: any real quit shows Cursor / Claude Code usage this launch, time open, and water drunk, with Keep using / Quit


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

### Timed alarm

Usage-Pulse never touches any OS-level alarm or scheduler — the only reminder mechanism is an
in-app popup, which needs no permission of any kind. At the reset time `alarm-service.ts` opens a
frameless, always-on-top window (`alarm.html`) with a synthesised chime, positioned in the
**top-right corner** of the primary display (recomputed on every show, so a resolution or
monitor-arrangement change never leaves it off-screen). It is shown with `showInactive()` so it
never steals the keystroke you are in the middle of typing, and closes itself after
`alarmPopupAutoDismissMinutes` (default 5).

Settings shows the popup toggle and the per-service reminder switch alongside
each service's low-quota threshold — no separate "Reset Alarm" card, no OS-level
configuration. Cursor's switch is **period-end** (`billingCycleEnd`, which is
both the included-usage reset and the billing date). Claude Code splits three
independent switches: **5-hour reset**, **weekly reset** (usage windows from
`/api/oauth/usage`), and **subscription renewal** (derived from
`/api/oauth/profile` `subscription_created_at` plus the monthly/annual cadence
setting). The subscription date does not refill quota. Max plans are monthly
only; an annual Pro plan uses the yearly anniversary of that anchor.

Two failure modes of the old reset alert are fixed here:

- **Catch-up.** A firing that came due while the machine slept used to be dropped outright. It now
  replays once, marked as a catch-up, as long as it is within `alarmCatchUpMinutes` (default 30).
  `alarmFires` in the store records which `fireAt` already rang, so re-arming never double-fires.
- **Sleep and wake.** `powerMonitor` `resume` / `unlock-screen` rebuild the schedule, because
  Chromium timers do not advance while the machine is asleep.


### Security constraints
- OAuth tokens are only held briefly in memory except for the setup-token exception below.
- Writing to `state.vscdb` or `.credentials.json` is forbidden.
- The one Keychain write is the long-lived token from `claude setup-token`, stored in `Claude Code-credentials` after the user completes official CLI OAuth.
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
- 目標：在 Mac / Windows 以選單列工具方式監控 Cursor 與 Claude Code 配額，並以桌面通知回報變化。
- 發布方式：使用 GitHub Release 提供安裝檔，不建立網站，不上架 Store。
- 架構原則：Sidecar Observer（旁路觀察者），僅讀取本機憑證與用量 API，不寫回 IDE 狀態。

### 資料架構
- `AppSettings`：檢查頻率、低額度閾值、開啟 Cursor／Claude Code 時一併啟動、通知冷卻時間、重置提醒與低額度提醒開關、介面語言、喝水提醒間隔／杯量
- `SessionStats`：本次啟動的使用時長、已記喝水量，以及 Cursor／Claude Code 相對啟動時的用量增量
- `CombinedSnapshot`：Cursor 與 Claude 配額快照
- `QuotaSnapshot.windows`：多視窗配額（例如 Claude Code 的 5 小時 / 每週）

### 配額來源（唯讀）

#### Cursor
- 本機來源：`state.vscdb`（唯讀查詢 `cursorAuth/accessToken`）
- 遠端來源：`https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`
- 指標：included usage 剩餘金額（USD）與重置時間

#### Claude Code
- 本機來源（優先序）：
  - `CLAUDE_CODE_OAUTH_TOKEN`
  - 使用者手動貼上的 token（`claude setup-token`），加密存放
  - macOS Keychain `Claude Code-credentials`
  - `~/.claude/.credentials.json`（或 `CLAUDE_CONFIG_DIR/.credentials.json`）
- 遠端來源：`https://api.anthropic.com/api/oauth/usage`
- 佐證用本機來源：`~/.claude/projects/**/*.jsonl`，唯讀，且只取 `quotaLimits`
  紀錄——詳見下方「對 usage API 的節制」
- 指標：5 小時視窗與每週配額剩餘百分比

#### 手動輸入憑證（CLI 使用者）
自動偵測會先試兩次才打擾使用者。連續兩輪掃描都判定 Claude Code 憑證不可用之後，才會彈出一個
可聚焦的視窗，裡面有 `claude setup-token` 指令與貼上結果的輸入格。token 會先向 usage API 驗證
過才儲存，驗證失敗一律不寫入；存放時加密，而且永遠不會回傳給任何 renderer——`settings:get`
只回一個佔位字串。設定頁有按鈕可以重新叫出這個視窗或清除已存的 token。

Claude 的「重新偵測憑證」會先查 Keychain 的 `Claude Code-credentials`。沒有才打開系統終端機
跑 `claude setup-token`；你在官方登入頁完成授權後，程式自己從輸出收回 `sk-ant-oat01-` token，
再寫回同一組 Keychain（以及 App 自己的加密 store）。手動貼上視窗仍保留當備援。

### 對 usage API 的節制

Usage-Pulse 刻意把送往 Anthropic 的請求次數壓到最低。

- **活動驅動輪詢**：Claude Code 不跑固定 interval，而是每次 tick 後自行重排。若 CLI 的 session
  紀錄與憑證自上次抓取以來都沒有動靜，就**完全跳過**這次請求，並把下一次 tick 推到閒置間隔
  （預設 30 分鐘）。
- **單一最小間隔**：排程、憑證掃描的自我修復、憑證輪替等所有自動觸發，都要通過同一道 5 分鐘的
  最小間隔；只有使用者明確操作與那一次單發的補確認可以通過。
- **先查本機再打 API（一律開啟）**：被暫緩的警告需要第二意見時，先看 CLI 自己的
  `quotaLimits` 紀錄；同一個視窗有被拒絕的紀錄就直接成立，一個請求都不用花。這是內建行為，沒有開關。

### 已完成功能
- Electron + React + TypeScript 專案骨架
- Sidecar Observer 改造（移除網頁 Session 登入流程）
- 本機憑證偵測 + API 配額抓取
- 背景抓取與排程監控（預設 10 分鐘）
- 桌面通知（配額變化 / 低額度 / 重置提醒）
- 到點／到期提醒：時間到點在螢幕右上角彈出置頂視窗，睡眠期間錯過的提醒會補發（Cursor 為本期到期，Claude 為視窗重置）
- 中英雙語介面，可在設定內切換
- GitHub Actions Release（tag 觸發 `.dmg` / `.exe`）
- CI 品質檢查（typecheck、readonly guard、unit test、build、smoke build）
- 喝水提醒：依間隔彈窗（預設 50 分鐘），按鈕為「我現在去喝／不，謝謝」；杯量僅 250 ml／500 ml／1 L，水量每次開啟 App 後重新累計
- 結束統計：任何真正關閉 App 的動作都會先顯示本次 Cursor／Claude Code 用量、使用時長與總喝水量，可繼續使用或結束


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

### 到點提醒

Usage-Pulse 完全不碰任何作業系統層級的鬧鐘或排程器——App 內彈窗不需要任何權限。時間到點時，
`alarm-service.ts` 會開啟一個無邊框、置頂的視窗（`alarm.html`），顯示位置固定在主螢幕的
**右上角**（每次顯示時都會重新計算座標，所以解析度或多螢幕排列變動也不會讓視窗跑到畫面外）。
彈窗一律靜音。用 `showInactive()` 顯示，所以不會搶走你正在輸入的鍵盤焦點。經過
`ALARM_POPUP_AUTO_DISMISS_MINUTES`（預設 1 分鐘）後自動關閉。

「用什麼方式提醒」是兩個平級開關：App 彈窗（`enableAlarmPopup`）與 LINE 通知
（`enableLineNotification`；仍須在下方區塊貼 Token 才會真的送出）。各服務的開關跟該服務的
低額度預警閾值放在同一張卡片裡——沒有獨立的「重置鬧鐘」卡片，也沒有任何作業系統層級的設定。
Cursor 是「到期提醒」（本期 `billingCycleEnd`，用量重設與計費同一天）。Claude Code 拆成三個獨立開關：5 小時到點、每週配額到點（`/api/oauth/usage` 的用量視窗），以及訂閱到期（`/api/oauth/profile` 的 `subscription_created_at` 加上月繳／年繳週年推算）。訂閱到期**不會**重設 5 小時或每週配額。Max 目前只有月繳；年繳 Pro 用該錨點的年週年。若中途從月繳改年繳，錨點可能仍是原始訂閱日。

這個機制同時修掉舊版重置提醒的兩個缺陷：

- **補發**：過去只要到點時機器在睡覺，那次提醒就直接被丟棄。現在只要還在 `alarmCatchUpMinutes`
  （預設 30 分鐘）之內就會補發一次並標記為補發。store 的 `alarmFires` 記錄哪個 `fireAt` 已經響過，
  所以重新排程不會重複觸發。
- **睡眠與喚醒**：`powerMonitor` 的 `resume` / `unlock-screen` 會重建排程——Chromium 的計時器在系統
  睡眠期間不會前進。


### 安全約束
- OAuth token 僅在記憶體中短暫使用，setup-token 永久憑證除外（見下）。
- 禁止寫入 `state.vscdb`、`.credentials.json`。
- 唯一的 Keychain 寫入：使用者在官方 CLI OAuth 完成後，把 `claude setup-token` 的永久 token 寫進 `Claude Code-credentials`。
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
