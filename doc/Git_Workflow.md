# Git 日常流程

Usage-Pulse 功能開發的 Git 節奏：**`main` 保持穩定**。**每次開工**開新功能分支並 sync `origin/main`；開發中用**推送**只推功能分支；**收工**才合併回 `main` 並清理分支。**例外**：若你已在 `main` 上開發，「推送」「收工」會直接 `push origin/main`（見 §1、§3）。

**Agent 觸發語正文**見根目錄 [`CLAUDE.md`](../CLAUDE.md) **§4**；Cursor [`.cursorrules`](../.cursorrules) 的 Git 日常流程一節指向本檔與該節。

---

## 指令速查

### 推薦：跟 Agent 說一句話

| 你說 | Agent 代跑 |
|------|------------|
| **每次開工**、**開工** | `git:start-work`（檢查舊分支已推送 → 開分支 → sync main；可帶 `v100_2026_0818` 或後綴 `Li`） |
| **同步 main**、**開工同步** | 僅 `git:sync-main`（已在功能分支、不開新分支） |
| **推送** | `detect` → 多選 issue（若同分）→ 代寫 commit 並直接 `git:push-wip`；依本輪變更留言／更新／關閉 issue；**在 `main` 時** → 直接 push `origin/main` |
| **收工**、**完工** | `detect` → 多選（若同分）→ 代寫 commit 並直接 `git:finish-work`；Agent 自決關／改 issue；**在 `main` 時** → 直接 push `origin/main`、清理預覽（略過 merge） |
| **幫我寫 commit** | 只產生訊息，不 push |
| **git 狀態** | `git:check-sync` + `git status` |
| **只合併 main** | `git:merge-to-main`（不含收工前半） |
| **清理分支**、**git 清理** | `git:cleanup-branches`（`--apply`／`--delete-remote` 需你確認） |
| **請協助解決 … 的衝突** | 依 §6.0（較新 commit 優先） |

**開工閘門**：若有舊功能分支尚未推送到遠端，會**拒絕開新分支**，請先對該分支「收工」。

**收工前**可說「先 typecheck 再收工」；預設不自動跑 CI 全套。

### 終端手動

```bash
pnpm run git:start-work
pnpm run git:start-work -- Li
pnpm run git:sync-main
pnpm run git:push-wip -- "feat: 簡短說明"
pnpm run git:push-wip -- "feat: 簡短說明" -- --issues 1
pnpm run git:issue-sync -- detect
pnpm run git:finish-work -- "feat: 本輪完成說明"
pnpm run git:finish-work -- "feat: 本輪完成" -- --issues 1 --close 1
pnpm run git:cleanup-branches
pnpm run git:cleanup-branches -- --apply
pnpm run git:cleanup-branches -- --delete-remote v100_2026_0818
```

---

## 1. 原則

| 做法 | 結果 |
|------|------|
| 每天 push `main`（功能分支未收工就直推 main） | main 變成半成品 |
| 每次開工 `start-work` | 檢查舊分支 → 新分支 + 含最新 `origin/main` |
| 階段性 `push-wip`（功能分支） | 只備份功能分支，不合 main |
| **收工** `finish-work`（功能分支） | merge 回 `main` 並清理 |
| **在 `main` 直推**（例外） | `push-wip`／`finish-work` 直接 push `origin/main` |

---

## 2. 功能分支命名

**格式**：`v<版本>_<年份>_<月日>[_<後綴>]`

| 片段 | 含義 | 目前 |
|------|------|------|
| `v100` | 開發版本（v1.0.0） | `scripts/git-workflow.mjs` 內 `DEV_VERSION` |
| `2026` | 四位年份 | |
| `0818` | 開分支日 `MMDD` | |
| `_Li` | 多人協作後綴（可選） | `v100_2026_0818_Li` |

升版（如 v1.1.0）時改腳本 `DEV_VERSION` 為 `v110`。

---

## 3. pnpm 指令

| 指令 | 說明 |
|------|------|
| `pnpm run git:start-work` | **每次開工**：舊分支閘門 → 開分支 → `sync-main` |
| `pnpm run git:start-branch` | 僅開分支（不跑閘門／不 sync） |
| `pnpm run git:sync-main` | 將 `origin/main` merge 進目前功能分支 |
| `pnpm run git:check-sync` | 只檢查是否已含 `origin/main` |
| `pnpm run git:push-wip` | 推送：commit → issue 留言 → push 功能分支；**在 `main` 上** → push `origin/main` |
| `pnpm run git:finish-work` | **收工**：sync → commit → issue 留言 → push → 合 main → 清理預覽 |
| `pnpm run git:issue-sync` | Issue 偵測（`detect`）或獨立同步（`sync`） |
| `pnpm run git:merge-to-main` | 僅合併功能分支進 `main` |
| `pnpm run git:cleanup-branches` | 列出／刪除已 merge 分支 |
| `pnpm run git:end-day` | 同 `push-wip`（相容舊稱） |

### 推送前 GitHub issue 同步

`push-wip` 與 `finish-work` 在 **git push 之前**會呼叫 [`scripts/github-issue-sync.mjs`](../scripts/github-issue-sync.mjs)：

| 行為 | 說明 |
|------|------|
| **偵測** | 依 commit 訊息中的 `#N`、`Refs #N` 等 |
| **推送** | 對選定 issue **留言**進度 |
| **收工** | 同上；該關的帶 `--close` 或 `gh issue close` |
| **無法對應** | 警告後仍 push |
| **gh 未登入** | 警告略過 issue 同步，仍 push |

**旗標**（接在 `--` 之後）：`--issues 1,2`、`--close 1`

本 repo 目前**沒有** roadmap 檔；issue 對應主要靠 commit 訊息或 `--issues`。

---

## 4. 標準工作節奏

| 時機 | pnpm | 跟 Agent 說 |
|------|------|-------------|
| **每次開工** | `git:start-work` | **開工** |
| **中途拉 main** | `git:sync-main` | **同步 main** |
| **階段備份** | `git:push-wip` | **推送** |
| **收工** | `git:finish-work` | **收工**、**完工** |
| **分支清理** | `git:cleanup-branches` | **清理分支** |

---

## 5. 收工前品質檢查（建議）

合併回 `main` 前建議本機跑：

```bash
pnpm typecheck
pnpm check:readonly
pnpm test:unit
pnpm build
pnpm smoke:build
```

---

## 6. 衝突處理 SOP

### 6.0 衝突取捨原則

**每次 merge 衝突，以該檔「最後一次 git 變動較新」的一側為準。**

```bash
git log -1 --format=%ci HEAD -- path/to/file.ts
git log -1 --format=%ci MERGE_HEAD -- path/to/file.ts
```

**%ci 較晚者勝**。

### 6.1 放棄此次 merge

```bash
git merge --abort
```

### 6.2 `package.json` 衝突

1. 手動合併 `dependencies` / `devDependencies`
2. `pnpm install`
3. `git add package.json pnpm-lock.yaml`
4. `git commit`（完成 merge）

---

## 7. Agent Issue 判斷（§4 摘要）

推送與收工／完工共用，Agent 自決、不問：

- 本輪已完成 → 留言 + 關閉（`--close` 或 `gh issue close`）
- 部分完成 → 留言 + `gh issue edit` 更新 body，不關
- 整個 issue 不再適用 → `gh issue delete` 或 close

commit 訊息可含 `Refs #N` 或 `Closes #N` 協助腳本偵測。

---

## 8. 分支清理

收工後 `finish-work` 會印出已 merge 的分支預覽：

```bash
pnpm run git:cleanup-branches -- --apply
pnpm run git:cleanup-branches -- --delete-remote v100_2026_0818
```

---

## 9. 常見錯誤

| 狀況 | 處理 |
|------|------|
| 開工被拒：舊分支未收工 | 對舊分支說「收工」 |
| 推送被拒：落後 `origin/main` | `pnpm run git:sync-main` |
| 在 `main` 上跑 `merge-to-main` | 請先 checkout 功能分支 |
| gh 未登入 | `gh auth login`（略過 issue 同步仍可 push） |
