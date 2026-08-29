# 資安檢測報告

> 檢測日期：2026-08-25 ｜ 對象：`main` 分支工作區 ｜ 範圍：Electron 設定、IPC 邊界、憑證處理、子行程呼叫、renderer 注入面、相依套件、CI／發版鏈

Usage-Pulse 處理三組真實憑證：Cursor access token、Claude Code OAuth token，以及可對使用者 LINE 官方帳號廣播的 Channel Access Token。本報告記錄一輪完整靜態檢測的結果、已完成的修補，以及刻意保留的已知風險。

架構面本來就站得住：`contextIsolation: true`、`nodeIntegration: false`、secret 以 `safeStorage` 加密後才落地、Claude token 早已有不過 IPC 的遮罩機制、憑證來源維持唯讀並有 CI 守衛。以下問題是這個基礎上的落差。

---

## 總表

| # | 嚴重度 | 問題 | 狀態 |
|---|--------|------|------|
| H1 | 高 | Claude token 出現在 `security` 的命令列參數中 | ✅ 已修 |
| H2 | 高 | Keychain 寫入失敗時 token 被寫進 log | ✅ 已修 |
| M1 | 中 | Electron 33.4.11 已 EOL，且無自動更新機制 | ⚠️ 已知風險（本次不處理） |
| M2 | 中 | 無 CSP、無視窗導航鎖定、未啟用 sandbox | ✅ 已修 |
| M3 | 中 | LINE token 明文經 IPC 交給 renderer | ✅ 已修 |
| M4 | 中 | IPC handler 不驗證 renderer 傳來的參數 | ✅ 已修 |
| L1 | 低 | 登入網址以可混淆的 regex 比對後自動開啟 | ✅ 已修 |
| L2 | 低 | `app:open-external` 接受任意 https 網址 | ✅ 已修 |
| L3 | 低 | setup-token 明文暫存檔可能殘留 | ✅ 已修 |
| L4 | 低 | postinstall 腳本的 PowerShell 引號可被路徑破壞 | ✅ 已修 |
| L5 | 低 | 唯讀守衛看不見子行程寫入 | ✅ 已修 |
| L6 | 低 | 發布產物未簽章／未公證、無 checksum | ⚠️ 已知風險（本次不處理） |
| L7 | 低 | 加密不可用時靜默改存明文；解密失敗回傳密文 | ✅ 已修 |

---

## 高風險

### H1 — Claude token 出現在 `ps` 可見的命令列參數

**原始位置**：`src/main/credential-provider.ts`（`writeClaudeSetupTokenToKeychain`）

寫入 Keychain 時，token 被包成 JSON blob 當作 `security` 的 `-w` 參數傳出去：

```
security add-generic-password -s "Claude Code-credentials" -a <user> -w {"claudeAiOauth":{"accessToken":"sk-ant-oat01-…"}} -U
```

行程參數列不是秘密。macOS 雖然只讓同一個 uid 讀取彼此的 argv，但「同一使用者底下的其他行程」正是這個 app 想防的威脅模型——它整套設計就是為了不把憑證交給不該拿到的東西。任何在使用者身分下執行的程式，只要在這個呼叫存活的期間跑一次 `ps -ax -o command=`，就能取得一枚可直接呼叫 Anthropic API 的長效 token。

**修補**：改用 `spawn`，`-w` 不帶值，token 走子行程 stdin。實測確認 `security` 在非 TTY 環境下確實會從 stdin 讀取，但它會**問兩次**（輸入 + 確認），只送一次會讓兩次提示不一致而靜默存入空字串——因此 blob 會寫入兩次。同檔案三處 `find-generic-password` 不傳 secret，維持原樣。

### H2 — 失敗路徑把 token 印進 log

**原始位置**：`src/main/index.ts`（`console.error("[Usage-Pulse] Keychain write for setup-token failed", error)`）

這與 H1 是同一條鏈的兩半。Node 會把**完整命令、含所有參數**掛在 `execFile` 錯誤的 `error.cmd` 上，`error.message` 本身也是 `Command failed: <完整命令>`。因此只要 Keychain 寫入失敗，上面那行就會把 H1 的整條命令、連同 token，原樣印到 stderr。同樣的形狀也適用於 axios 錯誤，其 `config.headers.Authorization` 會被 `util.inspect` 一併印出。

**修補**：新增 `src/main/log-redaction.ts`，`redact()` 會把 Error 收斂成 `name: message` 並遮蔽 `sk-ant-*`、`Bearer *`、`"accessToken":"…"`、`channelAccessToken`。`src/main/**` 內所有把 error 交給 `console.*` 的位置全部改走 `redact()`——原則是**永不直接把 error 物件交給 console**。

---

## 中風險

### M1 — Electron 33.4.11 已終止支援 ⚠️ 保留

`pnpm audit` 回報 52 筆（1 critical / 19 high / 26 moderate / 6 low），主要來自 `electron@33.4.11` 與 `electron-builder@25.1.8 > tar`。Electron 33 已不在支援期，其 Chromium 停在約 2024 年 10 月，代表隨附的瀏覽器引擎累積了約兩年未修補的漏洞；advisory 指出修補版本為 `>=38.8.6` 與 `>=39.8.10`，其中數筆是 use-after-free 與 renderer 命令列參數注入。

風險被三件事顯著壓低，但沒有消除：renderer 只載入本地打包頁面、不算繪 remote content；本次已補上 CSP 與導航鎖定（M2）；所有網路請求都在 main process。真正的問題是**這個 app 沒有任何自動更新機制**——`electron-updater` 並未納入相依，使用者手動安裝後就停在該版本，未來即使升級也拿不到修補，除非重新下載。

**依決定本次保留。** 日後處理路徑：升級到 Electron `39.8.10+`，同時把 `electron-builder` 升到 `26.15.0+`（可一併清掉 `tar` 的 critical 與 `app-builder-lib` 的 high）。升級橫跨 6 個大版本，需實測選單列、tray 繪圖、alarm 視窗、Keychain 讀取。

### M2 — 無 CSP、無導航鎖定、未啟用 sandbox

四個 renderer 進入點（`index.html`、`alarm.html`、`credential.html`、`session.html`）都沒有 `Content-Security-Policy`，全專案也沒有任何 `setWindowOpenHandler`、`will-navigate` 或 `will-attach-webview` 防護，四個 `webPreferences` 均未啟用 `sandbox`。

這是縱深防禦而非當下可利用的漏洞——renderer 以 React 呈現遠端字串，React 會轉義，目前沒有已知的注入點。但缺少這幾道防線意味著：任何一個未來變成 markup 的字串、或一個漏掉 `preventDefault` 的 `target="_blank"` 連結，就能得到一個**掛著 `usagePulse` preload 的完整 renderer**。

**修補**：
- 四個 HTML 加上嚴格 CSP（`default-src 'none'; script-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'`，樣式與圖片各自最小放行）。已確認 renderer 完全不發網路請求、alarm 提示音是 oscillator 合成而非載入音檔，因此 `connect-src 'none'` 可行。
- `electron.vite.config.ts` 加入 dev-only plugin，在 `electron-vite dev` 時放寬 CSP（HMR 需要 inline script 與 websocket），**打包版維持嚴格版本**——已驗證 `dist/renderer/index.html` 輸出的是嚴格策略。
- 新增 `src/main/window-hardening.ts`，於模組載入時（早於 menubar 建立視窗）掛上 `web-contents-created`，一律拒絕開新視窗、拒絕 webview、並把導航限制在 dev server origin 或打包後 `dist/renderer/` 底下的 `file://`。
- 四個視窗啟用 `sandbox: true`。已確認 preload 產物是 CJS（`require("electron")`），與 sandbox 相容。

### M3 — LINE token 明文交給 renderer

**原始位置**：`src/main/index.ts`（`maskSecrets` 只遮罩 `claudeManualOAuthToken`）、`src/renderer/App.tsx`（`setLineToken(nextSettings.lineChannelAccessToken)`）

`settings:get` 把真正的 LINE Channel Access Token 原樣送進 renderer，存進 React state。UI 上的星號只是視覺遮罩，值本身就在 renderer 記憶體裡。這是一枚可對使用者官方帳號廣播的長效憑證，而且——這點特別值得記錄——它**直接牴觸專案自己在 `CLAUDE.md` §2 寫下的規則**：「renderer 只接收派生後的 snapshot／狀態資料，不得經 IPC 傳遞原始 token／憑證內容」。Claude token 已正確遵守此規則，LINE token 被漏掉了。

**修補**：新增 `LINE_TOKEN_MASK`，比照 `CLAUDE_MANUAL_TOKEN_MASK` 納入 `maskSecrets`／`stripMaskedSecrets`。renderer 端把「值等於遮罩」視為「已儲存但不可讀」：編輯時直接開新值而非在遮罩上增刪，按儲存而未更動時不送 patch、也就不會覆寫好的 token。既有的星號顯示（上限 10 個）與空值儲存的錯誤訊息維持不變。

實機驗證：`settings:get` 現在回傳 `lineChannelAccessToken: "__stored__"`；把遮罩送回去儲存後，設定檔中的真實 token 依然存在且未被覆寫。

### M4 — IPC 參數完全未驗證

**原始位置**：`src/main/index.ts`（`setupIpcHandlers`）

所有 handler 直接信任 renderer 傳入的值。最尖銳的一處是 `service`：它從 `auth:check`／`credential:open-manual`／`credential:clear-manual` 一路流進 `store.ts` 的

```ts
store.set(`credentials.${service}`, record)
```

electron-store 會把樣板字串當作**dot path** 解讀，因此一個非預期的 `service` 字串等於一個可指向設定檔任意位置的寫入原語。此外 `settings:save` 接受任意物件並直接合併進持久化設定，`session:log-cup` 與 `app:copy-to-clipboard` 也未做任何檢查。

**修補**：新增 `src/main/ipc-validation.ts`，全部 fail-closed（無法識別就回 `null`，handler 拒絕動作）：`asServiceType`（白名單）、`asSettingsPatch`（以 `DEFAULT_SETTINGS` 的 key 與型別過濾）、`asToken`（長度上限）、`asClipboardText`（長度上限＋拒絕控制字元）、`asWaterCupSize`（沿用既有 `normalizeWaterCupSize`）。

實機驗證：以 `"settings.lineChannelAccessToken"`、`"__proto__"` 呼叫 `auth:check` 均回 `null`，設定檔沒有多出任何鍵；`settings:save` 送入未知鍵會被丟棄。

---

## 低風險

### L1 — 登入網址的網域比對可被後綴混淆

`src/main/claude-setup-token.ts` 原本以 `https:\/\/(?:[a-z0-9-]+\.)*(?:claude\.ai|anthropic\.com)[^\s"'<>]*` 比對 CLI 輸出中的登入網址，比對成功後**不經任何使用者確認**就交給 `shell.openExternal`。該樣式會讓 `https://claude.ai.evil.com/oauth/authorize?code=…` 通過——`claude.ai` 在這裡只是真正註冊網域 `evil.com` 的前綴。

**修補**：改為先寬鬆抓取候選，再以 `new URL()` 解析，要求 `protocol === "https:"` 且 hostname 等於或以 `.claude.ai` / `.anthropic.com` 結尾。已補上四組測試涵蓋後綴混淆、真實子網域、非 https、以及「不可信網址排在可信網址之前」的情況。

### L2 — `app:open-external` 接受任意 https 網址

原本只檢查 `/^https:\/\//`。renderer 實際只需要頁尾那五個支援連結。已抽出 `src/shared/support-links.ts` 供 main 與 renderer 共用，handler 改為只接受集合成員，其餘拒絕並記錄。實機驗證：`https://evil.example.com/steal` 與 `file:///etc/passwd` 均被拒絕（main log 出現 `refused openExternal for a non-allowlisted URL`，未開啟瀏覽器）。

### L3 — setup-token 明文暫存檔

`claude setup-token` 的輸出經 `tee` 寫入 userData 下的 `setup-token-capture.txt`，token 在其中以明文停留至整個登入流程結束（最長 10 分鐘）。檔案權限為 `0600` 且正常路徑會刪除，但流程中途崩潰會留下殘檔。

**修補**：刪除前先覆寫為空，並在 `app.whenReady()` 清理前次殘留的檔案。

> 附帶說明（非本專案缺陷）：同一枚 token 也會留在 Terminal 視窗的 scrollback 中，這是 `claude setup-token` 本身的行為。建議使用者完成後關閉該視窗。

### L4 — postinstall 腳本的 PowerShell 引號

`scripts/fix-electron-install.mjs` 原本把路徑內插進 `Expand-Archive -LiteralPath '${zipPath}'`。路徑中若含單引號即可破壞引號結構並改變 PowerShell 實際執行的內容。影響僅限開發者機器，但修法便宜：改以環境變數傳遞路徑（`$env:UP_ZIP_PATH`），完全不做字串內插。

### L5 — 唯讀守衛看不見子行程寫入

`scripts/check-readonly.mjs` 以子字串比對 `fs` 寫入 API。但寫入不一定經過 `fs`——H1 那個 Keychain 寫入是透過子行程執行 `security add-generic-password`，守衛完全看不到。也就是說，整個專案唯一一處會寫入憑證的地方，恰好是守衛的盲區；它給出的保證比實際覆蓋範圍更強。

**修補**：`writeHints` 補上 `add-generic-password` 等子行程寫入形式，並建立**顯式例外清單**，明確記載 `credential-provider.ts` 允許執行 `add-generic-password`。守衛現在會主動印出「正在使用允許的例外」，把這筆寫入從*看不見*變成*被記錄*；未列入清單而觸發寫入特徵者一律視為違規。

### L6 — 發布產物未簽章 ⚠️ 保留

`package.json` 設定 `mac.identity: null`，release workflow 產出未簽章、未公證的 DMG 與 NSIS，且未發布 checksum。使用者會遇到 Gatekeeper 警告，下載內容也沒有完整性保證。**依決定本次保留**，一併記錄於此。

### L7 — 加密不可用時靜默降級

`src/main/secure-store.ts` 在 `safeStorage.isEncryptionAvailable()` 為 false 時改存明文，但只發出一行 `console.warn`——使用者以為 token 受到保護，卻無從得知並非如此。另外 `decryptSecret` 的 catch 會在解密失敗時回傳原始儲存值，意即一段無法解密的**密文會被當成 token** 拿去當 Bearer 送出。

**修補**：新增 `isSecretStorageAvailable()` 並經 IPC 曝露，Settings 面板在不可用時顯示明確警告（已加入四種語言字串）。`decryptSecret` 改為：只有在字串不像 base64 時才視為舊版明文；若是合法 base64 但解密失敗則回傳空字串並記錄，讓使用者重新輸入，而不是把密文送到 provider。

---

## 驗證方式

自動化（等同 CI，全數通過）：

```bash
pnpm typecheck && pnpm check:readonly && pnpm test:unit && pnpm build && pnpm smoke:build
```

單元測試由 142 筆增為 160 筆，新增：

- `tests/log-redaction.test.ts` — token、Bearer、accessToken 欄位的遮蔽，以及 Error 的 `cmd` 等挾帶屬性不被印出。
- `tests/ipc-validation.test.ts` — `asServiceType` 擋下 dot-path 與 `__proto__`；`asSettingsPatch` 丟棄未知鍵且不造成 prototype 汙染；clipboard 拒絕控制字元；`isSupportLink` 只認頁尾連結。
- `tests/claude-setup-token.test.ts` — L1 的後綴混淆、真實子網域、非 https、候選排序。

實機驗證（`pnpm dev` + Chrome DevTools Protocol）：

| 檢查 | 結果 |
|------|------|
| `sandbox: true` 下 preload bridge | `window.usagePulse` 存在，35 個方法可用 |
| renderer CSP／console | 0 筆 error，無任何 CSP violation |
| React 掛載 | `#root` 有內容，渲染文字 1475 字元 |
| `settings:get` 回傳的 LINE token | `"__stored__"`（真值未離開 main） |
| 送回遮罩儲存 | 設定檔中的真實 token 未被覆寫 |
| `auth:check("settings.lineChannelAccessToken")` | 回 `null`，設定檔無新增鍵 |
| `auth:check("__proto__")` | 回 `null` |
| `openExternal` 攻擊者網址／`file://` | 均拒絕，未開啟瀏覽器 |
| `settings:save` 未知鍵 | 丟棄 |
| clipboard 注入換行 | 拒絕，剪貼簿未被改動 |
| tray 雙行繪圖（`data:` URL 視窗） | 正常輸出 PNG data URL |
| Keychain 寫入（`security`） | token 不再出現於 argv |

> 附註：`Unable to set login item: Operation not permitted` 是本機 macOS 權限造成的既有訊息，來自 `app.setLoginItemSettings`，與本次修補無關。

---

## 仍待處理

1. **升級 Electron 至 39.8.10+ 與 electron-builder 至 26.15.0+**（M1）。這是目前最大的單一曝險，因為沒有自動更新機制，已安裝的使用者不會拿到任何 Chromium 修補。
2. **導入更新機制或至少發布 checksum**（M1／L6），讓使用者有辦法確認手上的版本並取得後續修補。
3. **macOS 簽章與公證**（L6）。

---

## 現況更新（2026-08-28）

> 以下對照工作區現況，**不改寫** 2026-08-25 當時的發現與修補紀錄。驗證表裡的測試筆數、preload 方法數是當時數字，本次未重跑檢測。

### M1 — Electron 已升級；其餘仍在

- Electron 已升到 `package.json` 的 `^43.4.1`（lock 為 43.4.1）。當時「33 EOL」的敘述不再適用。
- **仍無** `electron-updater`；已安裝的使用者不會自動拿到 Chromium 修補。
- `electron-builder` 仍為 `25.1.8`。
- 文末「仍待處理」第 1 條改讀：Electron 大版本升級已做；未解的是自動更新、builder 26+、checksum、簽章（L6）。

### Renderer 進入點

當時列的 `credential.html` 已不存在。現有四個進入點：`index.html`、`alarm.html`、`session.html`、**`claude-login.html`**（嚴格 CSP + `sandbox: true`）。`window-hardening.ts` 的 process-wide 掛載會涵蓋新視窗。

### L3 — `tee` 截檔已移除；殘留面改到 in-app PTY

`setup-token-capture.txt` 與系統 Terminal + `tee` 路徑已刪。登入改為 `node-pty` 跑 `claude setup-token`，可見輸出在 in-app xterm（`claude-login.html`）。

目前流程已再簡化：Usage-Pulse 不再解析或自動傳送印出的 `sk-ant-oat01-…` token；使用者需手動從指令視窗複製到主視窗輸入框，再按「儲存憑證」寫入 Keychain。

仍屬「過程中可見」的殘留：

- in-app xterm 捲動緩衝會顯示印出的 `sk-ant-oat01-…`
- raw PTY 輸出經 `claude-login:data` 進登入視窗 renderer

### 新增表面（本次未做完整重測）

- `node-pty` 繼承完整 `process.env`；`package.json` 以 `asarUnpack` 帶出 native helper；`postinstall` 的 `scripts/fix-node-pty-permissions.mjs` 對 `spawn-helper` `chmod` 755（開發機／建置鏈）。
- IPC：`claude-login:input`／`resize`（renderer→main）、`claude-login:data`／`exit`（main→renderer）。`claude-login:input` 只檢查 `typeof string`，無長度上限、無 sender 視窗限制（preload 為各視窗共用）。`resize` 有 `asPtySize`（1–500）。
- 憑證寫入仍只經 `credential-provider.ts` 的 `add-generic-password` 例外；`check-readonly.mjs` 清單無需為 PTY 檔新增例外。
