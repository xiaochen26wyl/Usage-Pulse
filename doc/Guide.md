# 專案開發指南

## 專案概述
- 專案名稱：Usage-Pulse
- 目標：在 Mac / Windows 以選單列工具方式監控 Cursor 與 Claude Code 配額，並以 LINE 與桌面通知回報變化。
- 發布方式：使用 GitHub Release 提供安裝檔，不建立網站，不上架 Store。
- 架構原則：Sidecar Observer（旁路觀察者），僅讀取本機憑證與用量 API，不寫回 IDE 狀態。

## 資料架構
- `AppSettings`：檢查頻率、LINE Token、低額度閾值、開機啟動、通知冷卻時間
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
- Sidecar Observer 改造（移除 Playwright 與網頁 Session 登入流程）
- 本機憑證偵測 + API 配額抓取
- 背景抓取與排程監控（預設 5 分鐘）
- LINE Flex Message + 桌面通知
- GitHub Actions Release（tag 觸發 `.dmg` / `.exe`）
- CI 唯讀防護（`pnpm check:readonly`）

## 安全約束
- token 僅在記憶體中短暫使用，不寫入 `electron-store`。
- 禁止寫入 `state.vscdb`、`.credentials.json`、Keychain。
- 發生 401 / 配額資料缺失時，回傳可行動的錯誤訊息，不做自動 token refresh。
