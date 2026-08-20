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
- `AppSettings`: check interval, low-quota threshold, launch-at-login, notification cooldown, reset/low-quota alert toggles, UI language
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
  - macOS Keychain `Claude Code-credentials`
  - `~/.claude/.credentials.json` (or `CLAUDE_CONFIG_DIR/.credentials.json`)
- Remote source: `https://api.anthropic.com/api/oauth/usage`
- Metrics: remaining percentage for the 5-hour window and weekly quota

### Completed features
- Electron + React + TypeScript project skeleton
- Sidecar Observer refactor (removed web session login flow)
- Local credential detection + API quota fetching
- Background scheduled monitoring (default: every 10 minutes)
- Desktop notifications (quota change / low quota / reset alerts)
- Timed alarm: an always-on-top popup at reset time, with catch-up for alarms missed during sleep
- Optional system alarm (macOS LaunchAgent / Shortcuts, Windows Task Scheduler) with OS-verified status
- Bilingual UI (Traditional Chinese / English), switchable in Settings
- GitHub Actions Release (tag-triggered `.dmg` / `.exe`)
- CI quality gates (typecheck, readonly guard, unit tests, build, smoke build)


### Timed alarm (L0) and system alarm (L1)

The alarm is deliberately layered, because every layer that leans on the OS adds a permission
surface that can silently stop working.

**L0 — in-app popup. No permission of any kind.** At the reset time `alarm-service.ts` opens a
frameless, always-on-top window (`alarm.html`) with a synthesised chime, shown with `showInactive()`
so it never steals the keystroke you are in the middle of typing. It closes itself after
`alarmPopupAutoDismissMinutes` (default 5). Nothing in System Settings can switch this off.

Two failure modes of the old reset alert are fixed here:

- **Catch-up.** A firing that came due while the machine slept used to be dropped outright. It now
  replays once, marked as a catch-up, as long as it is within `alarmCatchUpMinutes` (default 30).
  `alarmFires` in the store records which `fireAt` already rang, so re-arming never double-fires.
- **Sleep and wake.** `powerMonitor` `resume` / `unlock-screen` rebuild the schedule, because
  Chromium timers do not advance while the machine is asleep.

**L1 — system alarm. Optional, off by default, two independent switches.**

| | Wake app | Native alarm |
|---|---|---|
| macOS | LaunchAgent in `~/Library/LaunchAgents` | Shortcuts → Clock app alarm |
| Windows | `schtasks` task launching the app | `schtasks` task raising a looping toast |

Status is **always probed against the OS** — `launchctl print`, `shortcuts run`, `schtasks /Query` —
never read from a cached flag, and the UI shows when it was last verified. Use **Re-arm system
alarm** in Settings whenever the light is not green; a reboot, a manual deletion in the Clock app,
or a revoked permission all show up as `stale`.

Note that neither the LaunchAgent nor a Shortcuts alarm wakes a sleeping Mac reliably — treat L1 as
"works when the app is closed", not as "works when the machine is asleep".

#### Installing the macOS shortcuts (required for the native alarm)

The `shortcuts` CLI can only run and sign shortcuts, not create them, so these three must be built
once by hand in the Shortcuts app. The names must match exactly.

1. **`Usage-Pulse Set Alarm`** — accepts text input (an ISO 8601 timestamp):
   - Find Alarms where Name is `Usage-Pulse`
   - Delete Alarm (the result of the previous step)
   - Create Alarm — Time: parsed from the input, Name: `Usage-Pulse`, Repeat: Never, Snooze: Off
2. **`Usage-Pulse Clear Alarm`** — Find Alarms where Name is `Usage-Pulse` → Delete Alarm
3. **`Usage-Pulse Check Alarm`** — Find Alarms where Name is `Usage-Pulse` → output the alarm time
   as text (empty output means no alarm)

Shortcut 1 deletes before creating, which is what keeps exactly one Usage-Pulse alarm in the Clock
app no matter how often it is re-armed.

#### Known limitation: the app is unsigned

`package.json` sets `mac.identity: null`. macOS ties TCC (Automation) grants to a code signature, so
an unsigned build is treated as a different app after every rebuild and previously granted
permissions are voided. This is why the native alarm goes through Shortcuts (App Intents) rather
than Calendar AppleScript, which would need Automation access. Signing the app is the long-term fix.


### Security constraints
- OAuth tokens are only held briefly in memory and never written back to any IDE credential source.
- Writing to `state.vscdb`, `.credentials.json`, or Keychain is forbidden.
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
- `AppSettings`：檢查頻率、低額度閾值、開機啟動、通知冷卻時間、重置提醒與低額度提醒開關、介面語言
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
  - macOS Keychain `Claude Code-credentials`
  - `~/.claude/.credentials.json`（或 `CLAUDE_CONFIG_DIR/.credentials.json`）
- 遠端來源：`https://api.anthropic.com/api/oauth/usage`
- 指標：5 小時視窗與每週配額剩餘百分比

### 已完成功能
- Electron + React + TypeScript 專案骨架
- Sidecar Observer 改造（移除網頁 Session 登入流程）
- 本機憑證偵測 + API 配額抓取
- 背景抓取與排程監控（預設 10 分鐘）
- 桌面通知（配額變化 / 低額度 / 重置提醒）
- 到點鬧鐘：重置時間到點彈出置頂視窗，睡眠期間錯過的提醒會補發
- 選配系統鬧鐘（macOS LaunchAgent／捷徑、Windows 工作排程器），狀態向作業系統實查
- 中英雙語介面，可在設定內切換
- GitHub Actions Release（tag 觸發 `.dmg` / `.exe`）
- CI 品質檢查（typecheck、readonly guard、unit test、build、smoke build）


### 到點鬧鐘（L0）與系統鬧鐘（L1）

鬧鐘刻意分成兩層，因為每多依賴作業系統一分，就多一份會靜默失效的權限風險。

**L0 — 應用內彈窗，不需要任何權限。** 重置時間到點時，`alarm-service.ts` 會開啟一個無邊框、
置頂的視窗（`alarm.html`）並播放合成提示音；用 `showInactive()` 顯示，所以不會搶走你正在輸入的
鍵盤焦點。經過 `alarmPopupAutoDismissMinutes`（預設 5 分鐘）後自動關閉。系統設定裡沒有任何開關
能讓這一層失效。

這一層同時修掉舊版重置提醒的兩個缺陷：

- **補發**：過去只要到點時機器在睡覺，那次提醒就直接被丟棄。現在只要還在 `alarmCatchUpMinutes`
  （預設 30 分鐘）之內就會補發一次並標記為補發。store 的 `alarmFires` 記錄哪個 `fireAt` 已經響過，
  所以重新排程不會重複觸發。
- **睡眠與喚醒**：`powerMonitor` 的 `resume` / `unlock-screen` 會重建排程——Chromium 的計時器在系統
  睡眠期間不會前進。

**L1 — 系統鬧鐘，選配、預設關閉、兩個獨立開關。**

| | 喚醒 App | 原生鬧鐘 |
|---|---|---|
| macOS | `~/Library/LaunchAgents` 的 LaunchAgent | 捷徑 → 時鐘 App 鬧鐘 |
| Windows | `schtasks` 任務啟動 App | `schtasks` 任務發出循環響鈴通知 |

狀態**一律向作業系統實查**——`launchctl print`、`shortcuts run`、`schtasks /Query`——絕不讀取快取
旗標，介面上會顯示最後查證時間。只要燈號不是綠的，就按設定裡的**「重新設置系統鬧鐘」**。重開機、
在時鐘 App 手動刪掉鬧鐘、權限被收回，都會顯示為 `stale`（已失效）。

請注意：LaunchAgent 與捷徑鬧鐘都不保證能喚醒睡眠中的 Mac。L1 的定位是「App 沒開也會提醒」，
不是「電腦睡著也會提醒」。

#### 安裝 macOS 捷徑（原生鬧鐘必需）

`shortcuts` CLI 只能執行與簽署捷徑，不能建立捷徑，所以這三個必須在「捷徑」App 裡手動建一次，
**名稱必須完全一致**。

1. **`Usage-Pulse Set Alarm`** — 接收文字輸入（ISO 8601 時間字串）：
   - 尋找鬧鐘，條件為名稱是 `Usage-Pulse`
   - 刪除鬧鐘（上一步的結果）
   - 建立鬧鐘 — 時間：由輸入解析，名稱：`Usage-Pulse`，重複：永不，貪睡：關閉
2. **`Usage-Pulse Clear Alarm`** — 尋找名稱為 `Usage-Pulse` 的鬧鐘 → 刪除鬧鐘
3. **`Usage-Pulse Check Alarm`** — 尋找名稱為 `Usage-Pulse` 的鬧鐘 → 以文字輸出鬧鐘時間
   （輸出為空代表沒有鬧鐘）

第 1 個捷徑「先刪再建」，這就是不論重新設置幾次，時鐘 App 裡永遠只有一顆 Usage-Pulse 鬧鐘的原因。

#### 已知限制：App 未簽名

`package.json` 目前是 `mac.identity: null`。macOS 的 TCC（自動化）授權綁定程式碼簽章，未簽名的
build 每次重新編譯都會被當成不同的 app，先前授予的權限直接作廢。這正是原生鬧鐘走捷徑
（App Intents）而不是走需要自動化授權的 Calendar AppleScript 的原因。長期解法是替 app 簽名。


### 安全約束
- OAuth token 僅在記憶體中短暫使用，不寫回 IDE 憑證來源。
- 禁止寫入 `state.vscdb`、`.credentials.json`、Keychain。
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
