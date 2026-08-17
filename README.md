# Usage-Pulse

Usage-Pulse 是跨平台桌面選單列工具，用於監控 Cursor 與 Claude 配額，並在變化或低額度時推播通知。

## 技術棧
- Electron + TypeScript
- React（控制面板）
- Playwright（配額抓取）
- menubar（MenuBar / Tray）
- electron-store（本地設定儲存）
- axios（LINE Messaging API）

## 專案結構
```text
Usage-Pulse/
  src/
    main/      # Electron 主程序、排程、抓取、通知、IPC
    renderer/  # React 控制面板
    shared/    # 共用型別
    types/     # 視窗 API 型別
  auth/        # 本地 Session 檔案（不會上傳）
  doc/         # 專案文件
  .github/workflows/release.yml
```

## 安裝與執行
1. 安裝依賴：
   - `pnpm install`
2. 安裝 Playwright Chromium：
   - `pnpm playwright:install`
3. 啟動開發模式：
   - `pnpm dev`

## 常用指令
- `pnpm dev`：啟動 Electron 開發模式
- `pnpm build`：建置應用程式
- `pnpm dist:mac`：輸出 macOS `.dmg`
- `pnpm dist:win`：輸出 Windows `.exe`
- `pnpm typecheck`：執行 TypeScript 型別檢查

## Release 發布
1. 建立並推送 tag：
   - `git tag v1.0.0`
   - `git push origin v1.0.0`
2. GitHub Actions 會自動建置並發佈 `.dmg` 與 `.exe` 至 Release 頁面。

## 相關文件
- `doc/Guide.md`
