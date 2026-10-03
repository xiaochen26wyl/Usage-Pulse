import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanHistory,
  createNodeSqliteOpener,
  getHistoryStats,
  HISTORY_RETENTION_MS,
  type HistoryCleanerDeps,
  type OpenDatabase,
  type SqlDatabase
} from "../src/main/history-cleaner";
import { commandLineLooksLikeCodexProcess } from "../src/main/ide-presence";
import { classifyHistoryFailure, formatBytes, hasHistoryApi } from "../src/shared/history";

const openDatabase = createNodeSqliteOpener();
assert.ok(openDatabase, "node:sqlite must be available to run these tests");
const open: OpenDatabase = openDatabase;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.now();

interface Sandbox {
  root: string;
  claude: string;
  codex: string;
  trashed: string[];
  deps: HistoryCleanerDeps;
}

const setup = async (overrides: Partial<HistoryCleanerDeps> = {}): Promise<Sandbox> => {
  const root = await mkdtemp(join(tmpdir(), "usage-pulse-history-"));
  const claude = join(root, "claude");
  const codex = join(root, "codex");
  await mkdir(join(claude, "projects"), { recursive: true });
  await mkdir(codex, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claude;
  process.env.CODEX_HOME = codex;
  const trashed: string[] = [];
  return {
    root,
    claude,
    codex,
    trashed,
    deps: {
      trashItem: async (path) => {
        trashed.push(path);
      },
      isCodexRunning: async () => false,
      openDatabase: open,
      now: () => NOW,
      ...overrides
    }
  };
};

const cleanup = (sandbox: Sandbox): Promise<void> => rm(sandbox.root, { recursive: true, force: true });

// File whose last modification was `ageMs` before NOW (negative: in the future).
const touch = async (path: string, content: string, ageMs: number): Promise<void> => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
  const when = new Date(NOW - ageMs);
  await utimes(path, when, when);
};

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

const seedClaude = async (sandbox: Sandbox): Promise<void> => {
  const projects = join(sandbox.claude, "projects");
  await touch(join(projects, "projA", "old.jsonl"), "aaaa", 20 * DAY);
  await touch(join(projects, "projA", "nested", "older.jsonl"), "bbbbbb", 60 * DAY);
  await touch(join(projects, "projB", "recent.jsonl"), "c", 13 * DAY);
  await touch(join(projects, "projB", "today.jsonl"), "dd", 5 * 60_000);
  await touch(join(projects, "projA", "memory", "note.md"), "kept", 90 * DAY);
  await touch(join(projects, "projA", "memory", "stray.jsonl"), "kept", 90 * DAY);
  await touch(join(projects, "projB", "readme.txt"), "kept", 90 * DAY);
};

test("claude stats split the total from what is older than two weeks", async () => {
  const sandbox = await setup();
  try {
    await seedClaude(sandbox);
    assert.deepEqual(await getHistoryStats("claude", NOW), {
      fileCount: 4,
      totalBytes: 4 + 6 + 1 + 2,
      staleFileCount: 2,
      staleBytes: 4 + 6
    });
  } finally {
    await cleanup(sandbox);
  }
});

test("claude stats are zero when the projects folder is missing", async () => {
  const sandbox = await setup();
  try {
    await rm(join(sandbox.claude, "projects"), { recursive: true });
    assert.deepEqual(await getHistoryStats("claude", NOW), {
      fileCount: 0,
      totalBytes: 0,
      staleFileCount: 0,
      staleBytes: 0
    });
  } finally {
    await cleanup(sandbox);
  }
});

test("claude clean trashes only logs older than two weeks", async () => {
  const sandbox = await setup();
  try {
    await seedClaude(sandbox);
    const result = await cleanHistory("claude", sandbox.deps);

    assert.equal(result.status, "done");
    assert.equal(result.trashed, 2);
    assert.equal(result.failed, 0);
    assert.deepEqual(
      sandbox.trashed.map((path) => path.split("/").pop()).sort(),
      ["old.jsonl", "older.jsonl"]
    );
  } finally {
    await cleanup(sandbox);
  }
});

test("the two-week line is strict: exactly 14 days old and future-dated files stay", async () => {
  const sandbox = await setup();
  try {
    const projects = join(sandbox.claude, "projects", "p");
    await touch(join(projects, "exact.jsonl"), "x", HISTORY_RETENTION_MS);
    await touch(join(projects, "just-over.jsonl"), "x", HISTORY_RETENTION_MS + 60_000);
    await touch(join(projects, "future.jsonl"), "x", -HOUR);
    const stats = await getHistoryStats("claude", NOW);
    assert.equal(stats.staleFileCount, 1);

    const result = await cleanHistory("claude", sandbox.deps);
    assert.equal(result.trashed, 1);
    assert.equal(sandbox.trashed[0].endsWith("just-over.jsonl"), true);
  } finally {
    await cleanup(sandbox);
  }
});

test("claude clean never touches memory folders or non-log files", async () => {
  const sandbox = await setup();
  try {
    await seedClaude(sandbox);
    await cleanHistory("claude", sandbox.deps);
    assert.equal(sandbox.trashed.some((path) => path.includes("memory")), false);
    assert.equal(sandbox.trashed.some((path) => path.endsWith(".txt") || path.endsWith(".md")), false);
  } finally {
    await cleanup(sandbox);
  }
});

test("claude clean keeps going when one file cannot be trashed", async () => {
  const sandbox = await setup();
  try {
    await seedClaude(sandbox);
    const stubborn = join(sandbox.claude, "projects", "projA", "old.jsonl");
    const result = await cleanHistory("claude", {
      ...sandbox.deps,
      trashItem: async (path) => {
        if (path === stubborn) {
          throw new Error("busy");
        }
        sandbox.trashed.push(path);
      }
    });
    assert.equal(result.trashed, 1);
    assert.equal(result.failed, 1);
  } finally {
    await cleanup(sandbox);
  }
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

const NOW_SECONDS = Math.floor(NOW / 1000);
const ago = (ms: number): number => Math.floor((NOW - ms) / 1000);

// Table and column names are the ones read from a real Codex install; columns
// that play no part here are left out.
const createState = (path: string, rolloutDir: string): void => {
  const db = open(path);
  db.exec(`
    CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY);
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE project_roots (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id));
    CREATE TABLE thread_sections (id TEXT PRIMARY KEY);
    CREATE TABLE backfill_state (id INTEGER PRIMARY KEY);
    CREATE TABLE external_agent_config_imports (id INTEGER PRIMARY KEY);
    CREATE TABLE project_idempotency_keys (id INTEGER PRIMARY KEY);
    CREATE TABLE remote_control_enrollments (id INTEGER PRIMARY KEY);
    CREATE TABLE rollout_migration_state (id INTEGER PRIMARY KEY);
    CREATE TABLE rollout_migration_skipped_rollouts (id INTEGER PRIMARY KEY);
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      thread_section_id TEXT REFERENCES thread_sections(id) ON DELETE SET NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL
    );
    CREATE TABLE thread_artifacts (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id));
    CREATE TABLE thread_dynamic_tools (thread_id TEXT NOT NULL REFERENCES threads(id), position INTEGER);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);
    INSERT INTO projects VALUES ('p1');
    INSERT INTO project_roots VALUES ('r1', 'p1');
    INSERT INTO thread_sections VALUES ('s1');
    INSERT INTO backfill_state VALUES (1);
    INSERT INTO rollout_migration_state VALUES (1);
  `);
  const thread = (id: string, file: string, ageMs: number, pinned: number): void => {
    db.run("INSERT INTO threads VALUES (?, ?, ?, ?, ?, 's1', 'p1')", [
      id,
      join(rolloutDir, file),
      ago(ageMs),
      pinned,
      id
    ]);
  };
  thread("old1", "sessions/old1.jsonl", 20 * DAY, 0);
  thread("old2", "archived_sessions/old2.jsonl", 30 * DAY, 0);
  thread("pinned", "sessions/pinned.jsonl", 40 * DAY, 1);
  thread("fresh", "sessions/fresh.jsonl", 2 * DAY, 0);
  db.exec(`
    INSERT INTO thread_artifacts VALUES ('a1', 'old1'), ('a2', 'fresh');
    INSERT INTO thread_dynamic_tools VALUES ('old2', 0), ('pinned', 0);
    INSERT INTO thread_spawn_edges VALUES ('old1', 'fresh', 'open');
  `);
  db.close();
};

const createHistory = (path: string): void => {
  const db = open(path);
  db.exec(`
    CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY);
    CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, item_json TEXT);
    CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, status TEXT);
    CREATE TABLE thread_realtime_items (thread_id TEXT, item_id TEXT);
    CREATE TABLE thread_history_projection_state (thread_id TEXT, next_rollout_ordinal INTEGER);
  `);
  for (const id of ["old1", "old2", "pinned", "fresh"]) {
    db.run("INSERT INTO thread_items VALUES (?, 't', 'i1', '{}')", [id]);
    db.run("INSERT INTO thread_items VALUES (?, 't', 'i2', '{}')", [id]);
    db.run("INSERT INTO thread_turns VALUES (?, 't', 'ok')", [id]);
    db.run("INSERT INTO thread_history_projection_state VALUES (?, 1)", [id]);
  }
  db.exec("INSERT INTO thread_realtime_items VALUES ('old1', 'r'), ('fresh', 'r')");
  db.close();
};

const createLogs = (path: string): void => {
  const db = open(path);
  db.exec(`
    CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY);
    CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, thread_id TEXT, message TEXT);
  `);
  db.run("INSERT INTO logs (ts, thread_id, message) VALUES (?, 'old1', 'a')", [ago(30 * DAY)]);
  db.run("INSERT INTO logs (ts, thread_id, message) VALUES (?, NULL, 'b')", [ago(15 * DAY)]);
  db.run("INSERT INTO logs (ts, thread_id, message) VALUES (?, 'fresh', 'c')", [ago(1 * DAY)]);
  db.close();
};

const INDEX_LINES = [
  JSON.stringify({ id: "old1", thread_name: "one" }),
  JSON.stringify({ id: "old2", thread_name: "two" }),
  JSON.stringify({ id: "pinned", thread_name: "three" }),
  JSON.stringify({ id: "fresh", thread_name: "four" }),
  "not json at all"
];

const seedCodex = async (sandbox: Sandbox): Promise<void> => {
  createState(join(sandbox.codex, "state_5.sqlite"), sandbox.codex);
  createHistory(join(sandbox.codex, "thread_history_1.sqlite"));
  createLogs(join(sandbox.codex, "logs_2.sqlite"));
  await touch(join(sandbox.codex, "sessions", "old1.jsonl"), "aaa", 20 * DAY);
  await touch(join(sandbox.codex, "archived_sessions", "old2.jsonl"), "bb", 30 * DAY);
  await touch(join(sandbox.codex, "sessions", "pinned.jsonl"), "p", 40 * DAY);
  await touch(join(sandbox.codex, "sessions", "fresh.jsonl"), "f", 2 * DAY);
  await touch(join(sandbox.codex, "sessions", "orphan-old.jsonl"), "o", 25 * DAY);
  await touch(join(sandbox.codex, "sessions", "orphan-new.jsonl"), "n", 1 * DAY);
  await writeFile(join(sandbox.codex, "session_index.jsonl"), `${INDEX_LINES.join("\n")}\n`);
  await touch(join(sandbox.codex, "auth.json"), "secret", 90 * DAY);
  await touch(join(sandbox.codex, "config.toml"), "cfg", 90 * DAY);
};

const count = (path: string, table: string, where = ""): number => {
  const db = open(path);
  try {
    return Number(db.all(`SELECT COUNT(*) AS n FROM ${table} ${where}`)[0].n);
  } finally {
    db.close();
  }
};

const snapshotCounts = (sandbox: Sandbox): Record<string, number> => {
  const state = join(sandbox.codex, "state_5.sqlite");
  const history = join(sandbox.codex, "thread_history_1.sqlite");
  const logs = join(sandbox.codex, "logs_2.sqlite");
  return {
    threads: count(state, "threads"),
    artifacts: count(state, "thread_artifacts"),
    tools: count(state, "thread_dynamic_tools"),
    edges: count(state, "thread_spawn_edges"),
    projects: count(state, "projects"),
    sections: count(state, "thread_sections"),
    items: count(history, "thread_items"),
    turns: count(history, "thread_turns"),
    realtime: count(history, "thread_realtime_items"),
    projection: count(history, "thread_history_projection_state"),
    logs: count(logs, "logs")
  };
};

const UNTOUCHED = {
  threads: 4,
  artifacts: 2,
  tools: 2,
  edges: 1,
  projects: 1,
  sections: 1,
  items: 8,
  turns: 4,
  realtime: 2,
  projection: 4,
  logs: 3
};

const names = (paths: string[]): string[] => paths.map((path) => path.split("/").pop() ?? path).sort();

test("codex stats count rollout files by age and fold the databases into the total", async () => {
  const sandbox = await setup();
  try {
    await seedCodex(sandbox);
    const stats = await getHistoryStats("codex", NOW);
    assert.equal(stats.fileCount, 6);
    assert.equal(stats.staleFileCount, 4);
    assert.equal(stats.staleBytes, 3 + 2 + 1 + 1);
    assert.ok(stats.totalBytes > 3 + 2 + 1 + 1 + 1 + 1, "database files are part of the total");
  } finally {
    await cleanup(sandbox);
  }
});

test("codex clean removes only stale, unpinned threads and what belongs to them", async () => {
  const sandbox = await setup();
  try {
    await seedCodex(sandbox);
    const result = await cleanHistory("codex", sandbox.deps);

    assert.equal(result.status, "done");
    assert.equal(result.failed, 0);
    // state: threads 2 + artifacts 1 + tools 1 + edges 1; history: items 4 + turns 2
    // + realtime 1 + projection 2; logs: the two older than two weeks.
    assert.equal(result.dbRowsDeleted, 16);
    assert.deepEqual(snapshotCounts(sandbox), {
      threads: 2,
      artifacts: 1,
      tools: 1,
      edges: 0,
      projects: 1,
      sections: 1,
      items: 4,
      turns: 2,
      realtime: 1,
      projection: 2,
      logs: 1
    });
    const state = join(sandbox.codex, "state_5.sqlite");
    assert.equal(count(state, "threads", "WHERE id IN ('pinned', 'fresh')"), 2);
    assert.equal(count(join(sandbox.codex, "thread_history_1.sqlite"), "thread_items", "WHERE thread_id IN ('old1', 'old2')"), 0);

    // The removed threads' rollouts and the old file nothing points at go to the
    // trash; the pinned thread's very old rollout, the fresh one and a new
    // orphan all stay.
    assert.deepEqual(names(sandbox.trashed), ["old1.jsonl", "old2.jsonl", "orphan-old.jsonl"]);
    assert.equal(result.trashed, 3);

    assert.equal(await readFile(join(sandbox.codex, "auth.json"), "utf-8"), "secret");
    assert.equal(await readFile(join(sandbox.codex, "config.toml"), "utf-8"), "cfg");
  } finally {
    await cleanup(sandbox);
  }
});

test("session_index keeps every line that is not a removed thread, including ones that do not parse", async () => {
  const sandbox = await setup();
  try {
    await seedCodex(sandbox);
    await cleanHistory("codex", sandbox.deps);
    const text = await readFile(join(sandbox.codex, "session_index.jsonl"), "utf-8");
    assert.deepEqual(text.split("\n").filter(Boolean), [INDEX_LINES[2], INDEX_LINES[3], INDEX_LINES[4]]);
  } finally {
    await cleanup(sandbox);
  }
});

test("a file a surviving thread still points at is kept however old it is", async () => {
  const sandbox = await setup();
  try {
    await seedCodex(sandbox);
    // `fresh` keeps using a rollout that has not been written to in a long time.
    await touch(join(sandbox.codex, "sessions", "fresh.jsonl"), "f", 50 * DAY);
    await cleanHistory("codex", sandbox.deps);
    assert.equal(sandbox.trashed.some((path) => path.endsWith("fresh.jsonl")), false);
    assert.equal(sandbox.trashed.some((path) => path.endsWith("pinned.jsonl")), false);
  } finally {
    await cleanup(sandbox);
  }
});

test("databases come out intact: integrity and foreign keys hold", async () => {
  const sandbox = await setup();
  try {
    await seedCodex(sandbox);
    await cleanHistory("codex", sandbox.deps);
    for (const file of ["state_5.sqlite", "thread_history_1.sqlite", "logs_2.sqlite"]) {
      const db = open(join(sandbox.codex, file));
      try {
        assert.deepEqual(Object.values(db.all("PRAGMA integrity_check")[0]), ["ok"]);
        assert.deepEqual(db.all("PRAGMA foreign_key_check"), []);
      } finally {
        db.close();
      }
    }
  } finally {
    await cleanup(sandbox);
  }
});

test("a second clean right after finds nothing left to remove", async () => {
  // A trash that really removes the file, as the OS trash does.
  const sandbox = await setup({ trashItem: (path) => rm(path) });
  try {
    await seedCodex(sandbox);
    await cleanHistory("codex", sandbox.deps);
    const again = await cleanHistory("codex", {
      ...sandbox.deps,
      trashItem: async (path) => {
        sandbox.trashed.push(path);
      }
    });
    assert.equal(again.status, "done");
    assert.equal(again.dbRowsDeleted, 0);
    assert.deepEqual(sandbox.trashed, []);
  } finally {
    await cleanup(sandbox);
  }
});

const assertNothingChanged = async (sandbox: Sandbox): Promise<void> => {
  assert.deepEqual(snapshotCounts(sandbox), UNTOUCHED);
  assert.deepEqual(sandbox.trashed, []);
  assert.equal(await readFile(join(sandbox.codex, "session_index.jsonl"), "utf-8"), `${INDEX_LINES.join("\n")}\n`);
};

test("codex clean refuses while Codex is running and changes nothing", async () => {
  const sandbox = await setup({ isCodexRunning: async () => true });
  try {
    await seedCodex(sandbox);
    const result = await cleanHistory("codex", sandbox.deps);
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "codexRunning");
    await assertNothingChanged(sandbox);
  } finally {
    await cleanup(sandbox);
  }
});

test("codex clean refuses when it cannot tell whether Codex is running", async () => {
  const sandbox = await setup({
    isCodexRunning: async () => {
      throw new Error("ps failed");
    }
  });
  try {
    await seedCodex(sandbox);
    const result = await cleanHistory("codex", sandbox.deps);
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "probeFailed");
    await assertNothingChanged(sandbox);
  } finally {
    await cleanup(sandbox);
  }
});

test("codex clean refuses a database generation it has not verified", async () => {
  const sandbox = await setup();
  try {
    await seedCodex(sandbox);
    createState(join(sandbox.codex, "state_6.sqlite"), sandbox.codex);
    const result = await cleanHistory("codex", sandbox.deps);
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "unsupportedSchema");
    assert.equal(result.detail, "state_6.sqlite");
    await assertNothingChanged(sandbox);
  } finally {
    await cleanup(sandbox);
  }
});

test("codex clean refuses a table it does not know and names it", async () => {
  const sandbox = await setup();
  try {
    await seedCodex(sandbox);
    const db = open(join(sandbox.codex, "thread_history_1.sqlite"));
    db.exec("CREATE TABLE thread_notes (id INTEGER PRIMARY KEY, thread_id TEXT)");
    db.close();
    const result = await cleanHistory("codex", sandbox.deps);
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "unsupportedSchema");
    assert.match(result.detail ?? "", /thread_history_1\.sqlite: \+thread_notes/);
    await assertNothingChanged(sandbox);
  } finally {
    await cleanup(sandbox);
  }
});

test("codex clean refuses when an expected table is gone", async () => {
  const sandbox = await setup();
  try {
    await seedCodex(sandbox);
    const db = open(join(sandbox.codex, "logs_2.sqlite"));
    db.exec("DROP TABLE logs");
    db.close();
    const result = await cleanHistory("codex", sandbox.deps);
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "unsupportedSchema");
    assert.match(result.detail ?? "", /logs_2\.sqlite: -logs/);
    assert.equal(count(join(sandbox.codex, "state_5.sqlite"), "threads"), 4);
    assert.deepEqual(sandbox.trashed, []);
  } finally {
    await cleanup(sandbox);
  }
});

test("codex clean refuses when a column it matches rows on is gone", async () => {
  const sandbox = await setup();
  try {
    await seedCodex(sandbox);
    const db = open(join(sandbox.codex, "thread_history_1.sqlite"));
    db.exec("ALTER TABLE thread_items RENAME COLUMN thread_id TO conversation_id");
    db.close();
    const result = await cleanHistory("codex", sandbox.deps);
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "unsupportedSchema");
    assert.match(result.detail ?? "", /thread_history_1\.sqlite: -thread_items\.thread_id/);
    await assertNothingChanged(sandbox);
  } finally {
    await cleanup(sandbox);
  }
});

test("codex clean refuses a table outside the clean list that points into it", async () => {
  const sandbox = await setup();
  try {
    await seedCodex(sandbox);
    const db = open(join(sandbox.codex, "state_5.sqlite"));
    db.exec("DROP TABLE project_roots");
    db.exec("CREATE TABLE project_roots (id TEXT PRIMARY KEY, thread_id TEXT REFERENCES threads(id))");
    db.close();
    const result = await cleanHistory("codex", sandbox.deps);
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "unsupportedSchema");
    assert.match(result.detail ?? "", /state_5\.sqlite: project_roots/);
    await assertNothingChanged(sandbox);
  } finally {
    await cleanup(sandbox);
  }
});

test("codex clean refuses without a SQLite engine rather than clearing files alone", async () => {
  const sandbox = await setup({ openDatabase: null });
  try {
    await seedCodex(sandbox);
    const result = await cleanHistory("codex", sandbox.deps);
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "noSqlEngine");
    await assertNothingChanged(sandbox);
  } finally {
    await cleanup(sandbox);
  }
});

// Fails the first time a statement touching `needle` is run, like a database
// that turns out to be locked or damaged at the worst moment.
const failingOpener =
  (needle: string): OpenDatabase =>
  (path) => {
    const db: SqlDatabase = open(path);
    return {
      all: (sql, params) => db.all(sql, params),
      exec: (sql) => db.exec(sql),
      close: () => db.close(),
      run: (sql, params) => {
        if (sql.includes(needle)) {
          throw new Error("database is locked");
        }
        return db.run(sql, params);
      }
    };
  };

test("a failure inside a database rolls that database back and leaves every file alone", async () => {
  const sandbox = await setup({ openDatabase: failingOpener('"threads"') });
  try {
    await seedCodex(sandbox);
    const result = await cleanHistory("codex", sandbox.deps);
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "dbFailed");
    assert.equal(result.detail, "state_5.sqlite");
    await assertNothingChanged(sandbox);
  } finally {
    await cleanup(sandbox);
  }
});

test("a later database failing stops before any file is touched", async () => {
  const sandbox = await setup({ openDatabase: failingOpener('"thread_items"') });
  try {
    await seedCodex(sandbox);
    const result = await cleanHistory("codex", sandbox.deps);
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "dbFailed");
    assert.equal(result.detail, "thread_history_1.sqlite");
    // The thread list was cleared first, by design; the history it pointed at is
    // the part left behind. No rollout file and no index line was touched.
    assert.equal(count(join(sandbox.codex, "state_5.sqlite"), "threads"), 2);
    assert.equal(count(join(sandbox.codex, "thread_history_1.sqlite"), "thread_items"), 8);
    assert.equal(count(join(sandbox.codex, "logs_2.sqlite"), "logs"), 3);
    assert.deepEqual(sandbox.trashed, []);
    assert.equal(await readFile(join(sandbox.codex, "session_index.jsonl"), "utf-8"), `${INDEX_LINES.join("\n")}\n`);
  } finally {
    await cleanup(sandbox);
  }
});

test("codex clean with no databases still trashes old rollout files and spares new ones", async () => {
  const sandbox = await setup({ openDatabase: null });
  try {
    await touch(join(sandbox.codex, "sessions", "a", "old.jsonl"), "x", 30 * DAY);
    await touch(join(sandbox.codex, "sessions", "a", "new.jsonl"), "x", 1 * DAY);
    const result = await cleanHistory("codex", sandbox.deps);
    assert.equal(result.status, "done");
    assert.deepEqual(names(sandbox.trashed), ["old.jsonl"]);
    assert.equal(result.dbRowsDeleted, 0);
  } finally {
    await cleanup(sandbox);
  }
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("Codex process detection matches the desktop app and CLI but not bystanders", () => {
  const match = [
    "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/152/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer) --type=renderer",
    "/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server",
    "/Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host",
    "codex exec hello",
    "node /usr/local/lib/node_modules/@openai/codex/bin/codex.js"
  ];
  const noMatch = [
    "/Users/me/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
    "/Applications/ChatGPT.app/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate com.openai.codex /Users/me me",
    "/Users/me/Library/Caches/com.openai.codex/org.sparkle-project.Sparkle/Launcher/x/Updater.app/Contents/MacOS/Updater /Applications/ChatGPT.app 0",
    "/Applications/Claude.app/Contents/MacOS/Claude",
    "vim notes-about-codex.md"
  ];
  for (const line of match) {
    assert.equal(commandLineLooksLikeCodexProcess(line), true, line);
  }
  for (const line of noMatch) {
    assert.equal(commandLineLooksLikeCodexProcess(line), false, line);
  }
});

test("formatBytes uses binary units and drops a useless .0", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5 MB");
  assert.equal(formatBytes(640 * 1024 * 1024), "640 MB");
  assert.equal(formatBytes(1.2 * 1024 * 1024 * 1024), "1.2 GB");
  assert.equal(formatBytes(Number.NaN), "0 B");
});

test("a stats failure is named by what was observed", () => {
  const full = { getHistoryStats: () => undefined, cleanHistory: () => undefined };
  assert.equal(hasHistoryApi(full), true);
  assert.equal(hasHistoryApi({ getHistoryStats: () => undefined }), false);
  assert.equal(hasHistoryApi(undefined), false);

  // Old preload: the bridge method is not there at all.
  assert.deepEqual(classifyHistoryFailure({}, new Error("x")), { key: "history.status.outdatedMain", detail: "" });
  // Old main with a new preload: Electron says no handler is registered.
  assert.equal(
    classifyHistoryFailure(full, new Error("No handler registered for 'history:get-stats'")).key,
    "history.status.outdatedMain"
  );
  // A real failure keeps its message.
  assert.deepEqual(classifyHistoryFailure(full, new Error("EACCES")), { key: "history.status.failed", detail: "EACCES" });
  assert.deepEqual(classifyHistoryFailure(full, undefined), { key: "history.status.failed", detail: "" });
});

test("no history string leaves a placeholder unfilled", async () => {
  const { t } = await import("../src/shared/i18n");
  const params = { count: 3, size: "1 MB", stale: 2, staleSize: "1 MB", trashed: 2, rows: 5, failed: 1, detail: "x.sqlite" };
  const keys = [
    "history.status",
    "history.status.noStale",
    "history.status.failed",
    "history.confirm.claude",
    "history.confirm.codex",
    "history.result.done",
    "history.result.dbRows",
    "history.result.failed",
    "history.blocked.unsupportedSchema",
    "history.blocked.dbFailed"
  ] as const;
  for (const lang of ["zh", "en", "ja", "ko"] as const) {
    for (const key of keys) {
      assert.doesNotMatch(t(lang, key, params), /\{\w+\}/, `${lang} ${key}`);
    }
  }
});
