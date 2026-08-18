/**
 * GitHub issue 偵測與同步（推送前留言／收工關閉）。
 * 用法：node scripts/github-issue-sync.mjs detect|sync|check-duplicates [options]
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const GITHUB_REPO = "xiaochen26wyl/Usage-Pulse";
const REMOTE = "origin";
const MAIN = "main";
const SCOPED_PREFIXES = ["src/", "tests/", "doc/", "scripts/"];

function gitQuiet(args) {
  const r = spawnSync("git", args, {
    encoding: "utf8",
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
  if (r.status !== 0) return "";
  return (r.stdout ?? "").trim();
}

function gh(args, { inherit = false } = {}) {
  const r = spawnSync("gh", args, {
    encoding: "utf8",
    cwd: REPO_ROOT,
    stdio: inherit ? "inherit" : "pipe",
  });
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
    status: r.status ?? 1,
  };
}

function isGhAuthenticated() {
  return gh(["auth", "status"]).ok;
}

function filterScopedFiles(files) {
  return files.filter((f) => SCOPED_PREFIXES.some((p) => f.startsWith(p)));
}

function collectChangedFiles({ sinceMain = false } = {}) {
  let raw = "";
  if (sinceMain) {
    raw = gitQuiet(["diff", "--name-only", `${REMOTE}/${MAIN}...HEAD`]);
    if (!raw) {
      raw = gitQuiet(["diff", "--name-only", `${MAIN}..HEAD`]);
    }
  } else {
    const staged = gitQuiet(["diff", "--name-only", "--cached"]);
    const unstaged = gitQuiet(["diff", "--name-only"]);
    const combined = new Set(
      [...staged.split("\n"), ...unstaged.split("\n")].filter(Boolean),
    );
    raw = [...combined].join("\n");
  }
  return filterScopedFiles(
    raw
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean),
  );
}

function extractCommitIssueRefs(message) {
  if (!message) return [];
  const ids = new Set();
  let m;
  const re = /(?:Refs|Closes|Fixes|Resolves)\s+#(\d+)|(?:^|\s)#(\d+)/gi;
  while ((m = re.exec(message)) !== null) {
    ids.add(parseInt(m[1] ?? m[2], 10));
  }
  return [...ids];
}

function fetchIssueTitle(issueId) {
  const r = gh([
    "issue",
    "view",
    String(issueId),
    "-R",
    GITHUB_REPO,
    "--json",
    "title,number",
  ]);
  if (!r.ok) return `#${issueId}`;
  try {
    const data = JSON.parse(r.stdout);
    return data.title ?? `#${issueId}`;
  } catch {
    return `#${issueId}`;
  }
}

/** @returns {{ candidates: Array<{id:number,title:string,score:number,reasons:string[]}>, changedFiles: string[] }} */
export function detectIssues({ sinceMain = false, commitMessage = "" } = {}) {
  const changedFiles = collectChangedFiles({ sinceMain });
  /** @type {Map<number, { score: number, reasons: string[] }>} */
  const scores = new Map();

  for (const refId of extractCommitIssueRefs(commitMessage)) {
    const reasons = [`commit:#${refId}`];
    scores.set(refId, {
      score: (scores.get(refId)?.score ?? 0) + 100,
      reasons: [...(scores.get(refId)?.reasons ?? []), ...reasons],
    });
  }

  const candidates = [...scores.entries()]
    .filter(([, v]) => v.score > 0)
    .map(([id, v]) => ({
      id,
      title: fetchIssueTitle(id),
      score: v.score,
      reasons: v.reasons,
    }))
    .sort((a, b) => b.score - a.score);

  return { changedFiles, candidates };
}

function getTopTierCandidates(candidates) {
  if (candidates.length === 0) return [];
  const topScore = candidates[0].score;
  return candidates.filter((c) => c.score === topScore);
}

function parseIssueList(value) {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(",")
        .map((s) => parseInt(s.trim().replace(/^#/, ""), 10))
        .filter((n) => !Number.isNaN(n)),
    ),
  ];
}

async function promptLine(question) {
  if (!process.stdin.isTTY) return "";
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function resolveIssueIds(candidates, explicitIssues) {
  if (explicitIssues.length > 0) return explicitIssues;

  if (candidates.length === 0) {
    console.warn("\n⚠️  無法對應 GitHub issue，略過 issue 同步。\n");
    return [];
  }

  const topTier = getTopTierCandidates(candidates);
  if (topTier.length === 1) {
    console.log(
      `\n📌 自動選定 issue #${topTier[0].id}（${topTier[0].title}，score ${topTier[0].score}）\n`,
    );
    return [topTier[0].id];
  }

  console.log("\n📋 同分 issue 候選（請多選）：");
  topTier.forEach((c, i) => {
    console.log(`  ${i + 1}. #${c.id} — ${c.title}（${c.reasons.join(", ")}）`);
  });

  if (!process.stdin.isTTY) {
    console.warn("\n⚠️  非互動終端且未指定 --issues，略過 issue 同步。\n");
    return [];
  }

  const answer = await promptLine("\n請輸入 issue 編號（逗號分隔，如 1,2）：");
  const picked = parseIssueList(answer);
  const valid = picked.filter((id) => topTier.some((c) => c.id === id));
  if (valid.length === 0 && picked.length > 0) {
    console.warn("⚠️  輸入不在候選清單內，略過 issue 同步。");
    return [];
  }
  return valid.length > 0 ? valid : [];
}

async function resolveCloseIds(mode, commentIds, explicitClose) {
  if (mode !== "finish") return [];
  if (explicitClose.length > 0) {
    return explicitClose.filter((id) => commentIds.includes(id));
  }
  if (commentIds.length === 0 || !process.stdin.isTTY) return [];

  const answer = await promptLine(
    `\n要關閉哪些 issue？（逗號分隔，Enter=不關）：`,
  );
  if (!answer) return [];
  return parseIssueList(answer).filter((id) => commentIds.includes(id));
}

function formatLocalDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function buildCommentBody({ message, changedFiles, mode, issueId, closing }) {
  const fileList =
    changedFiles.length > 0
      ? changedFiles.map((f) => `- ${f}`).join("\n")
      : "- （無 src/tests/doc/scripts 變更）";
  const op = closing
    ? `關閉 #${issueId}`
    : mode === "finish"
      ? `收工進度留言 #${issueId}`
      : `推送進度留言 #${issueId}`;

  return `## 本輪變更
- ${message || "（無 commit 訊息）"}
- 變更檔案：
${fileList}

## 同步操作
- 操作：${op}
- Repo：${GITHUB_REPO}
- 同步時間：${formatLocalDate()}（本地）`;
}

function runGhComment(issueId, body, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] gh issue comment ${issueId} -R ${GITHUB_REPO}`);
    console.log(body);
    return true;
  }
  const r = gh(["issue", "comment", String(issueId), "-R", GITHUB_REPO, "--body", body]);
  if (!r.ok) {
    console.error(`❌ gh issue comment #${issueId} 失敗：${r.stderr || r.stdout}`);
    return false;
  }
  console.log(`✅ 已留言 #${issueId}`);
  return true;
}

function runGhClose(issueId, body, dryRun) {
  if (dryRun) {
    console.log(`[dry-run] gh issue close ${issueId} -R ${GITHUB_REPO} -c "…"`);
    return true;
  }
  const r = gh(["issue", "close", String(issueId), "-R", GITHUB_REPO, "-c", body]);
  if (!r.ok) {
    console.error(`❌ gh issue close #${issueId} 失敗：${r.stderr || r.stdout}`);
    return false;
  }
  console.log(`✅ 已關閉 #${issueId}`);
  return true;
}

function parseSyncArgs(argv) {
  /** @type {{ mode: 'wip'|'finish', message: string, issues: number[], close: number[], dryRun: boolean, skipIfNoGh: boolean, sinceMain: boolean }} */
  const opts = {
    mode: "wip",
    message: "",
    issues: [],
    close: [],
    dryRun: false,
    skipIfNoGh: true,
    sinceMain: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--mode" && argv[i + 1]) {
      opts.mode = argv[++i] === "finish" ? "finish" : "wip";
    } else if (arg === "--message" && argv[i + 1]) {
      opts.message = argv[++i];
    } else if (arg === "--issues" && argv[i + 1]) {
      opts.issues = parseIssueList(argv[++i]);
    } else if (arg === "--close" && argv[i + 1]) {
      opts.close.push(...parseIssueList(argv[++i]));
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--skip-if-no-gh") {
      opts.skipIfNoGh = true;
    } else if (arg === "--require-gh") {
      opts.skipIfNoGh = false;
    } else if (arg === "--since-main") {
      opts.sinceMain = true;
    }
  }

  return opts;
}

export async function runIssueSync(argv) {
  const opts = parseSyncArgs(argv);

  console.log(`\n🔗 GitHub issue 同步（mode: ${opts.mode}）\n`);

  if (!opts.dryRun && !isGhAuthenticated()) {
    const msg = "gh 未登入。請執行：gh auth login";
    if (opts.skipIfNoGh) {
      console.warn(`\n⚠️  ${msg}（略過 issue 同步，繼續 push）\n`);
      return 0;
    }
    console.error(`\n❌ ${msg}\n`);
    return 1;
  }

  const { changedFiles, candidates } = detectIssues({
    sinceMain: opts.sinceMain,
    commitMessage: opts.message,
  });

  if (candidates.length > 0) {
    console.log("偵測候選：");
    for (const c of candidates.slice(0, 8)) {
      console.log(`  #${c.id} (${c.score}) — ${c.title}`);
    }
    console.log("");
  }

  const commentIds = await resolveIssueIds(candidates, opts.issues);
  if (commentIds.length === 0) return 0;

  const closeIds = await resolveCloseIds(opts.mode, commentIds, opts.close);

  for (const issueId of commentIds) {
    const closing = closeIds.includes(issueId);
    const body = buildCommentBody({
      message: opts.message,
      changedFiles,
      mode: opts.mode,
      issueId,
      closing,
    });

    if (closing) {
      if (!runGhClose(issueId, body, opts.dryRun)) return 1;
    } else {
      if (!runGhComment(issueId, body, opts.dryRun)) return 1;
    }
  }

  console.log("");
  return 0;
}

function cmdDetect(argv) {
  let sinceMain = false;
  let message = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--since-main") sinceMain = true;
    if (argv[i] === "--message" && argv[i + 1]) message = argv[++i];
  }
  const result = detectIssues({ sinceMain, commitMessage: message });
  console.log(JSON.stringify(result, null, 2));
}

function cmdCheckDuplicates() {
  if (!isGhAuthenticated()) {
    console.error("❌ gh 未登入；請執行 gh auth login");
    process.exit(1);
  }

  const r = gh([
    "issue",
    "list",
    "-R",
    GITHUB_REPO,
    "--state",
    "open",
    "--limit",
    "200",
    "--json",
    "number,title,createdAt",
  ]);

  if (!r.ok) {
    console.error(`❌ gh issue list 失敗：${r.stderr || r.stdout}`);
    process.exit(1);
  }

  /** @type {{ number: number, title: string, createdAt: string }[]} */
  const issues = JSON.parse(r.stdout || "[]");
  /** @type {Map<string, { number: number, title: string, createdAt: string }[]>} */
  const byTitle = new Map();

  for (const issue of issues) {
    const group = byTitle.get(issue.title) ?? [];
    group.push(issue);
    byTitle.set(issue.title, group);
  }

  let hasDuplicates = false;
  for (const [title, group] of byTitle) {
    if (group.length <= 1) continue;
    hasDuplicates = true;
    console.log(`DUPLICATE: ${title}`);
    for (const issue of group.sort((a, b) => a.number - b.number)) {
      console.log(`  #${issue.number}  opened ${issue.createdAt}`);
    }
  }

  if (!hasDuplicates) {
    console.log(`✅ 無 open issue 同標題重複（共 ${issues.length} 筆）`);
    process.exit(0);
  }

  console.error(
    `\n❌ 發現 ${[...byTitle.values()].filter((g) => g.length > 1).length} 組同標題重複`,
  );
  process.exit(1);
}

function usage() {
  console.log(`
GitHub issue 偵測與同步（Usage-Pulse）

  node scripts/github-issue-sync.mjs detect [--since-main] [--message "..."]
  node scripts/github-issue-sync.mjs check-duplicates
  node scripts/github-issue-sync.mjs sync --mode wip|finish --message "..." \\
    [--issues 1,2] [--close 1] [--dry-run] [--since-main]

選項：
  --skip-if-no-gh   gh 未登入時警告略過（預設）
  --require-gh      gh 未登入時 exit 1

偵測：依 commit 訊息中的 #N／Refs #N；可手動指定 --issues。
`);
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const [command, ...rest] = process.argv.slice(2);

  if (!command) {
    usage();
    process.exit(1);
  }

  try {
    if (command === "detect") {
      cmdDetect(rest);
    } else if (command === "check-duplicates") {
      cmdCheckDuplicates();
    } else if (command === "sync") {
      const code = await runIssueSync(rest);
      process.exit(code);
    } else {
      console.error(`未知指令：${command}`);
      usage();
      process.exit(1);
    }
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
