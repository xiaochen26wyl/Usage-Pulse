/**
 * Git 日常流程：sync-main、開分支、收工、合回 main。
 * 用法：node scripts/git-workflow.mjs <command> [args...]
 */
import { spawnSync } from "node:child_process";
import { runIssueSync } from "./github-issue-sync.mjs";

const REMOTE = "origin";
const MAIN = "main";
/** 產品 v1.0.0 → 分支前綴 v100；升版時改此常數 */
const DEV_VERSION = "v100";

const BRANCH_NAME_RE = /^v\d{3}_\d{4}_\d{4}(_[A-Za-z][A-Za-z0-9_]*)?$/;
const SUFFIX_ONLY_RE = /^_?[A-Za-z][A-Za-z0-9_]*$/;

function git(args, { inherit = true } = {}) {
  const r = spawnSync("git", args, {
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
  });
  if (r.status !== 0) {
    const err = new Error(`git ${args.join(" ")} failed`);
    err.status = r.status ?? 1;
    err.stdout = r.stdout;
    err.stderr = r.stderr;
    throw err;
  }
  return inherit ? "" : (r.stdout ?? "").trim();
}

function gitQuiet(args) {
  return git(args, { inherit: false });
}

function gitTry(args) {
  const r = spawnSync("git", args, {
    encoding: "utf8",
    stdio: "pipe",
  });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

function fetchOrigin() {
  git(["fetch", REMOTE]);
}

function commitsBehindOriginMain() {
  const count = gitQuiet(["rev-list", "--count", `HEAD..${REMOTE}/${MAIN}`]);
  return parseInt(count, 10) || 0;
}

function commitsAheadOfOriginMain() {
  const count = gitQuiet(["rev-list", "--count", `${REMOTE}/${MAIN}..HEAD`]);
  return parseInt(count, 10) || 0;
}

function assertNoMergeInProgress() {
  if (gitTry(["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok) {
    fail(
      "目前正在 merge 中。請先完成衝突並 commit，或執行：git merge --abort\n詳見 doc/Git_Workflow.md §6 衝突處理 SOP",
    );
  }
  const unmerged = gitQuiet(["diff", "--name-only", "--diff-filter=U"]);
  if (unmerged) {
    fail(
      `尚有未解衝突檔案：\n${unmerged.split("\n").join("\n  - ")}\n請依 doc/Git_Workflow.md §6 衝突處理 SOP 處理`,
    );
  }
}

function assertSyncedWithOriginMain(action) {
  fetchOrigin();
  const behind = commitsBehindOriginMain();
  if (behind > 0) {
    const branch = currentBranch();
    const hint =
      branch === MAIN
        ? `請先執行：git pull ${REMOTE} ${MAIN}`
        : "請先執行：pnpm run git:sync-main";
    const subject = branch === MAIN ? `本機 ${MAIN}` : "功能分支";
    fail(
      `${subject}落後 ${REMOTE}/${MAIN} ${behind} 個 commit，無法「${action}」。\n${hint}\n（解衝突見 doc/Git_Workflow.md §6 衝突處理 SOP）`,
    );
  }
}

function currentBranch() {
  return gitQuiet(["branch", "--show-current"]);
}

function fail(message, code = 1) {
  console.error(`\n❌ ${message}\n`);
  process.exit(code);
}

function warn(message) {
  console.warn(`\n⚠️  ${message}\n`);
}

function assertNotMain(action) {
  const branch = currentBranch();
  if (branch === MAIN) {
    fail(
      `目前在 ${MAIN} 分支，無法執行「${action}」。\n請先 checkout 功能分支，例如：git checkout v100_2026_0818`,
    );
  }
  return branch;
}

function defaultBranchName(suffix) {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const base = `${DEV_VERSION}_${y}_${m}${d}`;
  if (!suffix) return base;
  const s = suffix.replace(/^_/, "");
  return `${base}_${s}`;
}

function parseBranchArg(arg) {
  const raw = arg?.trim();
  if (!raw) return defaultBranchName();
  if (BRANCH_NAME_RE.test(raw)) return raw;
  if (SUFFIX_ONLY_RE.test(raw)) return defaultBranchName(raw);
  return raw;
}

function isFeatureBranchName(name) {
  return BRANCH_NAME_RE.test(name);
}

function validateBranchName(name) {
  if (!BRANCH_NAME_RE.test(name)) {
    warn(
      `分支名「${name}」不符合建議格式 ${DEV_VERSION}_YYYY_MMDD 或 ${DEV_VERSION}_YYYY_MMDD_Li。仍會繼續。`,
    );
  }
}

function listLocalFeatureBranches() {
  const raw = gitQuiet(["for-each-ref", "refs/heads/", "--format=%(refname:short)"]);
  return raw
    .split("\n")
    .map((b) => b.trim())
    .filter((b) => b && b !== MAIN && isFeatureBranchName(b));
}

function isMergedIntoMain(branch) {
  const merged = gitQuiet(["branch", "--merged", MAIN]);
  return merged
    .split("\n")
    .some((line) => line.replace(/^\*?\s+/, "").trim() === branch);
}

function commitsAheadUnpushed(branch) {
  const upstream = gitTry([
    "rev-parse",
    "--abbrev-ref",
    `${branch}@{upstream}`,
  ]);
  if (upstream.ok) {
    const count = gitTry([
      "rev-list",
      "--count",
      `${upstream.out}..${branch}`,
    ]);
    return count.ok ? parseInt(count.out, 10) || 0 : 0;
  }
  const notInMain = gitTry(["rev-list", "--count", `${MAIN}..${branch}`]);
  return notInMain.ok ? parseInt(notInMain.out, 10) || 0 : 0;
}

function listUnpushedFeatureBranches() {
  fetchOrigin();
  const result = [];
  for (const branch of listLocalFeatureBranches()) {
    if (isMergedIntoMain(branch)) continue;
    const ahead = commitsAheadUnpushed(branch);
    if (ahead > 0) {
      result.push({ branch, ahead });
    }
  }
  return result;
}

function assertNoUnpushedFeatureBranches() {
  const unpushed = listUnpushedFeatureBranches();
  if (unpushed.length === 0) return;

  const lines = unpushed
    .map(({ branch, ahead }) => {
      const up = gitTry(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
      const reason = up.ok
        ? `領先 ${up.out} ${ahead} 個 commit`
        : `尚未推送（相對 ${MAIN} ${ahead} 個 commit）`;
      return `  - ${branch}（${reason}）`;
    })
    .join("\n");

  fail(
    `尚有功能分支未推送到遠端或未收工：\n${lines}\n請先對該分支說「收工」（pnpm run git:finish-work），再開新分支。`,
  );
}

function printConflictHelp() {
  console.error("\n發生 merge 衝突。請依 doc/Git_Workflow.md §6 衝突處理 SOP：");
  console.error("  取捨：§6.0（該檔最後 commit 時間較新的一側優先）");
  console.error("  1. git status --short 確認衝突檔");
  console.error("  2. Merge Editor 或 Cursor：「請協助解決 … 的衝突」");
  console.error("  3. git add … && git commit（完成 merge）");
  console.error("  4. 放棄：git merge --abort\n");
  try {
    git(["status", "--short"], { inherit: true });
  } catch {
    // ignore
  }
}

function mergeOriginMain() {
  assertNoMergeInProgress();
  console.log(`\n📥 同步 ${REMOTE}/${MAIN} → ${currentBranch()} …\n`);
  fetchOrigin();
  try {
    git(["merge", `${REMOTE}/${MAIN}`, "--no-edit"]);
    console.log(`\n✅ 已與 ${REMOTE}/${MAIN} 同步（或本來已是最新）。\n`);
  } catch (e) {
    printConflictHelp();
    process.exit(e.status ?? 1);
  }
}

function cmdCheckSync() {
  const branch = currentBranch();
  fetchOrigin();

  if (branch === MAIN) {
    const behind = parseInt(
      gitQuiet(["rev-list", "--count", `HEAD..${REMOTE}/${MAIN}`]),
      10,
    );
    if (behind > 0) {
      fail(
        `本機 ${MAIN} 落後 ${REMOTE}/${MAIN} ${behind} 個 commit。請執行：git pull ${REMOTE} ${MAIN}`,
      );
    }
    console.log(`\n✅ 本機 ${MAIN} 已與 ${REMOTE}/${MAIN} 一致。\n`);
    return;
  }

  const behind = commitsBehindOriginMain();
  const ahead = commitsAheadOfOriginMain();

  if (behind === 0) {
    console.log(`\n✅ ${branch} 已包含 ${REMOTE}/${MAIN}（落後 0 commit）`);
    if (ahead > 0) {
      console.log(`   功能分支領先 ${ahead} 個 commit（開發中，正常）`);
    }
    console.log("");
    return;
  }

  fail(
    `❌ ${branch} 落後 ${REMOTE}/${MAIN} ${behind} 個 commit。\n請執行：pnpm run git:sync-main\n`,
  );
}

function cmdSyncMain() {
  const branch = currentBranch();
  if (branch === MAIN) {
    fail(
      `請先 checkout 功能分支再執行 sync-main。\n建立新分支：pnpm run git:start-branch`,
    );
  }
  mergeOriginMain();
}

function cmdStartBranch(nameArg) {
  const name = parseBranchArg(nameArg);
  validateBranchName(name);

  console.log(`\n🌿 建立功能分支：${name}\n`);
  git(["checkout", MAIN]);
  git(["pull", REMOTE, MAIN]);
  try {
    git(["checkout", "-b", name]);
  } catch {
    fail(`無法建立分支「${name}」（可能已存在）。`);
  }
  console.log(`\n✅ 已切換至 ${name}`);
  console.log("建議接續：pnpm run git:sync-main 或使用 pnpm run git:start-work\n");
}

function cmdStartWork(nameArg) {
  console.log("\n🚀 每次開工（檢查舊分支 → 開分支 → sync main）\n");
  assertNoUnpushedFeatureBranches();
  cmdStartBranch(nameArg);
  cmdSyncMain();
  console.log(`\n✅ 開工完成：${currentBranch()} 已含 ${REMOTE}/${MAIN}\n`);
}

function splitMessageAndIssueFlags(argv) {
  let args = [...argv];
  while (args[0] === "--") {
    args.shift();
  }
  const dashDash = args.indexOf("--");
  if (dashDash === -1) {
    return { message: args.join(" ").trim(), issueFlags: [] };
  }
  return {
    message: args.slice(0, dashDash).join(" ").trim(),
    issueFlags: args.slice(dashDash + 1),
  };
}

async function syncIssuesBeforePush({ mode, message, issueFlags, sinceMain }) {
  const code = await runIssueSync([
    "--mode",
    mode,
    "--message",
    message,
    "--skip-if-no-gh",
    ...(sinceMain ? ["--since-main"] : []),
    ...issueFlags,
  ]);
  if (code !== 0) {
    fail("GitHub issue 同步失敗，已中止 push。請修正後重試。");
  }
}

async function pushWipToRemote(branch, msg, issueFlags = []) {
  assertNoMergeInProgress();
  assertSyncedWithOriginMain("推送");

  console.log(`\n📤 推送：${branch}（已確認含 ${REMOTE}/${MAIN}）\n`);
  git(["add", "-A"]);

  const status = gitQuiet(["status", "--porcelain"]);
  if (!status) {
    console.log("沒有變更可 commit，略過 commit。");
  } else {
    git(["commit", "-m", msg]);
  }

  await syncIssuesBeforePush({
    mode: "wip",
    message: msg,
    issueFlags,
    sinceMain: false,
  });

  const upstream = gitTry(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
  if (upstream.ok) {
    git(["push", REMOTE, "HEAD"]);
  } else {
    git(["push", "-u", REMOTE, "HEAD"]);
  }
  console.log(`\n✅ 已推送至 ${REMOTE}/${branch}（未合併 ${MAIN}）\n`);
}

function commitsAheadOfOriginMainOnHead() {
  fetchOrigin();
  return (
    parseInt(gitQuiet(["rev-list", "--count", `${REMOTE}/${MAIN}..HEAD`]), 10) ||
    0
  );
}

function pushMainIfAhead() {
  const ahead = commitsAheadOfOriginMainOnHead();
  if (ahead > 0) {
    git(["push", REMOTE, MAIN]);
    console.log(`\n✅ 已推送 ${ahead} 個 commit 至 ${REMOTE}/${MAIN}\n`);
  } else {
    console.log(`\n✅ 本機 ${MAIN} 已與 ${REMOTE}/${MAIN} 一致，無需 push。\n`);
  }
}

async function pushMainToRemote(msg, issueFlags = [], { mode = "wip" } = {}) {
  assertNoMergeInProgress();
  const action = mode === "finish" ? "收工" : "推送";
  assertSyncedWithOriginMain(action);

  console.log(`\n📤 直接推送 ${MAIN}（已確認與 ${REMOTE}/${MAIN} 同步）\n`);
  git(["add", "-A"]);

  const status = gitQuiet(["status", "--porcelain"]);
  if (!status) {
    console.log("沒有變更可 commit，略過 commit。");
  } else {
    git(["commit", "-m", msg]);
  }

  await syncIssuesBeforePush({
    mode: mode === "finish" ? "finish" : "wip",
    message: msg,
    issueFlags,
    sinceMain: true,
  });

  pushMainIfAhead();
}

async function cmdEndDay(argv) {
  const { message, issueFlags } = splitMessageAndIssueFlags(argv);
  const msg = message?.trim();
  if (!msg) {
    fail(
      '請提供 commit 訊息，例如：pnpm run git:push-wip -- "feat: 完成某功能"',
    );
  }
  const branch = currentBranch();
  if (branch === MAIN) {
    await pushMainToRemote(msg, issueFlags, { mode: "wip" });
  } else {
    await pushWipToRemote(branch, msg, issueFlags);
  }
}

function mergeFeatureToMain(feature) {
  git(["checkout", MAIN]);
  git(["pull", REMOTE, MAIN]);

  try {
    git(["merge", feature, "--no-edit"]);
  } catch (e) {
    printConflictHelp();
    console.error(
      `目前停在 ${MAIN}，請解衝突後 commit，再：git push ${REMOTE} ${MAIN}\n`,
    );
    process.exit(e.status ?? 1);
  }

  git(["push", REMOTE, MAIN]);
  console.log(`\n✅ ${feature} 已合併並推送至 ${REMOTE}/${MAIN}`);
}

function cmdMergeToMain() {
  const feature = assertNotMain("合併回 main");
  assertNoMergeInProgress();
  console.log(`\n🔀 將 ${feature} 合併回 ${MAIN} …\n`);

  mergeOriginMain();
  mergeFeatureToMain(feature);
  console.log(`遠端功能分支仍保留：${REMOTE}/${feature}`);
  console.log(
    "建議清理：pnpm run git:cleanup-branches（預覽）→ -- --apply / --delete-remote <分支>\n",
  );
}

async function cmdFinishWork(argv) {
  const { message, issueFlags } = splitMessageAndIssueFlags(argv);
  const msg = message?.trim();
  const branch = currentBranch();

  if (branch === MAIN) {
    assertNoMergeInProgress();
    console.log(`\n🏁 收工：${MAIN}（直接推送）\n`);
    assertSyncedWithOriginMain("收工");

    const dirty = gitQuiet(["status", "--porcelain"]);
    let commitMsg = msg;
    if (dirty) {
      if (!msg) {
        fail(
          '工作區有未提交變更。請附訊息：pnpm run git:finish-work -- "feat: …"',
        );
      }
      git(["add", "-A"]);
      git(["commit", "-m", msg]);
    } else if (!commitMsg) {
      commitMsg = gitQuiet(["log", "-1", "--format=%s"]);
    }

    await syncIssuesBeforePush({
      mode: "finish",
      message: commitMsg,
      issueFlags,
      sinceMain: true,
    });

    pushMainIfAhead();

    console.log("\n--- 分支清理預覽 ---");
    cmdCleanupBranches([]);
    return;
  }

  const feature = branch;
  assertNoMergeInProgress();

  console.log(`\n🏁 收工：${feature}\n`);

  mergeOriginMain();

  const dirty = gitQuiet(["status", "--porcelain"]);
  let commitMsg = msg;
  if (dirty) {
    if (!msg) {
      fail(
        '工作區有未提交變更。請附訊息：pnpm run git:finish-work -- "feat: …"，或先「推送」。',
      );
    }
    git(["add", "-A"]);
    git(["commit", "-m", msg]);
  } else if (!commitMsg) {
    commitMsg = gitQuiet(["log", "-1", "--format=%s"]);
  }

  await syncIssuesBeforePush({
    mode: "finish",
    message: commitMsg,
    issueFlags,
    sinceMain: true,
  });

  const ahead = commitsAheadUnpushed(feature);
  if (ahead > 0) {
    const upstream = gitTry(["rev-parse", "--abbrev-ref", `${feature}@{upstream}`]);
    if (upstream.ok) {
      git(["push", REMOTE, "HEAD"]);
    } else {
      git(["push", "-u", REMOTE, "HEAD"]);
    }
    console.log(`已推送 ${ahead} 個 commit 至 ${REMOTE}/${feature}`);
  }

  mergeFeatureToMain(feature);

  console.log("\n--- 分支清理預覽 ---");
  cmdCleanupBranches([]);
}

function parseCleanupArgs(argv) {
  let apply = false;
  let deleteRemote = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") {
      apply = true;
    } else if (argv[i] === "--delete-remote") {
      deleteRemote = argv[++i]?.trim();
      if (!deleteRemote) {
        fail("--delete-remote 需要分支名（不含 origin/ 前綴）");
      }
    }
  }
  return { apply, deleteRemote };
}

function listLocalMergedBranches() {
  const raw = gitQuiet(["branch", "--merged", MAIN]);
  const current = currentBranch();
  return raw
    .split("\n")
    .map((line) => line.replace(/^\*?\s+/, "").trim())
    .filter((name) => name && name !== MAIN && name !== current);
}

function listRemoteMergedBranches() {
  const raw = gitQuiet(["branch", "-r", "--merged", `${REMOTE}/${MAIN}`]);
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (line.includes("HEAD ->")) return false;
      const name = line.replace(`${REMOTE}/`, "");
      return name !== MAIN;
    })
    .map((line) => line.replace(`${REMOTE}/`, ""));
}

function cmdCleanupBranches(argv) {
  const { apply, deleteRemote } = parseCleanupArgs(argv);

  console.log(`\n🧹 分支清理（${REMOTE}）\n`);
  fetchOrigin();
  console.log("已執行 git fetch --prune\n");

  if (deleteRemote) {
    const mergedRemote = listRemoteMergedBranches();
    if (!mergedRemote.includes(deleteRemote)) {
      warn(
        `「${deleteRemote}」不在「已 merge 進 ${REMOTE}/${MAIN}」的遠端分支清單中，仍會嘗試刪除。`,
      );
    }
    git(["push", REMOTE, "--delete", deleteRemote]);
    console.log(`\n✅ 已刪除遠端分支 ${REMOTE}/${deleteRemote}\n`);
    return;
  }

  const localBranches = listLocalMergedBranches();
  const remoteBranches = listRemoteMergedBranches();

  console.log("--- 可刪除的本地分支（已 merge 進 main，不含目前分支）---");
  if (localBranches.length === 0) {
    console.log("（無）");
  } else {
    for (const b of localBranches) console.log(`  ${b}`);
  }

  console.log("\n--- 建議刪除的遠端分支（已 merge 進 origin/main）---");
  if (remoteBranches.length === 0) {
    console.log("（無）");
  } else {
    for (const b of remoteBranches) console.log(`  ${b}`);
  }

  if (apply) {
    console.log("\n--- 刪除本地分支 ---");
    for (const b of localBranches) {
      try {
        git(["branch", "-d", b]);
        console.log(`  已刪除：${b}`);
      } catch {
        console.error(`  無法刪除：${b}（可能未完全 merge，請手動檢查）`);
      }
    }
  }

  console.log("\n下一步：");
  if (!apply && localBranches.length > 0) {
    console.log("  刪除上列本地分支：pnpm run git:cleanup-branches -- --apply");
  }
  if (remoteBranches.length > 0) {
    console.log(
      "  刪除單一遠端分支：pnpm run git:cleanup-branches -- --delete-remote <分支名>",
    );
  }
  console.log("  詳見 doc/Git_Workflow.md §8\n");
}

function usage() {
  console.log(`
Usage-Pulse Git 日常流程

  node scripts/git-workflow.mjs sync-main
  node scripts/git-workflow.mjs check-sync
  node scripts/git-workflow.mjs start-work [v100_YYYY_MMDD|Li]
  node scripts/git-workflow.mjs start-branch [name]
  node scripts/git-workflow.mjs push-wip "<commit message>" [-- --issues 1]
    （在 main 上：commit → issue 留言 → push origin/main）
  node scripts/git-workflow.mjs finish-work ["commit message"] [-- --issues 1 --close 1]
    （在 main 上：commit → issue 留言 → push origin/main → 清理預覽，略過 merge）
  node scripts/git-workflow.mjs merge-to-main
  node scripts/git-workflow.mjs cleanup-branches [--apply] [--delete-remote <name>]

pnpm：git:start-work、git:sync-main、git:push-wip、git:finish-work、git:cleanup-branches（詳見 doc/Git_Workflow.md）
`);
}

const [command, ...rest] = process.argv.slice(2);

if (!command) {
  usage();
  process.exit(1);
}

try {
  switch (command) {
    case "sync-main":
      cmdSyncMain();
      break;
    case "check-sync":
      cmdCheckSync();
      break;
    case "start-work":
      cmdStartWork(rest.join(" ") || undefined);
      break;
    case "start-branch":
      cmdStartBranch(rest.join(" ") || undefined);
      break;
    case "push-wip":
    case "end-day":
      await cmdEndDay(rest);
      break;
    case "finish-work":
      await cmdFinishWork(rest);
      break;
    case "merge-to-main":
      cmdMergeToMain();
      break;
    case "cleanup-branches":
      cmdCleanupBranches(rest);
      break;
    default:
      console.error(`未知指令：${command}`);
      usage();
      process.exit(1);
  }
} catch (e) {
  if (e.status !== undefined) process.exit(e.status);
  throw e;
}
