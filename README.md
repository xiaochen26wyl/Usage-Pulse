# Usage-Pulse

Usage-Pulse 是跨平台桌面選單列工具，用於監控 Cursor 與 Claude Code 配額，並在變化或低額度時推播通知。

目前採用 **Sidecar Observer（旁路觀察者）** 架構：僅讀取本機已登入憑證與用量 API，不會寫回 IDE 的憑證或設定檔。

## 技術棧
- Electron + TypeScript
- React（控制面板）
- Axios（用量 API）
- menubar（MenuBar / Tray）
- electron-store（本地設定儲存）
- LINE Messaging API（通知）

## 專案結構
```text
Usage-Pulse/
  src/
    main/      # Electron 主程序、排程、collector、通知、IPC
    renderer/  # React 控制面板
    shared/    # 共用型別
    types/     # 視窗 API 型別
  scripts/     # 安全與開發檢查腳本
  doc/         # 專案文件
  .github/workflows/
```

## 安裝與執行
1. 安裝依賴：
   - `pnpm install`
2. 啟動開發模式：
   - `pnpm dev`

## 常用指令
- `pnpm dev`：啟動 Electron 開發模式
- `pnpm build`：建置應用程式
- `pnpm dist:mac`：輸出 macOS `.dmg`
- `pnpm dist:win`：輸出 Windows `.exe`
- `pnpm typecheck`：執行 TypeScript 型別檢查
- `pnpm check:readonly`：唯讀防護檢查（禁止對敏感憑證路徑進行寫入）

## Release 發布
1. 建立並推送 tag：
   - `git tag v1.0.0`
   - `git push origin v1.0.0`
2. GitHub Actions 會自動建置並發佈 `.dmg` 與 `.exe` 至 Release 頁面。

## 配額來源（唯讀）
- Cursor：讀取本機 `state.vscdb` access token，呼叫 `api2.cursor.sh` DashboardService。
- Claude Code：讀取 `CLAUDE_CODE_OAUTH_TOKEN`、macOS Keychain，或 `.credentials.json`，呼叫 `api.anthropic.com/api/oauth/usage`。
- 所有 token 只在記憶體短暫使用，不會寫入本地 store 或通知內容。

## 安全保證
- 不開啟登入瀏覽器，不維護 cookie/session 檔案。
- 不寫入 Cursor `state.vscdb`、Claude credentials、Keychain。
- CI 會執行 `check:readonly` 防止敏感路徑寫入邏輯被引入。

## 相關文件
- `doc/Guide.md`
