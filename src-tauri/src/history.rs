// The one place Usage-Pulse deletes anything of an IDE's or CLI's. A port of
// src/main/history-cleaner.ts and the confirmation flow in src/main/index.ts.
//
// Everything else in this crate treats those files as read-only; this module
// exists for the "clear old conversation history" button, and is walled off:
//
//  - It only runs when the user clicks the button and confirms the native dialog
//    shown here. Nothing in this file is reachable from a poll.
//  - It only removes history older than the retention period, and never a pinned
//    Codex thread. Credentials, settings, projects and anything under a `memory`
//    folder are never touched.
//  - Files go to the OS trash, not unlink. The exception is the Codex SQLite
//    rows, which cannot be trashed; the confirmation text says so.
//  - Codex fails closed: it refuses while Codex is running (unless the user
//    answers a second, explicit warning), when the database layout is not
//    exactly the one verified below, or when a database cannot be opened. A
//    refusal changes nothing.
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, params_from_iter, types::Value as SqlValue};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::{i18n, ide_presence, settings::SettingsState};

const RETENTION_DAYS: u64 = 14;
const RETENTION_MS: i64 = (RETENTION_DAYS * 86_400_000) as i64;
const CLAUDE_SKIP_DIRS: [&str; 1] = ["memory"];
const MIGRATIONS_TABLE: &str = "_sqlx_migrations";
// SQLite caps bound variables; stay far below any build's limit.
const ID_CHUNK: usize = 500;

static CLEANING: AtomicBool = AtomicBool::new(false);

struct HistoryFile {
    path: PathBuf,
    size: u64,
    mtime_ms: i64,
}

// Strictly older than the retention period: a file exactly 14 days old is kept,
// and a modification time in the future (clock skew) is never old.
fn cutoff_ms(now: i64) -> i64 {
    now - RETENTION_MS
}

fn is_stale(file: &HistoryFile, cutoff: i64) -> bool {
    file.mtime_ms < cutoff
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as i64)
}

fn claude_projects_dir() -> Option<PathBuf> {
    match std::env::var("CLAUDE_CONFIG_DIR") {
        Ok(custom) if !custom.trim().is_empty() => Some(PathBuf::from(custom.trim()).join("projects")),
        _ => crate::credentials::home_dir().map(|home| home.join(".claude").join("projects")),
    }
}

fn codex_home() -> Option<PathBuf> {
    match std::env::var("CODEX_HOME") {
        Ok(custom) if !custom.trim().is_empty() => Some(PathBuf::from(custom.trim())),
        _ => crate::credentials::home_dir().map(|home| home.join(".codex")),
    }
}

fn list_jsonl(root: &Path, skip_dirs: &[&str]) -> Vec<HistoryFile> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !skip_dirs.contains(&name.as_str()) {
                    pending.push(path);
                }
                continue;
            }
            // is_file() is false for symlinks, so a link is never followed or trashed.
            if !kind.is_file() || !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl")) {
                continue;
            }
            let Ok(info) = entry.metadata() else { continue };
            let mtime_ms = info
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |elapsed| elapsed.as_millis() as i64);
            files.push(HistoryFile { path, size: info.len(), mtime_ms });
        }
    }
    files
}

fn list_claude_files() -> Vec<HistoryFile> {
    claude_projects_dir().map_or_else(Vec::new, |root| list_jsonl(&root, &CLAUDE_SKIP_DIRS))
}

fn list_codex_files() -> Vec<HistoryFile> {
    let Some(home) = codex_home() else { return Vec::new() };
    let mut files = list_jsonl(&home.join("sessions"), &[]);
    files.extend(list_jsonl(&home.join("archived_sessions"), &[]));
    files
}

// ---------------------------------------------------------------------------
// Codex databases
// ---------------------------------------------------------------------------

enum By {
    // Rows belonging to the thread ids being removed, matched on each column.
    Thread(&'static [&'static str]),
    // Rows older than the cutoff, the column holding epoch seconds.
    Time(&'static str),
}

struct Step {
    table: &'static str,
    by: By,
}

struct Plan {
    prefix: &'static str,
    // The schema generation these tables were verified against. Codex bumps the
    // number in the file name when the layout changes, so a different number is
    // a layout this module has never seen.
    version: u32,
    // Applied in this order (children before parents).
    clean: &'static [Step],
    // Present in this layout and deliberately left alone.
    keep: &'static [&'static str],
}

// Order matters: the thread list goes first. If a later database then fails,
// what is left behind is orphaned history rows — invisible — rather than a
// thread in the list with its history gone.
const PLANS: [Plan; 3] = [
    Plan {
        prefix: "state_",
        version: 5,
        clean: &[
            Step { table: "thread_attachments", by: By::Thread(&["thread_id"]) },
            Step { table: "thread_dynamic_tools", by: By::Thread(&["thread_id"]) },
            Step { table: "thread_spawn_edges", by: By::Thread(&["parent_thread_id", "child_thread_id"]) },
            Step { table: "threads", by: By::Thread(&["id"]) },
        ],
        keep: &[
            "backfill_state",
            "external_agent_config_imports",
            "project_idempotency_keys",
            "project_roots",
            "projects",
            "remote_control_enrollments",
            "rollout_migration_skipped_rollouts",
            "rollout_migration_state",
            "thread_sections",
        ],
    },
    Plan {
        prefix: "thread_history_",
        version: 1,
        clean: &[
            Step { table: "thread_items", by: By::Thread(&["thread_id"]) },
            Step { table: "thread_turns", by: By::Thread(&["thread_id"]) },
            Step { table: "thread_realtime_items", by: By::Thread(&["thread_id"]) },
            Step { table: "thread_history_projection_state", by: By::Thread(&["thread_id"]) },
        ],
        keep: &[],
    },
    Plan { prefix: "logs_", version: 2, clean: &[Step { table: "logs", by: By::Time("ts") }], keep: &[] },
];

impl Plan {
    fn file_name(&self) -> String {
        format!("{}{}.sqlite", self.prefix, self.version)
    }

    fn cleaned_tables(&self) -> Vec<&'static str> {
        self.clean.iter().map(|step| step.table).collect()
    }
}

impl Step {
    fn columns(&self) -> Vec<&'static str> {
        match self.by {
            By::Thread(columns) => columns.to_vec(),
            By::Time(column) => vec![column],
        }
    }
}

struct Blocked {
    reason: &'static str,
    detail: Option<String>,
}

fn blocked(reason: &'static str, detail: impl Into<String>) -> Blocked {
    Blocked { reason, detail: Some(detail.into()) }
}

struct Target {
    plan: &'static Plan,
    file: String,
    path: PathBuf,
}

// Which database files exist. A file of a known family under a version this
// module has not verified is a refusal, not something to skip.
fn find_targets(home: &Path) -> Result<Vec<Target>, Blocked> {
    let names: Vec<String> = match fs::read_dir(home) {
        Ok(entries) => entries.flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect(),
        Err(_) => return Ok(Vec::new()),
    };
    let mut targets = Vec::new();
    for plan in &PLANS {
        for name in &names {
            let version = name
                .strip_prefix(plan.prefix)
                .and_then(|rest| rest.strip_suffix(".sqlite"))
                .filter(|digits| !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()));
            if version.is_some_and(|digits| digits.parse::<u32>().ok() != Some(plan.version)) {
                return Err(blocked("unsupportedSchema", name.clone()));
            }
        }
        let file = plan.file_name();
        if names.contains(&file) {
            targets.push(Target { plan, path: home.join(&file), file });
        }
    }
    Ok(targets)
}

fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn open_database(path: &Path) -> rusqlite::Result<Connection> {
    let connection = Connection::open(path)?;
    // Another writer holding the file is a "no", but give a momentary lock a moment.
    connection.busy_timeout(Duration::from_secs(3))?;
    Ok(connection)
}

fn strings(connection: &Connection, sql: &str) -> rusqlite::Result<Vec<String>> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect()
}

// Read-only checks. This is where an unrecognised or unhealthy database turns
// into a refusal, before anything has been changed.
fn verify(connection: &Connection, target: &Target) -> Result<(), Blocked> {
    let (plan, file) = (target.plan, &target.file);
    let db_failed = |_| blocked("dbFailed", file.clone());
    let cleaned = plan.cleaned_tables();
    let tables = strings(
        connection,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) != 'sqlite_'",
    )
    .map_err(db_failed)?;

    let known: HashSet<&str> = cleaned.iter().copied().chain(plan.keep.iter().copied()).chain([MIGRATIONS_TABLE]).collect();
    let unknown: Vec<&String> = tables.iter().filter(|name| !known.contains(name.as_str())).collect();
    let missing: Vec<&&str> = cleaned.iter().filter(|name| !tables.iter().any(|table| table == **name)).collect();
    if !unknown.is_empty() || !missing.is_empty() {
        let delta: Vec<String> = unknown
            .iter()
            .map(|name| format!("+{name}"))
            .chain(missing.iter().map(|name| format!("-{name}")))
            .collect();
        return Err(blocked("unsupportedSchema", format!("{file}: {}", delta.join(", "))));
    }

    // Rows are matched on these columns, so each has to exist: a renamed column
    // would otherwise turn "delete this thread's rows" into an error — or worse.
    let mut absent = Vec::new();
    for step in plan.clean {
        let columns = strings(connection, &format!("SELECT name FROM pragma_table_info('{}')", step.table)).map_err(db_failed)?;
        for column in step.columns() {
            if !columns.iter().any(|name| name == column) {
                absent.push(format!("{}.{column}", step.table));
            }
        }
    }
    if !absent.is_empty() {
        return Err(blocked("unsupportedSchema", format!("{file}: -{}", absent.join(", -"))));
    }

    // A table outside the clean list that points at one inside it would be left
    // holding dangling references.
    let clean_set: HashSet<&str> = cleaned.iter().copied().collect();
    let mut statement = connection
        .prepare(
            "SELECT m.name AS child, f.\"table\" AS parent FROM sqlite_master m, pragma_foreign_key_list(m.name) f WHERE m.type = 'table'",
        )
        .map_err(db_failed)?;
    let pairs: Vec<(String, String)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(db_failed)?
        .flatten()
        .collect();
    let dangling: Vec<&str> = pairs
        .iter()
        .filter(|(child, parent)| clean_set.contains(parent.as_str()) && !clean_set.contains(child.as_str()))
        .map(|(child, _)| child.as_str())
        .collect();
    if !dangling.is_empty() {
        return Err(blocked("unsupportedSchema", format!("{file}: {}", dangling.join(", "))));
    }

    let check = strings(connection, "PRAGMA quick_check").map_err(db_failed)?;
    if check.len() != 1 || check[0] != "ok" {
        return Err(blocked("dbFailed", file.clone()));
    }
    Ok(())
}

#[derive(Default)]
struct Threads {
    // Older than the retention period and not pinned.
    stale_ids: Vec<String>,
    // Rollout files those threads wrote.
    stale_paths: HashSet<PathBuf>,
    // Rollout files any surviving thread still points at.
    kept_paths: HashSet<PathBuf>,
}

fn as_number(value: &SqlValue) -> f64 {
    match value {
        SqlValue::Integer(number) => *number as f64,
        SqlValue::Real(number) => *number,
        SqlValue::Text(text) => text.parse().unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

fn as_text(value: &SqlValue) -> Option<String> {
    match value {
        SqlValue::Text(text) if !text.is_empty() => Some(text.clone()),
        SqlValue::Integer(number) => Some(number.to_string()),
        _ => None,
    }
}

fn read_threads(connection: &Connection, cutoff_seconds: i64) -> rusqlite::Result<Threads> {
    let mut threads = Threads::default();
    let mut statement = connection.prepare("SELECT id, rollout_path, updated_at, is_pinned FROM threads")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, SqlValue>(0)?,
            row.get::<_, SqlValue>(1)?,
            row.get::<_, SqlValue>(2)?,
            row.get::<_, SqlValue>(3)?,
        ))
    })?;
    for row in rows {
        let (id, rollout, updated_at, pinned) = row?;
        let path = as_text(&rollout).map(PathBuf::from);
        let stale = as_number(&updated_at) < cutoff_seconds as f64 && as_number(&pinned) == 0.0;
        if stale {
            if let Some(id) = as_text(&id) {
                threads.stale_ids.push(id);
            }
            if let Some(path) = path {
                threads.stale_paths.insert(path);
            }
        } else if let Some(path) = path {
            threads.kept_paths.insert(path);
        }
    }
    Ok(threads)
}

fn clear_tables(connection: &Connection, plan: &Plan, ids: &[String], cutoff_seconds: i64) -> rusqlite::Result<usize> {
    let has_work = plan.clean.iter().any(|step| matches!(step.by, By::Time(_)) || !ids.is_empty());
    if !has_work {
        return Ok(0);
    }
    let mut rows = 0;
    connection.execute_batch("BEGIN IMMEDIATE")?;
    let outcome = (|| -> rusqlite::Result<()> {
        for step in plan.clean {
            match step.by {
                By::Time(column) => {
                    rows += connection.execute(
                        &format!("DELETE FROM {} WHERE {} < ?1", quote(step.table), quote(column)),
                        [cutoff_seconds],
                    )?;
                }
                By::Thread(columns) => {
                    for column in columns {
                        for batch in ids.chunks(ID_CHUNK) {
                            let marks = vec!["?"; batch.len()].join(", ");
                            rows += connection.execute(
                                &format!("DELETE FROM {} WHERE {} IN ({marks})", quote(step.table), quote(column)),
                                params_from_iter(batch.iter()),
                            )?;
                        }
                    }
                }
            }
        }
        Ok(())
    })();
    match outcome {
        Ok(()) => connection.execute_batch("COMMIT")?,
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            return Err(error);
        }
    }
    Ok(rows)
}

// Everything is opened and verified before the first row is touched, so a
// refusal never leaves a half-cleaned set behind.
fn clean_databases(home: &Path, cutoff_seconds: i64) -> Result<(Threads, usize), Blocked> {
    let targets = find_targets(home)?;
    let mut opened = Vec::new();
    for target in targets {
        let connection = open_database(&target.path).map_err(|_| blocked("dbFailed", target.file.clone()))?;
        verify(&connection, &target)?;
        opened.push((target, connection));
    }

    let mut threads = Threads::default();
    if let Some((target, connection)) = opened.iter().find(|(target, _)| target.plan.prefix == "state_") {
        threads = read_threads(connection, cutoff_seconds).map_err(|_| blocked("dbFailed", target.file.clone()))?;
    }

    let mut deleted = 0;
    for (target, connection) in &opened {
        deleted += clear_tables(connection, target.plan, &threads.stale_ids, cutoff_seconds)
            .map_err(|_| blocked("dbFailed", target.file.clone()))?;
        // Without these the file keeps its size and the rows' bytes with it. The
        // rows are gone either way; only the disk space is not given back on failure.
        let _ = connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
        let _ = connection.execute_batch("VACUUM");
    }
    Ok((threads, deleted))
}

// Drops the removed threads' lines from Codex's thread index and leaves every
// other line — including ones that do not parse — exactly as they were. The new
// file is written beside the old one and swapped in, so a crash never leaves a
// half-written index.
fn prune_session_index(home: &Path, removed: &HashSet<String>) -> bool {
    if removed.is_empty() {
        return true;
    }
    let index = home.join("session_index.jsonl");
    let text = match fs::read_to_string(&index) {
        Ok(text) => text,
        Err(error) => return error.kind() == std::io::ErrorKind::NotFound,
    };
    let lines: Vec<&str> = text.split('\n').collect();
    let kept: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|line| {
            if line.trim().is_empty() {
                return true;
            }
            match serde_json::from_str::<Value>(line) {
                Ok(parsed) => !parsed.get("id").and_then(Value::as_str).is_some_and(|id| removed.contains(id)),
                Err(_) => true,
            }
        })
        .collect();
    if kept.len() == lines.len() {
        return true;
    }
    let temp = home.join("session_index.jsonl.usage-pulse-tmp");
    fs::write(&temp, kept.join("\n")).is_ok() && fs::rename(&temp, &index).is_ok()
}

// ---------------------------------------------------------------------------
// Stats and cleaning
// ---------------------------------------------------------------------------

pub fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    if bytes == 0 {
        return "0 B".to_string();
    }
    let (mut value, mut unit) = (bytes as f64, 0);
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    let text = if value >= 100.0 || unit == 0 {
        format!("{}", value.round() as u64)
    } else {
        format!("{value:.1}").trim_end_matches(".0").to_string()
    };
    format!("{text} {}", UNITS[unit])
}

fn codex_db_bytes(home: &Path) -> u64 {
    PLANS
        .iter()
        .flat_map(|plan| ["", "-wal", "-shm"].map(|suffix| home.join(format!("{}{suffix}", plan.file_name()))))
        .filter_map(|path| fs::metadata(path).ok())
        .map(|info| info.len())
        .sum()
}

struct Stats {
    file_count: usize,
    total_bytes: u64,
    stale_file_count: usize,
    stale_bytes: u64,
}

fn summarize(files: &[HistoryFile], now: i64, extra_bytes: u64) -> Stats {
    let cutoff = cutoff_ms(now);
    let stale: Vec<&HistoryFile> = files.iter().filter(|file| is_stale(file, cutoff)).collect();
    Stats {
        file_count: files.len(),
        total_bytes: files.iter().map(|file| file.size).sum::<u64>() + extra_bytes,
        stale_file_count: stale.len(),
        stale_bytes: stale.iter().map(|file| file.size).sum(),
    }
}

fn stats(service: &str) -> Stats {
    if service == "claude" {
        return summarize(&list_claude_files(), now_ms(), 0);
    }
    let extra = codex_home().map_or(0, |home| codex_db_bytes(&home));
    summarize(&list_codex_files(), now_ms(), extra)
}

fn stats_json(stats: &Stats) -> Value {
    json!({
        "fileCount": stats.file_count,
        "totalBytes": stats.total_bytes,
        "staleFileCount": stats.stale_file_count,
        "staleBytes": stats.stale_bytes,
    })
}

// What is there, and how much of it is past the retention period. Stats only; no
// file is opened. Codex's size includes its databases, which cannot be split by
// age, so `staleBytes` counts conversation files alone.
pub async fn get_stats() -> Value {
    tauri::async_runtime::spawn_blocking(|| json!({ "claude": stats_json(&stats("claude")), "codex": stats_json(&stats("codex")) }))
        .await
        .unwrap_or_else(|_| json!({}))
}

fn result(service: &str, status: &str, trashed: usize, failed: usize, db_rows: usize) -> Value {
    json!({ "service": service, "status": status, "trashed": trashed, "failed": failed, "dbRowsDeleted": db_rows })
}

fn refusal(service: &str, reason: &str, detail: Option<String>, db_rows: usize) -> Value {
    let mut value = result(service, "blocked", 0, 0, db_rows);
    value["reason"] = json!(reason);
    if let Some(detail) = detail {
        value["detail"] = json!(detail);
    }
    value
}

fn trash_all(files: &[&HistoryFile]) -> (usize, usize) {
    let mut trashed = 0;
    for file in files {
        if trash::delete(&file.path).is_ok() {
            trashed += 1;
        }
    }
    (trashed, files.len() - trashed)
}

// The confirmation lives here, not in the renderer, so no caller can skip it.
async fn confirm(app: &AppHandle, title: String, message: String, ok: String, cancel: String) -> bool {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title(title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(ok, cancel))
            .blocking_show()
    })
    .await
    .unwrap_or(false)
}

async fn confirm_clean(app: &AppHandle, language: &str, service: &str, stats: &Stats) -> bool {
    let key = if service == "claude" { "history.confirm.claude" } else { "history.confirm.codex" };
    let message = i18n::fill(
        i18n::tr(language, key),
        &[("count", &stats.stale_file_count.to_string()), ("size", &format_bytes(stats.stale_bytes))],
    );
    confirm(
        app,
        i18n::tr(language, "history.confirm.title").to_string(),
        message,
        i18n::tr(language, "history.confirm.ok").to_string(),
        i18n::tr(language, "history.confirm.cancel").to_string(),
    )
    .await
}

// Second, separate warning: the first dialog said what will be removed, this one
// says the app that owns the files is open.
async fn confirm_while_codex_runs(app: &AppHandle, language: &str) -> bool {
    confirm(
        app,
        i18n::tr(language, "history.runningWarn.title").to_string(),
        i18n::tr(language, "history.runningWarn.message").to_string(),
        i18n::tr(language, "history.runningWarn.ok").to_string(),
        i18n::tr(language, "history.runningWarn.cancel").to_string(),
    )
    .await
}

async fn clean_claude() -> Value {
    tauri::async_runtime::spawn_blocking(|| {
        let cutoff = cutoff_ms(now_ms());
        let files = list_claude_files();
        let stale: Vec<&HistoryFile> = files.iter().filter(|file| is_stale(file, cutoff)).collect();
        let (trashed, failed) = trash_all(&stale);
        result("claude", "done", trashed, failed, 0)
    })
    .await
    .unwrap_or_else(|_| refusal("claude", "dbFailed", None, 0))
}

async fn clean_codex(app: &AppHandle, language: &str) -> Value {
    match ide_presence::probe_codex_running().await {
        Err(_) => return refusal("codex", "probeFailed", None, 0),
        Ok(true) if !confirm_while_codex_runs(app, language).await => return result("codex", "cancelled", 0, 0, 0),
        Ok(_) => {}
    }
    tauri::async_runtime::spawn_blocking(|| {
        let Some(home) = codex_home() else { return result("codex", "done", 0, 0, 0) };
        let now = now_ms();
        let cutoff = cutoff_ms(now);
        let (threads, db_rows) = match clean_databases(&home, cutoff.div_euclid(1000)) {
            Ok(done) => done,
            Err(Blocked { reason, detail }) => return refusal("codex", reason, detail, 0),
        };

        // Only now, with the databases cleared, do the files that backed them go:
        // the removed threads' own rollouts, plus old files no thread points at. A
        // file a surviving thread still uses stays, however old it is.
        let files = list_codex_files();
        let doomed: Vec<&HistoryFile> = files
            .iter()
            .filter(|file| {
                if threads.kept_paths.contains(&file.path) {
                    return false;
                }
                threads.stale_paths.contains(&file.path) || is_stale(file, cutoff)
            })
            .collect();
        let (trashed, failed) = trash_all(&doomed);
        let removed: HashSet<String> = threads.stale_ids.iter().cloned().collect();
        let index_failed = usize::from(!prune_session_index(&home, &removed));
        result("codex", "done", trashed, failed + index_failed, db_rows)
    })
    .await
    .unwrap_or_else(|_| refusal("codex", "dbFailed", None, 0))
}

// history:clean. `service` has already been checked to be "claude" or "codex".
pub async fn clean(app: &AppHandle, service: &str) -> Value {
    if CLEANING.swap(true, Ordering::SeqCst) {
        return refusal(service, "busy", None, 0);
    }
    let outcome = async {
        let language = app.state::<SettingsState>().language();
        let current = {
            let service = service.to_string();
            tauri::async_runtime::spawn_blocking(move || stats(&service)).await.ok()
        };
        let Some(current) = current else { return result(service, "done", 0, 0, 0) };
        if current.stale_file_count == 0 {
            // Nothing older than the retention period: no dialog for a no-op.
            return result(service, "done", 0, 0, 0);
        }
        if !confirm_clean(app, &language, service, &current).await {
            return result(service, "cancelled", 0, 0, 0);
        }
        if service == "claude" { clean_claude().await } else { clean_codex(app, &language).await }
    }
    .await;
    CLEANING.store(false, Ordering::SeqCst);
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("usage-pulse-history-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn state_database(home: &Path, extra_table: bool) -> Connection {
        let connection = Connection::open(home.join("state_5.sqlite")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, updated_at INTEGER, is_pinned INTEGER);
                 CREATE TABLE thread_attachments (thread_id TEXT);
                 CREATE TABLE thread_dynamic_tools (thread_id TEXT);
                 CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
                 INSERT INTO threads VALUES ('old', '/r/old.jsonl', 100, 0), ('pinned', '/r/pinned.jsonl', 100, 1), ('new', '/r/new.jsonl', 9000, 0);
                 INSERT INTO thread_attachments VALUES ('old'), ('new');",
            )
            .unwrap();
        if extra_table {
            connection.execute_batch("CREATE TABLE surprise (x)").unwrap();
        }
        connection
    }

    #[test]
    fn removes_only_stale_unpinned_threads() {
        let home = temp_home("clean");
        drop(state_database(&home, false));
        let (threads, deleted) = clean_databases(&home, 5000).ok().expect("clean succeeds");
        assert_eq!(threads.stale_ids, vec!["old".to_string()]);
        assert!(threads.kept_paths.contains(Path::new("/r/pinned.jsonl")));
        assert_eq!(deleted, 2); // the thread and its attachment row
        let connection = Connection::open(home.join("state_5.sqlite")).unwrap();
        let left: i64 = connection.query_row("SELECT count(*) FROM threads", [], |row| row.get(0)).unwrap();
        assert_eq!(left, 2);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn refuses_an_unknown_table_and_changes_nothing() {
        let home = temp_home("schema");
        drop(state_database(&home, true));
        let Err(refused) = clean_databases(&home, 5000) else { panic!("should refuse") };
        assert_eq!(refused.reason, "unsupportedSchema");
        let connection = Connection::open(home.join("state_5.sqlite")).unwrap();
        let left: i64 = connection.query_row("SELECT count(*) FROM threads", [], |row| row.get(0)).unwrap();
        assert_eq!(left, 3);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn refuses_an_unverified_database_version() {
        let home = temp_home("version");
        fs::write(home.join("state_6.sqlite"), b"").unwrap();
        let Err(refused) = clean_databases(&home, 5000) else { panic!("should refuse") };
        assert_eq!((refused.reason, refused.detail.as_deref()), ("unsupportedSchema", Some("state_6.sqlite")));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn session_index_keeps_unparseable_lines() {
        let home = temp_home("index");
        fs::write(home.join("session_index.jsonl"), "{\"id\":\"old\"}\nnot json\n{\"id\":\"new\"}\n").unwrap();
        assert!(prune_session_index(&home, &HashSet::from(["old".to_string()])));
        assert_eq!(fs::read_to_string(home.join("session_index.jsonl")).unwrap(), "not json\n{\"id\":\"new\"}\n");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn retention_boundary_is_strict() {
        let file = |mtime_ms| HistoryFile { path: PathBuf::new(), size: 1, mtime_ms };
        let cutoff = cutoff_ms(1_000_000_000_000);
        assert!(is_stale(&file(cutoff - 1), cutoff));
        assert!(!is_stale(&file(cutoff), cutoff));
        assert!(!is_stale(&file(2_000_000_000_000), cutoff));
    }

    #[test]
    fn formats_bytes_like_the_renderer() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(640 * 1024 * 1024), "640 MB");
        assert_eq!(format_bytes(1_288_490_189), "1.2 GB");
    }
}
