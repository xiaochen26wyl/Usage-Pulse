// A read-only window onto the Claude Code CLI's local session logs.
//
// Two things live here that the usage API cannot give us cheaply:
//
//  - Activity. Whether the CLI has done anything since we last looked is a file
//    mtime, not a network call. Knowing it is idle lets the monitor skip a poll
//    instead of asking Anthropic the same question every ten minutes.
//  - Ground truth for a lockout. When a request is really rate-limited the CLI
//    records a `quotaLimits` object on that line with the rejection and the
//    window's real `resetsAt`. That corroborates "quota used up" without a request.
//
// The directory also holds full conversation text and account identifiers, so this
// module stats files, reads only the tail of the few that changed, keeps only lines
// that literally contain `quotaLimits`, and extracts only the four fields of
// `ClaudeCliQuotaEvent`. Nothing else is parsed, kept, logged or sent to the
// renderer. Nothing here ever writes.
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde_json::Value;

use crate::time::{iso_from_ms, parse_iso_ms};

// Only the last slice of each changed file is read. A rejection is followed by very
// little output, so it is always near the end.
const TAIL_BYTES: u64 = 64 * 1024;
// Guard against a pathological projects directory: newest first, then capped.
const MAX_FILES_PER_SCAN: usize = 40;
// The CLI and the API can round the same boundary differently; a few minutes of
// slack keeps them matching without letting a stale cycle in.
const RESET_MATCH_SLACK_MS: i64 = 5 * 60_000;

pub const SESSION_LIMIT_TYPES: [&str; 2] = ["five_hour", "session"];
pub const WEEKLY_LIMIT_TYPES: [&str; 3] = ["seven_day", "seven_day_all", "weekly"];

#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeCliQuotaEvent {
    pub at: String,
    pub status: String,
    pub rate_limit_type: Option<String>,
    pub resets_at: Option<String>,
}

pub fn projects_dir() -> Option<PathBuf> {
    match std::env::var("CLAUDE_CONFIG_DIR") {
        Ok(custom) if !custom.trim().is_empty() => Some(PathBuf::from(custom.trim()).join("projects")),
        _ => crate::credentials::home_dir().map(|home| home.join(".claude").join("projects")),
    }
}

struct LogFile {
    path: PathBuf,
    mtime_ms: i64,
}

fn list_session_logs(root: &Path) -> Vec<LogFile> {
    let Ok(projects) = fs::read_dir(root) else { return Vec::new() };
    let mut files = Vec::new();
    for project in projects.flatten() {
        if !project.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Ok(names) = fs::read_dir(project.path()) else { continue };
        for entry in names.flatten() {
            let path = entry.path();
            if !path.extension().is_some_and(|ext| ext == "jsonl") {
                continue;
            }
            let mtime = entry.metadata().ok().and_then(|meta| meta.modified().ok()).and_then(|time| time.duration_since(UNIX_EPOCH).ok());
            if let Some(mtime) = mtime {
                files.push(LogFile { path, mtime_ms: mtime.as_millis() as i64 });
            }
        }
    }
    files
}

/// When the CLI last wrote anything, and how many logs exist. Stats only.
pub fn read_activity() -> (Option<i64>, usize) {
    let Some(root) = projects_dir() else { return (None, 0) };
    let files = list_session_logs(&root);
    (files.iter().map(|file| file.mtime_ms).max(), files.len())
}

fn to_iso(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Number(number) => {
            let numeric = number.as_f64().filter(|number| number.is_finite())?;
            // The CLI writes resetsAt as epoch seconds; tolerate milliseconds too.
            Some(iso_from_ms((if numeric > 1e12 { numeric } else { numeric * 1000.0 }) as i64))
        }
        Value::String(text) if !text.trim().is_empty() => parse_iso_ms(text).map(iso_from_ms),
        _ => None,
    }
}

/// The quota event on one log line, or `None` for every line that is not one.
pub fn parse_quota_line(line: &str) -> Option<ClaudeCliQuotaEvent> {
    // A truncated first line is expected: reading starts mid-file.
    let record: Value = serde_json::from_str(line).ok()?;
    let limits = record.get("quotaLimits")?.as_object()?;
    let status = limits.get("status")?.as_str()?;
    Some(ClaudeCliQuotaEvent {
        at: to_iso(record.get("timestamp")).unwrap_or_else(|| iso_from_ms(0)),
        status: status.to_string(),
        rate_limit_type: limits.get("rateLimitType").and_then(Value::as_str).map(str::to_string),
        resets_at: to_iso(limits.get("resetsAt")),
    })
}

fn read_tail(path: &Path, bytes: u64) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let length = bytes.min(size);
    file.seek(SeekFrom::Start(size - length)).ok()?;
    let mut buffer = Vec::with_capacity(length as usize);
    file.take(length).read_to_end(&mut buffer).ok()?;
    Some(String::from_utf8_lossy(&buffer).into_owned())
}

/// Quota events recorded at or after `since_ms`, oldest first. Only files modified
/// since then are opened, and only their tail is read.
pub fn read_quota_events(since_ms: i64) -> Vec<ClaudeCliQuotaEvent> {
    let Some(root) = projects_dir() else { return Vec::new() };
    let mut files: Vec<LogFile> = list_session_logs(&root).into_iter().filter(|file| file.mtime_ms >= since_ms).collect();
    files.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    files.truncate(MAX_FILES_PER_SCAN);

    let mut events = Vec::new();
    for file in files {
        let Some(tail) = read_tail(&file.path, TAIL_BYTES) else { continue };
        for line in tail.lines() {
            // Cheap substring gate first: conversation content is never deserialised.
            if !line.contains("\"quotaLimits\"") {
                continue;
            }
            if let Some(event) = parse_quota_line(line).filter(|event| parse_iso_ms(&event.at).is_some_and(|at| at >= since_ms)) {
                events.push(event);
            }
        }
    }
    events.sort_by_key(|event| parse_iso_ms(&event.at).unwrap_or(0));
    events
}

fn type_matches(event: &ClaudeCliQuotaEvent, limit_types: &[&str]) -> bool {
    event.rate_limit_type.as_deref().is_none_or(|kind| limit_types.contains(&kind))
}

/// Whether the CLI itself was turned away by the given window recently. `resets_at`
/// is compared because a rejection from the previous cycle says nothing about this one.
pub fn has_recent_rejection(events: &[ClaudeCliQuotaEvent], limit_types: &[&str], resets_at: Option<&str>) -> bool {
    let target = resets_at.and_then(parse_iso_ms);
    events.iter().any(|event| {
        if event.status != "rejected" || !type_matches(event, limit_types) {
            return false;
        }
        match (target, event.resets_at.as_deref().and_then(parse_iso_ms)) {
            (Some(target), Some(event_reset)) => (event_reset - target).abs() <= RESET_MATCH_SLACK_MS,
            _ => true,
        }
    })
}

/// The newest still-in-the-future reset time the CLI recorded for a window. The
/// usage API does not always carry one; without it no reset alarm can be armed.
/// Past reset times are ignored: a spent cycle says nothing about the current one.
pub fn latest_future_reset(events: &[ClaudeCliQuotaEvent], limit_types: &[&str], now_ms: i64) -> Option<String> {
    let mut best: Option<(i64, &str)> = None;
    for event in events {
        let Some(reset) = event.resets_at.as_deref() else { continue };
        if !type_matches(event, limit_types) {
            continue;
        }
        let Some(ms) = parse_iso_ms(reset) else { continue };
        if ms <= now_ms || best.is_some_and(|(best_ms, _)| ms <= best_ms) {
            continue;
        }
        best = Some((ms, reset));
    }
    best.map(|(_, reset)| reset.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rejected_line() -> String {
        json!({
            "type": "assistant", "timestamp": "2026-08-20T07:41:13.318Z", "sessionId": "6e935551",
            "message": { "content": "a private conversation nobody else should read" },
            "quotaLimits": { "status": "rejected", "resetsAt": 1787221800, "rateLimitType": "five_hour", "isUsingOverage": false }
        })
        .to_string()
    }

    fn event(status: &str, kind: Option<&str>, resets_at: Option<&str>) -> ClaudeCliQuotaEvent {
        ClaudeCliQuotaEvent {
            at: "2026-08-20T07:41:13.318Z".into(),
            status: status.into(),
            rate_limit_type: kind.map(str::to_string),
            resets_at: resets_at.map(str::to_string),
        }
    }

    #[test]
    fn a_quota_line_yields_only_the_four_fields() {
        let parsed = parse_quota_line(&rejected_line()).unwrap();
        assert_eq!(parsed, event("rejected", Some("five_hour"), Some("2026-08-20T10:30:00.000Z")));
        let text = format!("{parsed:?}");
        assert!(!text.contains("private conversation") && !text.contains("sessionId"));
    }

    #[test]
    fn ordinary_and_truncated_lines_are_ignored() {
        assert!(parse_quota_line(&json!({ "type": "user", "message": { "content": "hello" } }).to_string()).is_none());
        assert!(parse_quota_line("{\"type\":\"assistant\",\"mess").is_none());
        assert!(parse_quota_line("").is_none());
        assert!(parse_quota_line(&json!({ "quotaLimits": { "resetsAt": 1 } }).to_string()).is_none());
    }

    #[test]
    fn a_rejection_for_this_very_window_corroborates_the_lockout() {
        let events = [event("rejected", Some("five_hour"), Some("2026-08-20T10:30:00.000Z"))];
        assert!(has_recent_rejection(&events, &SESSION_LIMIT_TYPES, Some("2026-08-20T10:30:00.000Z")));
        // Rounding between the CLI and the API still matches.
        assert!(has_recent_rejection(&events, &SESSION_LIMIT_TYPES, Some("2026-08-20T10:32:00.000Z")));
    }

    #[test]
    fn a_previous_cycle_another_window_or_a_non_rejection_does_not_corroborate() {
        let events = [event("rejected", Some("five_hour"), Some("2026-08-20T10:30:00.000Z"))];
        assert!(!has_recent_rejection(&events, &SESSION_LIMIT_TYPES, Some("2026-08-21T10:30:00.000Z")));
        let weekly = [event("rejected", Some("seven_day"), Some("2026-08-20T10:30:00.000Z"))];
        assert!(!has_recent_rejection(&weekly, &SESSION_LIMIT_TYPES, Some("2026-08-20T10:30:00.000Z")));
        let allowed = [event("allowed", Some("five_hour"), Some("2026-08-20T10:30:00.000Z"))];
        assert!(!has_recent_rejection(&allowed, &SESSION_LIMIT_TYPES, Some("2026-08-20T10:30:00.000Z")));
    }

    #[test]
    fn the_newest_future_reset_wins_and_past_ones_are_ignored() {
        let now = parse_iso_ms("2026-08-20T09:00:00.000Z").unwrap();
        let events = [
            event("rejected", Some("five_hour"), Some("2026-08-20T08:00:00.000Z")),
            event("rejected", Some("five_hour"), Some("2026-08-20T10:30:00.000Z")),
            event("rejected", Some("five_hour"), Some("2026-08-20T11:30:00.000Z")),
            event("rejected", Some("seven_day"), Some("2026-08-25T00:00:00.000Z")),
        ];
        assert_eq!(latest_future_reset(&events, &SESSION_LIMIT_TYPES, now).as_deref(), Some("2026-08-20T11:30:00.000Z"));
        assert_eq!(latest_future_reset(&events[..1], &SESSION_LIMIT_TYPES, now), None);
    }
}
