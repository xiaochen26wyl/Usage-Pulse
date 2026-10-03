import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveClaudeProjectsDir } from "@main/collectors/claude-cli-log";
import { resolveCodexHome } from "@main/credential-provider";
import type { HistoryBlockedReason, HistoryCleanResult, HistoryService, HistoryStats } from "@shared/types";

/**
 * The one place Usage-Pulse deletes anything of an IDE's or CLI's.
 *
 * Everything else under src/main treats those files as read-only; this module
 * exists because the user asked for a "clear old conversation history" button,
 * and it is walled off accordingly (scripts/check-readonly.mjs lists it as the
 * deliberate exception):
 *
 *  - It only runs when the user clicks the button and confirms the dialog that
 *    main shows. Nothing here is reachable from a poll.
 *  - It only removes history older than the retention period, and never a
 *    pinned Codex thread. It touches conversation history and nothing else —
 *    never credentials, settings, projects, or anything under a `memory` folder.
 *  - Files go to the OS trash, not to unlink. The exception is the Codex SQLite
 *    rows, which cannot be trashed; the confirmation text says so.
 *  - Codex fails closed: it refuses while Codex is running, when the database
 *    layout is not exactly the one verified below, or when no SQLite engine is
 *    available. A refusal changes nothing.
 */

export const HISTORY_RETENTION_DAYS = 14;
export const HISTORY_RETENTION_MS = HISTORY_RETENTION_DAYS * 86_400_000;

const CLAUDE_SKIP_DIRS: ReadonlySet<string> = new Set(["memory"]);

interface HistoryFile {
  path: string;
  size: number;
  mtimeMs: number;
}

// Strictly older than the retention period: a file exactly 14 days old is kept,
// and a modification time in the future (clock skew) is never old.
const retentionCutoffMs = (now: number): number => now - HISTORY_RETENTION_MS;
const isStale = (file: HistoryFile, cutoffMs: number): boolean => file.mtimeMs < cutoffMs;

const listJsonl = async (root: string, skipDirs: ReadonlySet<string> = new Set()): Promise<HistoryFile[]> => {
  const files: HistoryFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          await walk(full);
        }
        continue;
      }
      // isFile() is false for symlinks, so a link is never followed or trashed.
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".jsonl")) {
        continue;
      }
      try {
        const info = await stat(full);
        files.push({ path: full, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // Raced with a rotation or unreadable; leave it out.
      }
    }
  };
  await walk(root);
  return files;
};

const listClaudeFiles = (): Promise<HistoryFile[]> => listJsonl(resolveClaudeProjectsDir(), CLAUDE_SKIP_DIRS);

const listCodexFiles = async (): Promise<HistoryFile[]> => {
  const home = resolveCodexHome();
  const [sessions, archived] = await Promise.all([
    listJsonl(join(home, "sessions")),
    listJsonl(join(home, "archived_sessions"))
  ]);
  return [...sessions, ...archived];
};

// ---------------------------------------------------------------------------
// Codex databases
// ---------------------------------------------------------------------------

type CleanStep =
  // Rows belonging to the thread ids being removed, matched on each column.
  | { table: string; by: "thread"; columns: readonly string[] }
  // Rows older than the cutoff, `column` holding epoch seconds.
  | { table: string; by: "time"; column: string };

interface CodexDbPlan {
  prefix: string;
  // The schema generation these tables were verified against. Codex bumps the
  // number in the file name when the layout changes, so a different number is
  // a layout this module has never seen.
  version: number;
  // Applied in this order (children before parents).
  clean: readonly CleanStep[];
  // Present in this layout and deliberately left alone.
  keep: readonly string[];
}

// Order matters: the thread list goes first. If a later database then fails,
// what is left behind is orphaned history rows — invisible — rather than a
// thread in the list with its history gone.
const CODEX_DB_PLANS: readonly CodexDbPlan[] = [
  {
    prefix: "state_",
    version: 5,
    clean: [
      { table: "thread_artifacts", by: "thread", columns: ["thread_id"] },
      { table: "thread_dynamic_tools", by: "thread", columns: ["thread_id"] },
      { table: "thread_spawn_edges", by: "thread", columns: ["parent_thread_id", "child_thread_id"] },
      { table: "threads", by: "thread", columns: ["id"] }
    ],
    keep: [
      "backfill_state",
      "external_agent_config_imports",
      "project_idempotency_keys",
      "project_roots",
      "projects",
      "remote_control_enrollments",
      "rollout_migration_skipped_rollouts",
      "rollout_migration_state",
      "thread_sections"
    ]
  },
  {
    prefix: "thread_history_",
    version: 1,
    clean: [
      { table: "thread_items", by: "thread", columns: ["thread_id"] },
      { table: "thread_turns", by: "thread", columns: ["thread_id"] },
      { table: "thread_realtime_items", by: "thread", columns: ["thread_id"] },
      { table: "thread_history_projection_state", by: "thread", columns: ["thread_id"] }
    ],
    keep: []
  },
  { prefix: "logs_", version: 2, clean: [{ table: "logs", by: "time", column: "ts" }], keep: [] }
];

const MIGRATIONS_TABLE = "_sqlx_migrations";
// SQLite caps bound variables; stay far below any build's limit.
const ID_CHUNK = 500;

export type SqlValue = string | number;

export interface SqlDatabase {
  all(sql: string, params?: SqlValue[]): Array<Record<string, unknown>>;
  // Rows changed.
  run(sql: string, params?: SqlValue[]): number;
  exec(sql: string): void;
  close(): void;
}

export type OpenDatabase = (path: string) => SqlDatabase;

/**
 * SQLite through Node's own `node:sqlite` (Electron 43 ships Node 24). It is
 * fetched with getBuiltinModule rather than imported so the bundler never has
 * to know about it. Returns null where it is missing.
 */
export const createNodeSqliteOpener = (): OpenDatabase | null => {
  let sqlite: typeof import("node:sqlite") | undefined;
  try {
    sqlite = process.getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined;
  } catch {
    sqlite = undefined;
  }
  if (!sqlite?.DatabaseSync) {
    return null;
  }
  const { DatabaseSync } = sqlite;
  return (path) => {
    const db = new DatabaseSync(path);
    try {
      // Another writer holding the file is a "no", but give a momentary lock a moment.
      db.exec("PRAGMA busy_timeout = 3000");
    } catch (error) {
      db.close();
      throw error;
    }
    return {
      all: (sql, params = []) => db.prepare(sql).all(...params) as Array<Record<string, unknown>>,
      run: (sql, params = []) => Number(db.prepare(sql).run(...params).changes),
      exec: (sql) => db.exec(sql),
      close: () => db.close()
    };
  };
};

interface CodexDbTarget {
  plan: CodexDbPlan;
  file: string;
  path: string;
}

class CleanBlocked extends Error {
  constructor(
    readonly reason: HistoryBlockedReason,
    readonly detail?: string
  ) {
    super(reason);
  }
}

const sqliteFileName = (plan: CodexDbPlan): string => `${plan.prefix}${plan.version}.sqlite`;
const cleanedTables = (plan: CodexDbPlan): string[] => plan.clean.map((step) => step.table);
const stepColumns = (step: CleanStep): readonly string[] => (step.by === "thread" ? step.columns : [step.column]);

const findCodexDbTargets = async (home: string): Promise<CodexDbTarget[]> => {
  let names: string[];
  try {
    names = await readdir(home);
  } catch {
    return [];
  }
  const targets: CodexDbTarget[] = [];
  for (const plan of CODEX_DB_PLANS) {
    const pattern = new RegExp(`^${plan.prefix}(\\d+)\\.sqlite$`);
    for (const name of names) {
      const match = pattern.exec(name);
      if (match && Number(match[1]) !== plan.version) {
        throw new CleanBlocked("unsupportedSchema", name);
      }
    }
    const file = sqliteFileName(plan);
    if (names.includes(file)) {
      targets.push({ plan, file, path: join(home, file) });
    }
  }
  return targets;
};

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

// Read-only checks. This is where an unrecognised or unhealthy database turns
// into a refusal, before anything has been changed.
const verifyCodexDb = (db: SqlDatabase, target: CodexDbTarget): void => {
  const { plan, file } = target;
  const cleaned = cleanedTables(plan);
  const tables = db
    .all("SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) != 'sqlite_'")
    .map((row) => String(row.name));

  const known = new Set<string>([...cleaned, ...plan.keep, MIGRATIONS_TABLE]);
  const unknown = tables.filter((name) => !known.has(name));
  const missing = cleaned.filter((name) => !tables.includes(name));
  if (unknown.length > 0 || missing.length > 0) {
    const delta = [...unknown.map((name) => `+${name}`), ...missing.map((name) => `-${name}`)];
    throw new CleanBlocked("unsupportedSchema", `${file}: ${delta.join(", ")}`);
  }

  // Rows are matched on these columns, so each has to exist: a renamed column
  // would otherwise turn "delete this thread's rows" into an error — or worse.
  const absent: string[] = [];
  for (const step of plan.clean) {
    const columns = db.all(`SELECT name FROM pragma_table_info('${step.table}')`).map((row) => String(row.name));
    for (const column of stepColumns(step)) {
      if (!columns.includes(column)) {
        absent.push(`${step.table}.${column}`);
      }
    }
  }
  if (absent.length > 0) {
    throw new CleanBlocked("unsupportedSchema", `${file}: -${absent.join(", -")}`);
  }

  // A table outside the clean list that points at one inside it would be left
  // holding dangling references.
  const cleanSet = new Set(cleaned);
  const dangling = db
    .all(
      "SELECT m.name AS child, f.\"table\" AS parent FROM sqlite_master m, pragma_foreign_key_list(m.name) f WHERE m.type = 'table'"
    )
    .filter((row) => cleanSet.has(String(row.parent)) && !cleanSet.has(String(row.child)));
  if (dangling.length > 0) {
    throw new CleanBlocked("unsupportedSchema", `${file}: ${dangling.map((row) => String(row.child)).join(", ")}`);
  }

  const check = db.all("PRAGMA quick_check").map((row) => String(Object.values(row)[0]));
  if (check.length !== 1 || check[0] !== "ok") {
    throw new CleanBlocked("dbFailed", file);
  }
};

interface CodexThreads {
  // Older than the retention period and not pinned.
  staleIds: string[];
  // Rollout files those threads wrote.
  stalePaths: Set<string>;
  // Rollout files any surviving thread still points at.
  keptPaths: Set<string>;
}

const readCodexThreads = (db: SqlDatabase, cutoffSeconds: number): CodexThreads => {
  const result: CodexThreads = { staleIds: [], stalePaths: new Set(), keptPaths: new Set() };
  for (const row of db.all("SELECT id, rollout_path, updated_at, is_pinned FROM threads")) {
    const path = typeof row.rollout_path === "string" && row.rollout_path ? resolve(row.rollout_path) : null;
    const stale = Number(row.updated_at) < cutoffSeconds && Number(row.is_pinned) === 0;
    if (stale) {
      result.staleIds.push(String(row.id));
      if (path) {
        result.stalePaths.add(path);
      }
    } else if (path) {
      result.keptPaths.add(path);
    }
  }
  return result;
};

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

const clearTables = (db: SqlDatabase, plan: CodexDbPlan, ids: readonly string[], cutoffSeconds: number): number => {
  const hasWork = plan.clean.some((step) => step.by === "time" || ids.length > 0);
  if (!hasWork) {
    return 0;
  }
  let rows = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const step of plan.clean) {
      if (step.by === "time") {
        rows += db.run(`DELETE FROM ${quote(step.table)} WHERE ${quote(step.column)} < ?`, [cutoffSeconds]);
        continue;
      }
      for (const column of step.columns) {
        for (const batch of chunks(ids, ID_CHUNK)) {
          const marks = batch.map(() => "?").join(", ");
          rows += db.run(`DELETE FROM ${quote(step.table)} WHERE ${quote(column)} IN (${marks})`, batch);
        }
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back by SQLite.
    }
    throw error;
  }
  return rows;
};

// Drops the removed threads' lines from Codex's thread index and leaves every
// other line — including ones that do not parse — exactly as they were. The new
// file is written beside the old one and swapped in, so a crash never leaves a
// half-written index.
const pruneSessionIndex = async (home: string, removedIds: ReadonlySet<string>): Promise<boolean> => {
  if (removedIds.size === 0) {
    return true;
  }
  const index = join(home, "session_index.jsonl");
  let text: string;
  try {
    text = await readFile(index, "utf-8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  const lines = text.split("\n");
  const kept = lines.filter((line) => {
    if (!line.trim()) {
      return true;
    }
    try {
      const id = (JSON.parse(line) as { id?: unknown }).id;
      return !(typeof id === "string" && removedIds.has(id));
    } catch {
      return true;
    }
  });
  if (kept.length === lines.length) {
    return true;
  }
  const temp = `${index}.usage-pulse-tmp`;
  try {
    await writeFile(temp, kept.join("\n"));
    await rename(temp, index);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface HistoryCleanerDeps {
  trashItem: (path: string) => Promise<void>;
  isCodexRunning: () => Promise<boolean>;
  // null: no SQLite engine in this environment.
  openDatabase: OpenDatabase | null;
  now?: () => number;
}

const sum = (files: HistoryFile[]): number => files.reduce((total, file) => total + file.size, 0);

const codexDbBytes = async (home: string): Promise<number> => {
  let total = 0;
  for (const plan of CODEX_DB_PLANS) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        total += (await stat(join(home, `${sqliteFileName(plan)}${suffix}`))).size;
      } catch {
        // Not there.
      }
    }
  }
  return total;
};

const summarize = (files: HistoryFile[], now: number, extraBytes = 0): HistoryStats => {
  const stale = files.filter((file) => isStale(file, retentionCutoffMs(now)));
  return {
    fileCount: files.length,
    totalBytes: sum(files) + extraBytes,
    staleFileCount: stale.length,
    staleBytes: sum(stale)
  };
};

/**
 * What is there, and how much of it is past the retention period. Stats only;
 * no file is opened. Codex's size includes its databases, which cannot be split
 * by age, so `staleBytes` counts conversation files alone.
 */
export const getHistoryStats = async (service: HistoryService, now: number = Date.now()): Promise<HistoryStats> => {
  if (service === "claude") {
    return summarize(await listClaudeFiles(), now);
  }
  return summarize(await listCodexFiles(), now, await codexDbBytes(resolveCodexHome()));
};

const emptyResult = (service: HistoryService): HistoryCleanResult => ({
  service,
  status: "done",
  trashed: 0,
  failed: 0,
  dbRowsDeleted: 0
});

const blocked = (
  service: HistoryService,
  reason: HistoryBlockedReason,
  detail?: string,
  progress: Partial<HistoryCleanResult> = {}
): HistoryCleanResult => ({ ...emptyResult(service), ...progress, status: "blocked", reason, detail });

const trashAll = async (
  files: HistoryFile[],
  trashItem: (path: string) => Promise<void>
): Promise<{ trashed: number; failed: number }> => {
  let trashed = 0;
  let failed = 0;
  for (const file of files) {
    try {
      await trashItem(file.path);
      trashed += 1;
    } catch {
      failed += 1;
    }
  }
  return { trashed, failed };
};

const cleanClaude = async (deps: HistoryCleanerDeps): Promise<HistoryCleanResult> => {
  const cutoff = retentionCutoffMs((deps.now ?? Date.now)());
  const stale = (await listClaudeFiles()).filter((file) => isStale(file, cutoff));
  const { trashed, failed } = await trashAll(stale, deps.trashItem);
  return { ...emptyResult("claude"), trashed, failed };
};

const cleanCodex = async (deps: HistoryCleanerDeps): Promise<HistoryCleanResult> => {
  let running: boolean;
  try {
    running = await deps.isCodexRunning();
  } catch {
    return blocked("codex", "probeFailed");
  }
  if (running) {
    return blocked("codex", "codexRunning");
  }

  const now = (deps.now ?? Date.now)();
  const cutoff = retentionCutoffMs(now);
  const cutoffSeconds = Math.floor(cutoff / 1000);
  const home = resolveCodexHome();
  const handles: SqlDatabase[] = [];
  let dbRowsDeleted = 0;
  let threads: CodexThreads = { staleIds: [], stalePaths: new Set(), keptPaths: new Set() };
  try {
    const targets = await findCodexDbTargets(home);
    if (targets.length > 0) {
      if (!deps.openDatabase) {
        return blocked("codex", "noSqlEngine");
      }

      // Everything is opened and verified before the first row is touched, so
      // a refusal never leaves a half-cleaned set behind.
      const opened: Array<{ target: CodexDbTarget; db: SqlDatabase }> = [];
      for (const target of targets) {
        let db: SqlDatabase;
        try {
          db = deps.openDatabase(target.path);
        } catch {
          throw new CleanBlocked("dbFailed", target.file);
        }
        handles.push(db);
        opened.push({ target, db });
        verifyCodexDb(db, target);
      }

      const state = opened.find(({ target }) => target.plan.prefix === "state_");
      if (state) {
        try {
          threads = readCodexThreads(state.db, cutoffSeconds);
        } catch {
          throw new CleanBlocked("dbFailed", state.target.file);
        }
      }

      for (const { target, db } of opened) {
        try {
          dbRowsDeleted += clearTables(db, target.plan, threads.staleIds, cutoffSeconds);
        } catch {
          throw new CleanBlocked("dbFailed", target.file);
        }
        try {
          // Without these the file keeps its size and the rows' bytes with it.
          db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          db.exec("VACUUM");
        } catch {
          // The rows are gone; only the disk space is not given back.
        }
      }
    }
  } catch (error) {
    if (error instanceof CleanBlocked) {
      return blocked("codex", error.reason, error.detail, { dbRowsDeleted });
    }
    throw error;
  } finally {
    for (const db of handles) {
      try {
        db.close();
      } catch {
        // Nothing useful to do.
      }
    }
  }

  // Only now, with the databases cleared, do the files that backed them go: the
  // removed threads' own rollouts, plus old files no thread points at. A file a
  // surviving thread still uses stays, however old it is.
  const files = await listCodexFiles();
  const doomed = files.filter((file) => {
    const path = resolve(file.path);
    if (threads.keptPaths.has(path)) {
      return false;
    }
    return threads.stalePaths.has(path) || isStale(file, cutoff);
  });
  const { trashed, failed } = await trashAll(doomed, deps.trashItem);
  const indexOk = await pruneSessionIndex(home, new Set(threads.staleIds));
  return { ...emptyResult("codex"), trashed, failed: failed + (indexOk ? 0 : 1), dbRowsDeleted };
};

export const cleanHistory = (service: HistoryService, deps: HistoryCleanerDeps): Promise<HistoryCleanResult> =>
  service === "claude" ? cleanClaude(deps) : cleanCodex(deps);
