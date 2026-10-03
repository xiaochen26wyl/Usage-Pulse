# Developer Guide / 專案開發指南

**Language / 語言：** [English](#english) | [繁體中文](#繁體中文)

---

## English

### Project overview
- Project name: Usage-Pulse
- Goal: monitor Cursor, Claude Code, and Codex quotas from a menu bar tool on Mac / Windows, reporting changes via desktop notifications and optional LINE broadcast.
- Distribution: installers are provided via GitHub Release; no website, no app store listing.
- Architecture principle: Sidecar Observer — only reads local credentials and usage APIs, never writes back to IDE state. The single exception is the user-triggered "Clear history" button (see Security rules).

### Data model
- `AppSettings` (see `src/shared/types.ts`; there is no user-facing check interval):
  - Per-service monitoring: `enableCursorMonitoring` / `enableClaudeMonitoring` / `enableCodexMonitoring`
  - Cursor low-quota: `cursorModels` (`autoPercentUsed`) and advanced / other models (`apiPercentUsed`) each have their own threshold and toggle
  - Claude Code low-quota: 5-hour and weekly each have their own threshold and toggle; `enableClaudeCooldownAlert` is a lockout alert when the 5-hour window hits 0%, not a percent threshold
  - Codex low-quota: mirrors Claude — 5-hour, weekly, and `enableCodexCooldownAlert`. Extra API windows (per-model, code review) are displayed but not independently alerted
  - Alarms: Cursor period-end; Claude Code 5-hour / weekly / subscription-renewal as three independent switches plus `claudeBillingCadence`; Codex 5-hour / weekly as two independent switches
  - Other: `trayValueColorMode`, per-service popup / LINE switches (`enableCursorAlarmPopup` / `enableClaudeAlarmPopup` / `enableCodexAlarmPopup`, `enableCursorLineNotification` / `enableClaudeLineNotification` / `enableCodexLineNotification`), `claudeUseCliActivityPolling`, `codexUseCliActivityPolling`, UI language (`zh` / `en` / `ja` / `ko`), notification cooldown, `autoCheckForUpdates` (Windows only — see "Auto-update" below)
- `CombinedSnapshot`: Cursor, Claude, and Codex quota snapshots
- `QuotaSnapshot.windows`: multi-window quotas (Cursor billing / cursor models / other models; Claude Code 5-hour / weekly; Codex 5-hour / weekly plus any extra named windows the API reports)

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

#### Codex
- Local source: `~/.codex/auth.json`, or the macOS Keychain item named in `~/.codex/config.toml`'s credentials-store pref (`Codex Auth` / `com.openai.codex` / `Codex Auth Credentials`). Both are read-only — Usage-Pulse never writes them. There is no in-app Codex login UI; the user logs in with the Codex CLI or Codex Desktop first.
- Remote source: `https://chatgpt.com/backend-api/wham/usage`, falling back to `https://chatgpt.com/backend-api/codex/usage`
- Windows (`src/shared/codex-usage.ts`): classified by duration (5 hours / 7 days), not by backend slot names like `primary_window` / `secondary_window`. Those labels carry no identity of their own. A window whose only name is a slot label and that cannot claim the 5-hour or weekly slot is dropped (`parseWindowObject` returns `null`; the renderer also filters with `isCodexBackendSlotKey`) rather than shown as its own card. Extra windows the API reports (for example code-review) are displayed but not independently alerted. Remaining credits are shown when the payload includes them.
- Cached snapshots are re-normalized on read and write (`normalizeCodexSnapshot` in `src/main/store.ts`), so an older mislabeled window is repaired the next time the app loads it.
- Token refresh: if the access token is near expiry, Usage-Pulse refreshes it in process memory using the official Codex CLI's public OAuth client id. The new token is never written back to `~/.codex/auth.json`.

#### Re-detecting a Claude Code credential
On startup, `credentialMonitor.checkAll()` reads the official, read-only
`Claude Code-credentials` Keychain item. The startup usage pass then calls the
usage API once so the interface reflects the stored credential immediately.

**One gate decides whether the card offers a way to fix the credential: whether
the last fetch produced quota windows to display.** Not `CredentialState`, not
an expiry timestamp, not the presence of a Keychain item. Those are inferred
locally and have repeatedly disagreed with what the usage API actually does —
which is how the card once showed "click Get Credentials" on a screen that
rendered no such button. `App.tsx` passes `barWindows.length > 0` into
`renderCredentialRow`, and `renderClaudeCredentialBlock` renders whenever it is
false. The explanation above the block still comes from what the fetch really
returned (`claudeNoDataReasonKey`), so a 429 reads as rate limiting and a 200
with no usage reads as "nothing recorded yet" rather than as a broken login.

The block offers two routes:

1. **`claude auth login` in the user's own terminal** — the preferred one, and
   the only one that yields a credential the CLI keeps refreshed. Usage-Pulse
   deliberately does not spawn the `claude` CLI or implement any OAuth flow of
   its own; the official CLI opens its own browser page and writes
   `Claude Code-credentials` itself. Afterwards **Update Values** is all that is
   needed: it re-fetches usage and re-reads Keychain in the same pass
   (`monitor:run-manual` runs `credentialMonitor.check`). The Claude card
   deliberately no longer carries a separate **Get Credentials** button — that
   button's work is already covered by **Update Values**.
2. **Pasting a token into the card** — a fallback for when no terminal is at
   hand. `claude:save-token` verifies it by calling
   `collectClaudeCodeQuotaFromToken` with it *before* storing anything;
   `classifyClaudeTokenProbe` (`src/main/claude-manual-token.ts`) turns that
   attempt into store-or-refuse. A token that cannot read usage is never
   stored, and the refusal names the reason that actually occurred. A 200 with
   no quota windows counts as success — the token answered the API, which is
   the whole test. The value lives in `AppSettings.claudeManualToken`,
   encrypted at rest by `safeStorage` through `SECRET_SETTINGS_KEYS`, and is
   masked as `CLAUDE_TOKEN_MASK` before `settings:get` returns. No Keychain
   item is written for it.

   Automatic Keychain detection is macOS-only (`peekClaudeKeychainCredential`
   returns `null` on every other platform), so the renderer only renders this
   input on macOS when a token is already stored there (so it stays visible
   and clearable) — otherwise it always shows on Windows/Linux, since pasting
   a token is the only way to supply a Claude Code credential on those
   platforms.

`readClaudeCredential` ranks these: the Keychain credential while it is
unexpired, then the pasted token, then the expired Keychain credential (so the
API's own 401 surfaces instead of a misleading "no credential found").

`claude setup-token`'s authorize request only ever asks for the
`user:inference` scope — a hard limitation of the official CLI, confirmed in
`anthropics/claude-code#22450` / `#11985` and unrelated to how the token is
obtained — so such a token cannot satisfy the usage API's `user:profile`
requirement. Pasting one is refused with exactly that explanation rather than
being stored and failing silently later.

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
single fixed cadence — every minute (`CODEX_POLL_INTERVAL_MS`) — with no
separate minimum-gap floor, since the fixed interval already is the floor.
`codexUseCliActivityPolling` is an optional traffic saver (off by default). If
the user turns it on, neither the Codex CLI's session logs nor its credential
changing since the last fetch means that tick is skipped and no request is made.

### Completed features
- Electron + React + TypeScript project skeleton (Electron `^43.4.1`)
- Sidecar Observer refactor (removed web session login flow)
- Local credential detection + API quota fetching (Cursor, Claude Code, Codex)
- Background scheduled monitoring (15 minutes normally, 10 minutes when a window is low; Codex is a fixed 1-minute cadence)
- Desktop notifications (quota change / low quota / reset alerts)
- Timed alarm: an always-on-top popup in the top-right corner when due (Cursor period end / Claude and Codex window reset / Claude subscription renewal)
- Four-language UI (Traditional Chinese / English / Japanese / Korean), switchable in Settings
- GitHub Actions Release (tag-triggered `.dmg` / `.exe`; Windows also ships `latest.yml`)
- Windows auto-update via `electron-updater` (user-confirmed download and install; macOS excluded — see "Auto-update")
- Per-release, four-language release notes (`release-notes/<version>.json`) reused for the GitHub Release body and the in-app update prompt
- CI quality gates (typecheck, readonly guard, unit tests, build, smoke build)
- LINE quit status: a real quit (UI or tray) calls `app.quit()`; if LINE is on, `before-quit` broadcasts one Flex message — a swipeable carousel with a card per window — from the cached snapshot, covering every enabled service that has a known reading (Cursor overall, Claude 5-hour / weekly, Codex 5-hour / weekly). Unknown / never-polled windows are skipped. It is a single LINE notification per quit, however many windows are monitored.


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
  state. `notifyCooldownMinutes` only applies to quota-change notices, not to
  low-quota or credential-expiry alerts. One "event" is identified by threshold plus
  that window's reset time (`monitor-engine.ts` `fireWindowAlert`): changing the
  threshold, or the window actually resetting, is a new event and will alert
  again; quota recovering above the threshold clears the last record so the next
  drop is treated as fresh.
- **Recovery sends its own one-shot notice.** When `fireWindowAlert` (or the
  Claude/Codex cooldown-lift branch) clears a low/exhausted/cooldown latch and
  that latch actually existed, `fireRecoveredAlert` sends one desktop + LINE
  message (no popup — recovery isn't urgent). A window that was already healthy,
  or whose latch was never set, never gets a spurious recovered message —
  `notificationStore.clear`'s own return value (did it find something to remove)
  is the gate, so no separate dedupe key is needed.
- **One reset, one recovered notice.** A 5-hour reset clears the session's
  low-quota latch and its cooldown latch in the same poll.
  `handleSessionWindowAlerts` (shared by Claude Code and Codex) merges the two into
  a single recovered notice instead of one each. The cooldown latch is only cleared
  by `shouldClearCooldownLatch`: not while the session is at 0%, not until the
  reading clears the same 5-point hysteresis as the low-quota latch, and — when the
  payload no longer lists the window — not until the reset time recorded on the
  latch has passed. A cooldown whose `resetsAt` is momentarily blank stays silent
  and keeps its latch; a missing reading is not a recovery.
- **`resetsAt` is pinned across polls, within a jitter tolerance.** Sources that
  recompute `resetsAt` as `now + secondsLeft` (Codex's `reset_after_seconds`)
  would otherwise drift by a second or two each poll, which looks like a new
  occurrence to the one-shot gate. `stabilizeWindowResets` / `stabilizeResetTime`
  (`src/shared/monitor-utils.ts`) keep the previous value while it is still in
  the future — but only as long as the fresh candidate stays within a 60-second
  tolerance of it. A candidate that differs by more than that is trusted
  immediately even though the cached value hasn't elapsed by the app's own
  clock, so a genuinely early reset (the underlying window rolling over sooner
  than the app had predicted) isn't mistaken for recompute noise and blocked
  from re-arming the one-shot gate.
- **A recovered credential re-arms the expiry notice.** The credential-expired
  notice is one-shot per occurrence (`notificationStore.shouldFireOnce`). Recovery
  (`credential-monitor.ts` `clearUnusableLatch`) clears that latch, so a later
  genuine new failure — even one that happens to look like the same
  `state|expiresAt` — can notify again.

### Timed alarm

Usage-Pulse never touches any OS-level alarm or scheduler — the only reminder mechanism is an
in-app popup, which needs no permission of any kind. At the reset time `alarm-service.ts` opens a
frameless, always-on-top window (`alarm.html`) positioned in the
**top-right corner** of the primary display (recomputed on every show, so a resolution or
monitor-arrangement change never leaves it off-screen). Quota / reset / low-quota popups are
**silent**. It is shown with
`showInactive()` so it never steals the keystroke you are in the middle of typing, and closes
itself after `ALARM_POPUP_AUTO_DISMISS_SECONDS` (30 seconds; not a setting). The popups have no
action buttons. OS-native desktop notifications are also closed by
`sendPlainDesktopNotification` after the same 30-second window.

How to be notified is chosen per service: each service block ends with two checkboxes on one
row — the app popup (`enable<Service>AlarmPopup`) and LINE (`enable<Service>LineNotification`; a
token must still be pasted below before anything is sent). A service's checkboxes cover every
alert about that service (low quota, cooldown, exhausted, reset, period end, quota recovered,
credential expired, and its part of the quit-time LINE status); OS-native desktop notifications
have no switch. The one exception is the 5-hour **reset** alarms (Claude Code and Codex): they
reset several times a day whether or not the window was ever low, so they ring as popup + desktop
notification only and never as LINE (`alarmSendsLine` in `src/shared/alarm-utils.ts`). On LINE a
5-hour reset is heard through the one-shot recovered notice, and only if the window had been low
or on cooldown; since that notice is sent when the next poll sees the recovery, it can arrive up
to one polling interval after the reset (longer while the CLI is idle and activity polling is on).
Weekly and period-end / renewal alarms keep their LINE message. A store that still carries the old single global popup / LINE switch hands that
value to every service on first read (`resolveChannelFlags` in `src/shared/notify-channels.ts`),
so upgrading changes nobody's behaviour. Each service's reminder switches sit on the same card as that service's low-quota threshold — no
separate "Reset Alarm" card, no OS-level configuration. Cursor's switch is **period-end**
(`billingCycleEnd`, which is both the included-usage reset and the billing date). Claude Code
splits three independent switches: **5-hour reset**, **weekly reset** (usage windows from
`/api/oauth/usage`), and **subscription renewal** (derived from
`/api/oauth/profile` `subscription_created_at` plus the monthly/annual cadence
setting). The subscription date does not refill quota. Max plans are monthly
only; an annual Pro plan uses the yearly anniversary of that anchor. Switching from monthly
to annual mid-stream may still use the original subscribe date as the anchor. Codex splits
two independent switches: **5-hour reset** and **weekly reset**.

Two failure modes of the old reset alert are fixed here:

- **Catch-up.** A firing that came due while the machine slept used to be dropped outright. A
  `fireAt` that was observed while still in the future may ring after wake **no matter how late**
  — there is no `alarmCatchUpMinutes` window and no catch-up marker. `alarmFires` in the store
  records which `fireAt` already rang, so re-arming never double-fires.
- **Sleep and wake.** `powerMonitor` `resume` / `unlock-screen` rebuild the schedule, because
  Chromium timers do not advance while the machine is asleep. The same handlers also call
  `MonitorEngine.checkIfDue()`, which catches up any Cursor/Claude/Codex quota poll that fell
  behind for the identical reason (`isPollDue` in `monitor-utils.ts`, mirroring
  `isCredentialCheckDue`) before re-arming every tick timer from the current moment.


### Security constraints
- OAuth tokens are only held briefly in memory.
- Writing to `state.vscdb`, `.credentials.json`, or `~/.codex/auth.json` is forbidden.
- Clear older than 2 weeks (`history:get-stats` / `history:clean`, `src/main/history-cleaner.ts`) is the only module allowed to delete IDE/CLI files, and `scripts/check-readonly.mjs` lists it as the deliberate exception. It runs only after the user clicks the button on the Claude Code or Codex card and confirms a native dialog shown by main (Cancel is the default; the renderer cannot skip it). Cursor has no such button: its conversations share `state.vscdb` with its credential. Scope: conversation history older than two weeks (`HISTORY_RETENTION_DAYS`, by modification time, strictly older) — never credentials, settings, `memory` folders, `projects`/`thread_sections`, or `external_agent_session_imports.json`. The card shows the total and the part older than two weeks; the button is disabled when nothing is.
  - Claude Code: `.jsonl` files under `~/.claude/projects` older than two weeks go to the OS trash.
  - Codex: refused while Codex (desktop app or CLI) is running or cannot be probed, when a `state_N`/`thread_history_N`/`logs_N` file has a version other than the verified `5`/`1`/`2`, when a table or a matched column is unknown or missing, when an unlisted table references a cleared one, when `quick_check` fails, or when no SQLite engine (`node:sqlite`) is available. A refusal changes nothing. Otherwise the threads in `state_5` whose `updated_at` is older than two weeks and that are not pinned are removed together with their rows in `thread_artifacts`, `thread_dynamic_tools`, `thread_spawn_edges`, and the thread tables of `thread_history_1`; `logs` rows older than two weeks are removed from `logs_2` (one transaction per database, `state_5` first, then `wal_checkpoint(TRUNCATE)` + `VACUUM`). Only after every database succeeds are those threads' rollout files, plus old `.jsonl` files no thread points at, trashed (a file a surviving thread uses is never touched) and their lines dropped from `session_index.jsonl` (temp file + rename). Database rows cannot be trashed and cannot be restored; the confirmation dialog says so. Cross-database atomicity is not guaranteed: if a later database fails, orphaned history rows may remain but no file is touched.
  - Windows: the Codex process probe and the clean itself are untested there.
- Claude Code credentials are entirely read-only: Usage-Pulse never spawns the `claude` CLI, never implements OAuth itself, and never writes to the official `Claude Code-credentials` Keychain item. The only Keychain write it ever performs is a one-time, best-effort deletion of the retired `Usage-Pulse-Claude-setup-token` item left over from the old setup-token flow.
- Re-reading a credential (`auth:check`) only reads the Keychain item, never writes to it; the user completes `claude auth login` entirely in their own terminal, outside the app. A token pasted into the card is verified against the usage API before it is stored, and lives in `electron-store` under `safeStorage` encryption — never in a Keychain item.
- Codex credentials are also read-only on disk. Near-expiry access tokens may be refreshed in process memory via the official Codex CLI's public OAuth client; the new token is never written back to `~/.codex/auth.json` or Keychain.
- On a 401 or missing quota data, return an actionable error message. Claude Code and Cursor never auto-refresh; Codex's in-memory refresh (above) is the only exception.

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
2. Write `release-notes/<version>.json` (all four languages — `zh`/`en`/`ja`/`ko`; see `release-notes/README.md`). This is what the in-app update prompt shows (Windows only for now) and what the GitHub Release body becomes — CI fails the build if it's missing or incomplete.
3. Add the version's entry to `CHANGELOG.md` in both the English and the Traditional Chinese sections (heading `### [<version>] - <release date>`, above the previous version; grouped as Added / Changed / Fixed / Removed). CI does not check this, so it has to be done before tagging.
4. Create and push the tag:
   - `git tag v1.0.0`
   - `git push origin v1.0.0`
5. GitHub Actions will automatically build and publish the Release artifacts

#### Auto-update

- Windows only (`src/main/updater.ts`, wraps `electron-updater`). macOS builds are unsigned (`build.mac.identity: null`, no notarization) and Squirrel.Mac's silent install cannot be relied on without a signature, so macOS never runs any update-check logic today.
- Checked on startup, every 6 hours while `autoCheckForUpdates` is on, and any time via the tray menu's "Check for Updates" item. Everything (download, install) is user-triggered — nothing installs itself in the background.
- Release notes shown in the update prompt are read straight from that tag's `release-notes/<version>.json` on GitHub (not the GitHub Release body, which is auto-generated English only) — see "Releasing (tag)" above.
- `package.json`'s `build.publish` (provider `github`) is required for two things: electron-builder writes `app-update.yml` into the packaged app (electron-updater's default feed) and `latest.yml` into `release/` at build time. `dist:win`/`dist:mac` still run with `--publish never` — the GitHub Release itself is published by `action-gh-release`, not electron-builder.

---

## 繁體中文

### 專案概述
- 專案名稱：Usage-Pulse
- 目標：在 Mac / Windows 以選單列工具方式監控 Cursor、Claude Code 與 Codex 配額，並以桌面通知與可選的 LINE 廣播回報變化。
- 發布方式：使用 GitHub Release 提供安裝檔，不建立網站，不上架 Store。
- 架構原則：Sidecar Observer（旁路觀察者），僅讀取本機憑證與用量 API，不寫回 IDE 狀態；唯一例外是使用者主動觸發的「清除對話紀錄」按鈕（見安全規則）。

### 資料架構
- `AppSettings`（見 `src/shared/types.ts`；沒有使用者可調的檢查頻率）：
  - 服務開關：`enableCursorMonitoring` / `enableClaudeMonitoring` / `enableCodexMonitoring`
  - Cursor 低額度：`cursorModels`（`autoPercentUsed`）與進階／其他模型（`apiPercentUsed`）各自有閾值與開關
  - Claude Code 低額度：5 小時與每週各自有閾值與開關；`enableClaudeCooldownAlert` 是 5 小時視窗用盡鎖定的提醒，不是百分比閾值
  - Codex 低額度：與 Claude 相同——5 小時、每週，以及 `enableCodexCooldownAlert`。API 回報的額外視窗（單模型、code review）會顯示，但不獨立告警
  - 鬧鐘：Cursor 本期到期；Claude Code 5 小時／每週／訂閱到期三個獨立開關，加上 `claudeBillingCadence`；Codex 5 小時／每週兩個獨立開關
  - 其他：`trayValueColorMode`、各服務的彈窗／LINE 開關（`enableCursorAlarmPopup`／`enableClaudeAlarmPopup`／`enableCodexAlarmPopup`、`enableCursorLineNotification`／`enableClaudeLineNotification`／`enableCodexLineNotification`）、`claudeUseCliActivityPolling`、`codexUseCliActivityPolling`、介面語言（`zh`／`en`／`ja`／`ko`）、通知冷卻時間、`autoCheckForUpdates`（僅 Windows，見下方「自動更新」）
- `CombinedSnapshot`：Cursor、Claude 與 Codex 配額快照
- `QuotaSnapshot.windows`：多視窗配額（Cursor 計費週期／Cursor 模型／其他模型；Claude Code 的 5 小時／每週；Codex 的 5 小時／每週，以及 API 回報的其他具名視窗）

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

#### Codex
- 本機來源：`~/.codex/auth.json`，或 `~/.codex/config.toml` 憑證存放偏好所指定的 macOS Keychain 項目（`Codex Auth`／`com.openai.codex`／`Codex Auth Credentials`）。兩者皆唯讀——Usage-Pulse 從不寫入。沒有 App 內 Codex 登入介面；使用者需先用 Codex CLI 或 Codex Desktop 登入。
- 遠端來源：`https://chatgpt.com/backend-api/wham/usage`，失敗再打 `https://chatgpt.com/backend-api/codex/usage`
- 視窗（`src/shared/codex-usage.ts`）：依時長分類（5 小時／7 天），不用 `primary_window`／`secondary_window` 這類後端槽位名稱。那些標籤本身沒有身分。若一個視窗的名字只是槽位標籤、又佔不到 5 小時或每週槽位，就直接丟棄（`parseWindowObject` 回傳 `null`；renderer 也用 `isCodexBackendSlotKey` 再濾一次），不會當成獨立卡片。API 回報的額外視窗（例如 code-review）會顯示，但不獨立告警。payload 有剩餘 credits 時一併顯示。
- 讀取與寫入快取時會再正規化（`src/main/store.ts` 的 `normalizeCodexSnapshot`），下次載入即可修正舊的錯誤標籤。
- Token 刷新：access token 接近過期時，Usage-Pulse 會用官方 Codex CLI 的公開 OAuth client id 在行程記憶體中刷新。新 token **不會**寫回 `~/.codex/auth.json`。

#### 重新偵測 Claude Code 憑證
啟動時，`credentialMonitor.checkAll()` 會以唯讀方式檢查官方的
`Claude Code-credentials` 項目。接著 startup usage pass 會打一次 usage API，讓介面立刻反映
已存憑證的數值。

**卡片要不要給出修復憑證的路，只由一件事決定：這次抓取有沒有拿到可顯示的配額。**
不看 `CredentialState`、不看到期時間、不看 Keychain 項目在不在。那些都是本機推論出來的，
而且一再與 usage API 的實際行為不一致——卡片曾經因此在一個根本沒有渲染該按鈕的畫面上，
叫使用者「請點獲取憑證」。`App.tsx` 把 `barWindows.length > 0` 傳進
`renderCredentialRow`，只要是 false 就渲染 `renderClaudeCredentialBlock`。
區塊上方的原因文字仍取自這次抓取真正的結果（`claudeNoDataReasonKey`），所以 429 會說是被限流、
200 但沒有用量會說是還沒有紀錄，而不是一律推給登入失效。

區塊提供兩條路：

1. **在使用者自己的終端機執行 `claude auth login`**——首選，也是唯一能拿到「CLI 會自動續期」
   憑證的方式。Usage-Pulse 刻意不 spawn `claude` CLI，也不自己實作任何 OAuth 流程；
   官方 CLI 自己開瀏覽器、自己寫入 `Claude Code-credentials`。之後按卡片上的「更新數值」
   即可：它會重抓用量，並在同一次流程中重讀 Keychain（`monitor:run-manual` 內含
   `credentialMonitor.check`）。Claude 卡片刻意不再另外給一顆「獲取憑證」——
   它做的事已被「更新數值」完整涵蓋。
2. **直接在卡片貼上 token**——手邊沒有終端機時的備援。`claude:save-token` 會先用這個 token
   呼叫 `collectClaudeCodeQuotaFromToken` 實際驗證，**驗證通過才儲存**；
   `classifyClaudeTokenProbe`（`src/main/claude-manual-token.ts`）負責把這次嘗試轉成
   「存」或「拒絕並說明原因」。查不到用量的 token 一律不存，拒絕訊息會指出真正發生的原因。
   200 但沒有配額視窗算成功——token 有回應 usage API，這正是要測的東西。值存在
   `AppSettings.claudeManualToken`，經 `SECRET_SETTINGS_KEYS` 由 `safeStorage` 加密落地，
   `settings:get` 回傳前遮罩成 `CLAUDE_TOKEN_MASK`。不會為它寫入任何 Keychain 項目。

   自動偵測 Keychain 只支援 macOS（`peekClaudeKeychainCredential` 在其他平台恆回傳
   `null`），所以 renderer 只在 macOS 上、且已經存有舊 token 時才畫出這個輸入框（讓它保持
   看得到、可以清除）；在 Windows／Linux 上則一律顯示，因為貼上 token 是那些平台上
   唯一能提供 Claude Code 憑證的方式。

`readClaudeCredential` 的排序：Keychain 憑證未過期時優先，其次是貼上的 token，
最後才是已過期的 Keychain 憑證（讓 API 自己回 401，而不是誤報「找不到憑證」）。

`claude setup-token` 的授權請求天生只會要求 `user:inference` scope——這是官方 CLI 本身
的限制（見 `anthropics/claude-code#22450` / `#11985`），跟呼叫方式無關，因此這種 token
無法滿足 usage API 需要的 `user:profile`。貼上它會被以這個理由當場拒絕，而不是先存起來、
之後再默默失敗。

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

Codex 不套用 Claude/Cursor 的正常/低額度雙檔排程，而是走單一固定間隔——每 1
分鐘一次（`CODEX_POLL_INTERVAL_MS`），沒有獨立的最短間隔 floor，因為固定間隔本身
就是 floor。`codexUseCliActivityPolling` 是可選的省流量模式（預設關閉）：若使用者
手動開啟，且 Codex CLI 的 session 紀錄與憑證自上次抓取以來都沒有動靜，這次 tick
就會跳過，不打 API。

### 已完成功能
- Electron + React + TypeScript 專案骨架（Electron `^43.4.1`）
- Sidecar Observer 改造（移除網頁 Session 登入流程）
- 本機憑證偵測 + API 配額抓取（Cursor、Claude Code、Codex）
- 背景抓取與排程監控（一般 15 分鐘；視窗偏低時 10 分鐘；Codex 為固定 1 分鐘）
- 桌面通知（配額變化 / 低額度 / 重置提醒）
- 到點／到期提醒：時間到點在螢幕右上角彈出置頂視窗（Cursor 為本期到期，Claude／Codex 為視窗重置，Claude 另有訂閱到期）
- 四語介面（繁體中文／英文／日文／韓文），可在設定內切換
- GitHub Actions Release（tag 觸發 `.dmg` / `.exe`；Windows 另附 `latest.yml`）
- Windows 自動更新（`electron-updater`，下載與安裝都由使用者確認；macOS 不支援，見「自動更新」）
- 每個版本的四語言版更說明（`release-notes/<version>.json`），同時用於 GitHub Release 說明與 App 內更新提示
- CI 品質檢查（typecheck、readonly guard、unit test、build、smoke build）
- LINE 結束現況：真正關閉（UI 或 tray）都是 `app.quit()`；若 LINE 開啟，`before-quit` 用快取 snapshot，把每個已啟用且有已知讀數的服務（Cursor 整體、Claude 5 小時／每週、Codex 5 小時／每週）組成一則 Flex（可左右滑動的 carousel，每個視窗一張卡片）送出。未知／從未抓取的視窗會跳過。不論監控幾個視窗，每次關閉都只有一則 LINE 通知。不會跳出結束統計視窗。


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
  即使一直卡在同一個狀態也不會再重複——`notifyCooldownMinutes` 只影響配額變化通知，
  跟低額度提醒、憑證失效提醒無關。同一次「事件」由「閾值＋該視窗的重置時間」共同識別（`monitor-engine.ts` 的
  `fireWindowAlert`）：改動閾值設定，或視窗真的重置到下一輪，都算新事件，會重新提醒一次；額度
  真的回升到閾值之上，則會清掉上一次的紀錄，下次再跌破閾值就當作全新事件重新提醒。
- **額度恢復時會發一則一次性通知**：`fireWindowAlert`（以及 Claude／Codex 的冷卻解除分支）清掉
  低量/耗盡/冷卻鎖定、且那個鎖定確實存在時，`fireRecoveredAlert` 會發一則桌面＋LINE 通知（不含
  彈窗——恢復不算緊急）。本來就健康、或鎖定從沒設過的視窗不會誤發——閘門就是
  `notificationStore.clear` 自己的回傳值（有沒有真的清掉東西），不需要另外的 dedupe key。
- **一次重置只發一則恢復通知**：5 小時視窗重置時，session 的低額度鎖定與冷卻鎖定會在同一次輪詢被清掉。
  `handleSessionWindowAlerts`（Claude Code 與 Codex 共用）把兩者合併成一則恢復通知，而不是各發一則。
  冷卻鎖定只由 `shouldClearCooldownLatch` 決定能不能清：session 還在 0% 不清；讀數沒有越過跟低額度鎖定同樣的
  5 個百分點遲滯邊界不清；payload 不再列出該視窗時，要等鎖定上記錄的重置時間已過才清。冷卻中但 `resetsAt`
  暫時空白時保持靜默、不清鎖定——讀不到不等於已恢復。
- **`resetsAt` 會在輪詢之間釘住，但有雜訊容忍值**：會把 `resetsAt` 重算成 `now + secondsLeft` 的
  來源（Codex 的 `reset_after_seconds`）每次輪詢可能差一兩秒，對一次性閘門來說就像新事件。
  `stabilizeWindowResets`／`stabilizeResetTime`（`src/shared/monitor-utils.ts`）會在舊值仍屬未來
  時沿用舊值——但僅限新讀到的值跟舊值差距在 60 秒容忍值以內。差距超過容忍值就立即採用新值，
  即使舊值按程式自己的時鐘還沒到期，這樣視窗真的提早重置時才不會被誤判成雜訊、卡住一次性閘門
  無法重新觸發。
- **憑證恢復後會重開失效通知閘門**：憑證失效通知依發生次數一次性發送（`notificationStore.shouldFireOnce`）。
  恢復時（`credential-monitor.ts` 的 `clearUnusableLatch`）會清掉這個閘門，之後真正的新失效——就算
  `state|expiresAt` 碰巧長得一樣——仍能再通知一次。

### 到點提醒

Usage-Pulse 完全不碰任何作業系統層級的鬧鐘或排程器——App 內彈窗不需要任何權限。時間到點時，
`alarm-service.ts` 會開啟一個無邊框、置頂的視窗（`alarm.html`），顯示位置固定在主螢幕的
**右上角**（每次顯示時都會重新計算座標，所以解析度或多螢幕排列變動也不會讓視窗跑到畫面外）。
配額／重置／低額度彈窗**靜音**。用
`showInactive()` 顯示，所以不會搶走你正在輸入的鍵盤焦點。經過
`ALARM_POPUP_AUTO_DISMISS_SECONDS`（30 秒，不是設定項）後自動關閉。彈窗沒有任何操作按鈕。
OS 原生桌面通知也會由 `sendPlainDesktopNotification` 在同樣的 30 秒後主動關閉。

「用什麼方式提醒」改為各服務自訂：每個服務區塊的最後有同一行的兩個勾選框——App 彈窗
（`enable<Service>AlarmPopup`）與 LINE 通知（`enable<Service>LineNotification`；仍須在下方區塊貼
Token 才會真的送出）。服務的勾選涵蓋該服務所有提醒（低額度、冷卻、已用完、重置、到期、額度恢復、
憑證失效，以及結束時的 LINE 現況）；OS 原生桌面通知沒有開關。唯一的例外是 Claude Code 與 Codex 的
5 小時**到點提醒**：5 小時視窗一天會重置好幾次，不論當次有沒有跌到低額度都會響，所以只有彈窗＋桌面通知，
不發 LINE（`src/shared/alarm-utils.ts` 的 `alarmSendsLine`）。5 小時重置在 LINE 上由一次性的恢復通知代表，
而且只有當時真的跌到低額度或冷卻過才會收到；這則通知是下一次輪詢看到恢復時才送，所以最多會比重置時間晚一個
輪詢間隔（CLI 閒置且開啟活動輪詢時會更久）。每週與到期／續訂提醒仍會發 LINE。舊設定若還是單一的全域彈窗／LINE
開關，首次讀取時會把該值帶給每個服務（`src/shared/notify-channels.ts` 的 `resolveChannelFlags`），
所以升級不會改變任何人的行為。各服務的開關跟該服務的
低額度預警閾值放在同一張卡片裡——沒有獨立的「重置鬧鐘」卡片，也沒有任何作業系統層級的設定。
Cursor 是「到期提醒」（本期 `billingCycleEnd`，用量重設與計費同一天）。Claude Code 拆成三個獨立開關：5 小時到點、每週配額到點（`/api/oauth/usage` 的用量視窗），以及訂閱到期（`/api/oauth/profile` 的 `subscription_created_at` 加上月繳／年繳週年推算）。訂閱到期**不會**重設 5 小時或每週配額。Max 目前只有月繳；年繳 Pro 用該錨點的年週年。若中途從月繳改年繳，錨點可能仍是原始訂閱日。Codex 拆成兩個獨立開關：5 小時到點與每週配額到點。

這個機制同時修掉舊版重置提醒的兩個缺陷：

- **補發**：過去只要到點時機器在睡覺，那次提醒就直接被丟棄。曾在未來被觀察到的 `fireAt`，喚醒後
  **不論多晚**都可以響——沒有 `alarmCatchUpMinutes` 時間窗，也沒有補發標記。store 的 `alarmFires`
  記錄哪個 `fireAt` 已經響過，所以重新排程不會重複觸發。
- **睡眠與喚醒**：`powerMonitor` 的 `resume` / `unlock-screen` 會重建排程——Chromium 的計時器在系統
  睡眠期間不會前進。同一組 handler 也會呼叫 `MonitorEngine.checkIfDue()`，補跑因為同樣原因落後的
  Cursor／Claude／Codex 用量輪詢（`monitor-utils.ts` 的 `isPollDue`，比照 `isCredentialCheckDue`
  的做法），再把每個 tick 計時器從喚醒後的當下時間重新排程。


### 安全約束
- OAuth token 僅在記憶體中短暫使用。
- 禁止寫入 `state.vscdb`、`.credentials.json`、`~/.codex/auth.json`。
- 清除 2 週前的紀錄（`history:get-stats`／`history:clean`，`src/main/history-cleaner.ts`）是唯一被允許刪除 IDE／CLI 檔案的模組，並在 `scripts/check-readonly.mjs` 明列為刻意例外。只有使用者在 Claude Code 或 Codex 卡片按下按鈕、並在 main 彈出的原生對話框確認後才會執行（預設按鈕為取消，renderer 無法略過）。Cursor 沒有此按鈕：它的對話與憑證同在 `state.vscdb`。範圍僅限超過 2 週（`HISTORY_RETENTION_DAYS`，以修改時間判斷、嚴格大於）的對話紀錄——不碰憑證、設定、`memory` 資料夾、`projects`／`thread_sections`、`external_agent_session_imports.json`。卡片顯示總數與超過 2 週的部分，沒有可清的內容時按鈕停用。
  - Claude Code：`~/.claude/projects` 下超過 2 週的 `.jsonl` 移到系統垃圾桶。
  - Codex：Codex（桌面 App 或 CLI）執行中或無法確認、`state_N`／`thread_history_N`／`logs_N` 的版本不是已驗證的 `5`／`1`／`2`、資料表或比對用欄位未知或缺少、未列入的表格指向被清除的表格、`quick_check` 失敗、或沒有 SQLite 引擎（`node:sqlite`）時一律拒絕，拒絕不會改動任何東西。否則把 `state_5` 中 `updated_at` 超過 2 週且未置頂的對話串，連同它在 `thread_artifacts`、`thread_dynamic_tools`、`thread_spawn_edges` 與 `thread_history_1` 對話表中的列一併刪除，並刪除 `logs_2` 中超過 2 週的 `logs`（每個資料庫一個交易，`state_5` 先做，之後 `wal_checkpoint(TRUNCATE)` 與 `VACUUM`）。全部資料庫成功後，才把這些對話串的 rollout 檔案與沒有任何對話串引用的舊 `.jsonl` 移到垃圾桶（仍被未過期對話串使用的檔案絕不動），並從 `session_index.jsonl` 移除它們的行（暫存檔加 rename）。資料庫的列無法進垃圾桶、也無法還原，確認對話框已明說。跨資料庫不保證原子性：後面的資料庫失敗時，可能留下孤兒的對話內容列，但不會動任何檔案。
  - Windows：Codex 行程偵測與清理本身都尚未在該平台測試。
- Claude Code 憑證完全唯讀：Usage-Pulse 不 spawn `claude` CLI、不自己實作 OAuth，也不寫入官方的 `Claude Code-credentials` Keychain 項目。唯一會做的 Keychain 寫入，是啟動時一次性、盡力刪除舊 setup-token 流程留下的 `Usage-Pulse-Claude-setup-token` 項目。
- 憑證重讀（`auth:check`）只讀取 Keychain 項目，不寫入；使用者完全在自己的終端機執行 `claude auth login` 完成登入，App 不參與。貼進卡片的 token 會先對 usage API 驗證通過才儲存，並存在 `electron-store` 內由 `safeStorage` 加密，不會寫成 Keychain 項目。
- Codex 憑證在磁碟上同樣唯讀。access token 接近過期時，可用官方 Codex CLI 的公開 OAuth client 在行程記憶體中刷新；新 token 不會寫回 `~/.codex/auth.json` 或 Keychain。
- 發生 401 / 配額資料缺失時，回傳可行動的錯誤訊息。Claude Code 與 Cursor 不做自動 token refresh；唯一例外是上述 Codex 的記憶體刷新。

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
2. 撰寫 `release-notes/<version>.json`（四語言 `zh`/`en`/`ja`/`ko` 都要，格式見 `release-notes/README.md`）。這份內容會用在 app 內的更新提示（目前僅 Windows）以及 GitHub Release 說明——缺漏任一語言會讓 CI 直接失敗。
3. 在 `CHANGELOG.md` 補上該版本條目，English 與繁體中文兩個段落各一份（標題 `### [<version>] - <發版日期>`，放在上一版之前；依新增／變更／修復／移除分類）。CI 不會檢查這一項，所以要在打 tag 之前完成。
4. 建立並推送 tag：
   - `git tag v1.0.0`
   - `git push origin v1.0.0`
5. GitHub Actions 會自動建置並發佈 Release 檔案

#### 自動更新

- 僅支援 Windows（`src/main/updater.ts`，封裝 `electron-updater`）。macOS 版目前完全未簽章（`build.mac.identity: null`，也沒有 notarize），electron-updater 在 macOS 上的靜默安裝（Squirrel.Mac）沒有簽章不可靠，所以 macOS 目前完全不會執行任何檢查更新的邏輯。
- 檢查時機：開機啟動時、`autoCheckForUpdates` 開啟時每 6 小時一次、以及隨時透過選單列右鍵選單的「檢查更新」手動觸發。下載與安裝都需要使用者主動按下按鈕才會發生，不會背景偷跑。
- 更新提示顯示的版更說明，是直接讀取該 tag 的 `release-notes/<version>.json`（而不是 GitHub Release 本文——那是純英文自動產生的），見上方「發版（tag）」。
- `package.json` 的 `build.publish`（provider 設為 `github`）是必要設定，用途有兩個：讓 electron-builder 把 `app-update.yml`（electron-updater 預設會讀的 feed）打包進 app 本體，以及在打包時把 `latest.yml` 寫進 `release/` 目錄。`dist:win`／`dist:mac` 仍然是 `--publish never`——真正發佈 GitHub Release 的仍是 `action-gh-release`，不是 electron-builder 自己。
