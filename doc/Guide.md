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
- Bilingual UI (Traditional Chinese / English), switchable in Settings
- GitHub Actions Release (tag-triggered `.dmg` / `.exe`)
- CI quality gates (typecheck, readonly guard, unit tests, build, smoke build)

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
- 中英雙語介面，可在設定內切換
- GitHub Actions Release（tag 觸發 `.dmg` / `.exe`）
- CI 品質檢查（typecheck、readonly guard、unit test、build、smoke build）

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
