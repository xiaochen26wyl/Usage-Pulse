# 專案開發指南

## 專案概述
- 專案名稱：Usage-Pulse
- 目標：在 Mac / Windows 以選單列工具方式監控 AI 工具配額，並以 LINE 與桌面通知回報變化。
- 發布方式：使用 GitHub Release 提供安裝檔，不建立網站，不上架 Store。

## 資料架構
- `AppSettings`：檢查頻率、LINE Token、低額度閾值、開機啟動、通知冷卻時間
- `CombinedSnapshot`：Cursor 與 Claude 配額快照
- `Auth JSON`：登入 Session（僅存於本機 `userData/auth/*.auth.json`）

## 待開發功能
### 抓取器強化
- 強化 Cursor/Claude DOM Selector，降低版面變動造成的解析失敗率。
- 增加登入過期檢測，主動提示重新登入。

### 通知與去重
- 增加更多通知分類（恢復正常、抓取失敗、網路異常）。
- 優化 Flex Message 版型與摘要內容。

## 已完成功能
- Electron + React + TypeScript 專案骨架
- Cursor / Claude Session 登入與本地保存
- 背景抓取與排程監控
- LINE Flex Message + 桌面通知
- GitHub Actions Release（tag 觸發 `.dmg` / `.exe`）
