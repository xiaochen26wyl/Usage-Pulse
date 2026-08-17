# 專案開發指南

## 專案概述
- 專案名稱：Usage-Pulse
- 目標：在 Mac / Windows 以選單列工具方式監控 Cursor 與 Claude Code 配額，並以桌面通知回報變化。
- 發布方式：使用 GitHub Release 提供安裝檔，不建立網站，不上架 Store。
- 架構原則：Sidecar Observer（旁路觀察者），僅讀取本機憑證與用量 API，不寫回 IDE 狀態。

## 資料架構
- `AppSettings`：檢查頻率、低額度閾值、開機啟動、通知冷卻時間、重置提醒與低額度提醒開關
- `CombinedSnapshot`：Cursor 與 Claude 配額快照
- `QuotaSnapshot.windows`：多視窗配額（例如 Claude Code 的 5 小時 / 每週）

## 配額來源（唯讀）
### Cursor
- 本機來源：`state.vscdb`（唯讀查詢 `cursorAuth/accessToken`）
- 遠端來源：`https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`
- 指標：included usage 剩餘金額（USD）與重置時間

### Claude Code
- 本機來源（優先序）：
  - `CLAUDE_CODE_OAUTH_TOKEN`
  - macOS Keychain `Claude Code-credentials`
  - `~/.claude/.credentials.json`（或 `CLAUDE_CONFIG_DIR/.credentials.json`）
- 遠端來源：`https://api.anthropic.com/api/oauth/usage`
- 指標：5 小時視窗與每週配額剩餘百分比

## 已完成功能
- Electron + React + TypeScript 專案骨架
- Sidecar Observer 改造（移除網頁 Session 登入流程）
- 本機憑證偵測 + API 配額抓取
- 背景抓取與排程監控（預設 10 分鐘）
- 桌面通知（配額變化 / 低額度 / 重置提醒）
- GitHub Actions Release（tag 觸發 `.dmg` / `.exe`）
- CI 品質檢查（typecheck、readonly guard、unit test、build、smoke build）

## 安全約束
- OAuth token 僅在記憶體中短暫使用，不寫回 IDE 憑證來源。
- 禁止寫入 `state.vscdb`、`.credentials.json`、Keychain。
- 發生 401 / 配額資料缺失時，回傳可行動的錯誤訊息，不做自動 token refresh。

## 開發與打包

### 常用指令
- `pnpm dev`：啟動 Electron 開發模式
- `pnpm typecheck`：TypeScript 型別檢查
- `pnpm check:readonly`：唯讀防護檢查
- `pnpm test:unit`：單元測試
- `pnpm build`：建置應用程式
- `pnpm smoke:build`：建置產物煙測
- `pnpm dist:mac`：輸出 macOS `.dmg`
- `pnpm dist:win`：輸出 Windows `.exe`

### 發版前必做（本機）
1. `pnpm install`
2. `pnpm typecheck`
3. `pnpm check:readonly`
4. `pnpm test:unit`
5. `pnpm build`
6. `pnpm smoke:build`
7. `pnpm dist:mac` 與 `pnpm dist:win`
8. 實際打開安裝檔，確認應用程式可啟動

### 發版（tag）
1. 確認 `package.json` 的 `version` 與預計 tag 一致（例如 `1.0.0` 對 `v1.0.0`）
2. 建立並推送 tag：
   - `git tag v1.0.0`
   - `git push origin v1.0.0`
3. GitHub Actions 會自動建置並發佈 Release 檔案
