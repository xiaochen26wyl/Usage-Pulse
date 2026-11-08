use std::{
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicI64, Ordering},
    },
    time::Duration,
};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    collectors::{self, Scrape, claude_cli_log},
    credentials::{self, CredentialError, RawCredential},
    settings::SettingsState,
    stabilize::{stabilize_reset_time, stabilize_window_resets},
    time::{iso_from_ms, now_iso, now_ms, parse_iso_ms},
};

// Polling cadence: 15 minutes, 10 once a window runs
// low; Codex has one fixed cadence.
const FAST_POLL_THRESHOLD_PERCENT: f64 = 20.0;
const FAST_POLL: Duration = Duration::from_secs(10 * 60);
const NORMAL_POLL: Duration = Duration::from_secs(15 * 60);
const CODEX_POLL: Duration = Duration::from_secs(60);
// Mirrors EXPIRING_SOON_MS in src/shared/credential-utils.ts.
const EXPIRING_SOON_MS: i64 = 30 * 60 * 1000;
pub const SERVICES: [&str; 3] = ["cursor", "claude", "codex"];

// The floor between two Claude Code usage requests. Every automatic path (the schedule,
// the credential sweep's self-heal) funnels through it, so no combination of triggers can
// become a burst of API traffic. Deliberate user actions, a credential the user just
// supplied and the single-shot confirmation re-read pass it; each is bounded by construction.
const MIN_CLAUDE_FETCH_GAP_MS: i64 = 5 * 60_000;
// How far back to look in the CLI's own logs when corroborating a lockout. Wider than the
// 5-hour window so a rejection recorded at its start is still in scope.
const CLI_LOG_LOOKBACK_MS: i64 = 6 * 60 * 60_000;

/// Why a check runs. Only `Scheduled` is held back by the Claude request floor.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Trigger {
    Scheduled,
    Manual,
    Credential,
    Confirm,
}

// A saved reading older than this is not a basis for "what changed": the
// shortest quota window is 5 hours, so it has almost certainly reset since.
const SNAPSHOT_MAX_AGE_MS: i64 = 6 * 60 * 60 * 1000;
const SNAPSHOT_VERSION: i64 = 1;

pub struct MonitorState {
    latest: Mutex<Option<Value>>,
    path: Mutex<Option<PathBuf>>,
    pub http: reqwest::Client,
    last_claude_fetch_ms: AtomicI64,
    // One check per service at a time, so overlapping triggers cost one request, not two.
    running: [AtomicBool; 3],
}

impl Default for MonitorState {
    fn default() -> Self {
        Self {
            latest: Mutex::new(None),
            path: Mutex::new(None),
            http: collectors::cursor::http_client(),
            last_claude_fetch_ms: AtomicI64::new(0),
            running: Default::default(),
        }
    }
}

impl MonitorState {
    pub fn latest(&self) -> Value {
        self.latest.lock().expect("monitor lock poisoned").clone().unwrap_or(Value::Null)
    }

    /// Points the state at its save file and picks up the last reading, if it is still usable.
    pub fn load_persisted(&self, path: PathBuf) {
        let saved = std::fs::read_to_string(&path).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok());
        *self.path.lock().expect("monitor lock poisoned") = Some(path);
        if let Some(snapshot) = saved.and_then(|saved| usable_saved_snapshot(&saved, now_ms())) {
            *self.latest.lock().expect("monitor lock poisoned") = Some(snapshot);
        }
    }

    fn persist(&self, snapshot: &Value) {
        let Some(path) = self.path.lock().expect("monitor lock poisoned").clone() else { return };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let saved = json!({ "version": SNAPSHOT_VERSION, "snapshot": snapshot });
        if let Ok(text) = serde_json::to_string(&saved) {
            // Temp file + rename so a crash mid-write cannot leave half a file.
            let temp = path.with_extension("json.tmp");
            if std::fs::write(&temp, text).is_ok() {
                let _ = std::fs::rename(&temp, &path);
            }
        }
    }
}

/// The snapshot inside a saved file, or `None` when the file is the wrong
/// version, malformed, or its reading is too old to compare against.
fn usable_saved_snapshot(saved: &Value, now: i64) -> Option<Value> {
    if saved["version"].as_i64() != Some(SNAPSHOT_VERSION) {
        return None;
    }
    let snapshot = saved.get("snapshot")?;
    let fetched_at = parse_iso_ms(snapshot["fetchedAt"].as_str()?)?;
    if now - fetched_at > SNAPSHOT_MAX_AGE_MS || fetched_at > now {
        return None;
    }
    SERVICES.iter().all(|service| snapshot[*service].is_object()).then(|| snapshot.clone())
}

fn unknown_snapshot(service: &str) -> Value {
    json!({
        "service": service, "remaining": null, "total": null, "percent": null, "unit": "percent",
        "resetsAt": null, "windows": [], "status": "unknown", "message": "", "fetchedAt": now_iso()
    })
}

fn window<'a>(windows: &'a [Value], keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| windows.iter().find(|window| window["key"] == *key))
}

fn window_percent(windows: &[Value], keys: &[&str]) -> Option<f64> {
    window(windows, keys)?.get("percent")?.as_f64()
}

/// Remaining percent of the windows that drive low-quota state, with the user's
/// thresholds. Cursor stores *used* percent, the others *remaining*.
fn watched(service: &str, windows: &[Value], settings: &SettingsState) -> Vec<(f64, f64)> {
    let threshold = |key: &str| settings.number(key, 20.0);
    let pairs: Vec<(Option<f64>, f64)> = match service {
        "cursor" => vec![
            (window_percent(windows, &["cursor_models"]).map(|used| 100.0 - used), threshold("cursorModelsLowThresholdPercent")),
            (window_percent(windows, &["other_models"]).map(|used| 100.0 - used), threshold("cursorAdvancedModelsLowThresholdPercent")),
        ],
        "claude" => vec![
            (window_percent(windows, &["session"]), threshold("claudeSessionLowThresholdPercent")),
            (window_percent(windows, &["weekly_all", "weekly_scoped", "weekly"]), threshold("claudeWeeklyLowThresholdPercent")),
        ],
        _ => vec![
            (window_percent(windows, &["session"]), threshold("codexSessionLowThresholdPercent")),
            (window_percent(windows, &["weekly"]), threshold("codexWeeklyLowThresholdPercent")),
        ],
    };
    pairs.into_iter().filter_map(|(remaining, limit)| Some((remaining?.clamp(0.0, 100.0), limit))).collect()
}

fn make_snapshot(service: &str, scrape: Scrape, settings: &SettingsState) -> Value {
    let percent = match (scrape.remaining, scrape.total) {
        (Some(remaining), Some(total)) if total > 0.0 => Some((remaining / total * 100.0).round().clamp(0.0, 100.0)),
        _ => None,
    };
    let low = watched(service, &scrape.windows, settings).iter().any(|(remaining, limit)| remaining <= limit);
    let status = if scrape.is_error {
        "error"
    } else if low {
        "low"
    } else if scrape.remaining.is_none() {
        "unknown"
    } else {
        "ok"
    };
    let mut snapshot = json!({
        "service": service, "remaining": scrape.remaining, "total": scrape.total, "percent": percent,
        "unit": scrape.unit, "resetsAt": scrape.resets_at, "windows": scrape.windows,
        "status": status, "message": scrape.message, "source": "api", "fetchedAt": now_iso()
    });
    for (key, value) in scrape.extra {
        snapshot[key] = value;
    }
    snapshot
}

fn has_service_changed(previous: &Value, next: &Value) -> bool {
    if previous.is_null() {
        return true;
    }
    ["remaining", "total", "percent", "unit", "resetsAt", "weeklyResetAt", "billingResetAt", "billingAnchorAt", "status", "windows"]
        .iter()
        .any(|key| previous[*key] != next[*key])
}

type BoxedCheck = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>;

// Boxed so the confirmation task, which calls back into check_service, does not
// make that async fn's type refer to itself.
fn confirm_held_alert_boxed(app: AppHandle, service: &'static str) -> BoxedCheck {
    Box::pin(async move { confirm_held_alert(&app, service).await })
}

fn schedule_confirmation(app: &AppHandle, service: &'static str) {
    let task_app = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(crate::notify::CONFIRM_DELAY_SECS)).await;
        confirm_held_alert_boxed(task_app, service).await;
    });
    app.state::<crate::notify::NotifyState>().set_confirmation(service, handle);
}

fn session_exhausted(windows: &[Value]) -> bool {
    window_percent(windows, &["session"]).is_some_and(|remaining| remaining <= 0.0)
}

fn weekly_exhausted(windows: &[Value]) -> bool {
    window_percent(windows, &["weekly_all", "weekly_scoped", "weekly"]).is_some_and(|remaining| remaining <= 0.0)
}

/// True when the CLI's own session log records that a request was turned away for this
/// very window, so the held lockout is real and no request needs to be spent proving it.
async fn corroborated_by_cli_log(snapshot: &Value) -> bool {
    let windows: Vec<Value> = snapshot["windows"].as_array().cloned().unwrap_or_default();
    let (session_hit, weekly_hit) = (session_exhausted(&windows), weekly_exhausted(&windows));
    if !session_hit && !weekly_hit {
        return false;
    }
    let (session_reset, weekly_reset) = (snapshot["resetsAt"].as_str().map(str::to_string), snapshot["weeklyResetAt"].as_str().map(str::to_string));
    let since = now_ms() - CLI_LOG_LOOKBACK_MS;
    let events = tauri::async_runtime::spawn_blocking(move || claude_cli_log::read_quota_events(since)).await.unwrap_or_default();
    (session_hit && claude_cli_log::has_recent_rejection(&events, &claude_cli_log::SESSION_LIMIT_TYPES, session_reset.as_deref()))
        || (weekly_hit && claude_cli_log::has_recent_rejection(&events, &claude_cli_log::WEEKLY_LIMIT_TYPES, weekly_reset.as_deref()))
}

/// Second opinion on a held alert. For Claude Code the cheapest opinion comes first: the
/// CLI's own log. Only when the log cannot settle it does this spend one more API read,
/// whose previous snapshot is by then the trustworthy one, so the ordinary path decides.
async fn confirm_held_alert(app: &AppHandle, service: &'static str) {
    if service == "claude" {
        let combined = app.state::<MonitorState>().latest();
        if crate::notify::is_trusted(&combined["claude"]) && corroborated_by_cli_log(&combined["claude"]).await {
            crate::notify::handle_alerts(app, "claude", &combined);
            return;
        }
    }
    check_service(app, service, Trigger::Confirm).await;
}

fn service_index(service: &str) -> Option<usize> {
    SERVICES.iter().position(|name| *name == service)
}

/// Clears a service's in-flight flag however the check ends.
struct RunningGuard<'a>(&'a AtomicBool);

impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Whether this Claude request must be dropped to respect the request floor.
fn claude_throttled(trigger: Trigger, last_fetch_ms: i64, now: i64) -> bool {
    trigger == Trigger::Scheduled && last_fetch_ms != 0 && now - last_fetch_ms < MIN_CLAUDE_FETCH_GAP_MS
}

/// Has the Claude Code CLI done anything since our last request? A session log written to
/// means real usage happened and the numbers may have moved; nothing having changed means
/// the quota cannot have moved either, so the request is simply not made.
async fn claude_has_activity_since_last_fetch(state: &MonitorState) -> bool {
    let last = state.last_claude_fetch_ms.load(Ordering::SeqCst);
    if last == 0 {
        return true;
    }
    match tauri::async_runtime::spawn_blocking(claude_cli_log::read_activity).await {
        // No logs at all: this user may not be a CLI user, so silence says nothing. Poll normally.
        Ok((None, _)) | Err(_) => true,
        Ok((Some(latest), _)) => latest > last,
    }
}

/// Runs one service's check, stores the result, raises any alerts and tells the renderer.
pub async fn check_service(app: &AppHandle, service: &str, trigger: Trigger) -> Value {
    let state = app.state::<MonitorState>();
    let Some(index) = service_index(service) else { return Value::Null };
    if state.running[index].swap(true, Ordering::SeqCst) {
        // Already being read: hand back what we have rather than double the requests.
        return state.latest()[service].clone();
    }
    let _guard = RunningGuard(&state.running[index]);

    if service == "claude" {
        let previous = state.latest()[service].clone();
        if !previous.is_null() && claude_throttled(trigger, state.last_claude_fetch_ms.load(Ordering::SeqCst), now_ms()) {
            return previous;
        }
        state.last_claude_fetch_ms.store(now_ms(), Ordering::SeqCst);
    }

    let settings = app.state::<SettingsState>();
    let language = settings.language();
    let scrape = match service {
        "cursor" => collectors::cursor::collect(&state.http, &language).await,
        "claude" => collectors::claude::collect(&state.http, &language, &settings.string("claudeManualToken")).await,
        _ => collectors::codex::collect(&state.http, &language).await,
    };
    apply_scrape(app, service, scrape)
}

/// Publishes an already-fetched scrape as the current snapshot, so a caller that has
/// already spent one API request never needs a second just to show the result.
fn apply_scrape(app: &AppHandle, service: &str, mut scrape: Scrape) -> Value {
    let state = app.state::<MonitorState>();
    let settings = app.state::<SettingsState>();
    if service == "claude" {
        state.last_claude_fetch_ms.store(now_ms(), Ordering::SeqCst);
    }

    let (previous, mut combined) = {
        let latest = state.latest.lock().expect("monitor lock poisoned");
        let combined = latest.clone().unwrap_or_else(|| {
            json!({
                "cursor": unknown_snapshot("cursor"),
                "claude": unknown_snapshot("claude"),
                "codex": unknown_snapshot("codex"),
                "fetchedAt": now_iso()
            })
        });
        (combined[service].clone(), combined)
    };

    // Some sources recompute resetsAt as `now + secondsLeft`, so the same real reset comes
    // back a second or two off. Pin it to the previous poll's value while that is still in
    // the future, or the one-shot alert latch re-arms on every poll.
    let now = now_ms();
    let previous_windows: Vec<Value> = previous["windows"].as_array().cloned().unwrap_or_default();
    stabilize_window_resets(&previous_windows, &mut scrape.windows, now);
    scrape.resets_at = stabilize_reset_time(previous["resetsAt"].as_str(), scrape.resets_at.as_deref(), now);
    if let Some(weekly) = scrape.extra.get("weeklyResetAt").cloned() {
        let stable = stabilize_reset_time(previous["weeklyResetAt"].as_str(), weekly.as_str(), now);
        scrape.extra.insert("weeklyResetAt".into(), stable.map_or(Value::Null, Value::from));
    }

    let snapshot = make_snapshot(service, scrape, &settings);
    combined[service] = snapshot.clone();
    combined["fetchedAt"] = json!(now_iso());

    // Nothing may interrupt the user off a reading we cannot stand behind: an
    // unreadable credential, an unparseable payload, or the first believable
    // reading after either looks exactly like a quota that ran out. Those are
    // held and confirmed once, 90 seconds later.
    let changed = has_service_changed(&previous, &snapshot);
    let cold = !crate::notify::is_trusted(&snapshot) || !crate::notify::is_trusted(&previous);
    if cold {
        if crate::notify::is_trusted(&snapshot) && crate::notify::would_alert(app, service, &snapshot) {
            if let Some(name) = SERVICES.iter().find(|name| **name == service) {
                schedule_confirmation(app, name);
            }
        }
    } else {
        if changed {
            crate::notify::notify_changed(app, service, &combined);
        }
        crate::notify::handle_alerts(app, service, &combined);
    }

    *state.latest.lock().expect("monitor lock poisoned") = Some(combined.clone());
    state.persist(&combined);
    let _ = app.emit("snapshot:updated", combined);
    crate::tray::refresh(app);
    snapshot
}

pub fn enabled_setting(service: &str) -> &'static str {
    match service {
        "cursor" => "enableCursorMonitoring",
        "claude" => "enableClaudeMonitoring",
        _ => "enableCodexMonitoring",
    }
}

fn next_delay(service: &str, snapshot: &Value, settings: &SettingsState) -> Duration {
    if service == "codex" {
        return CODEX_POLL;
    }
    let windows: Vec<Value> = snapshot["windows"].as_array().cloned().unwrap_or_default();
    let low = watched(service, &windows, settings).iter().any(|(remaining, _)| *remaining <= FAST_POLL_THRESHOLD_PERCENT);
    if low { FAST_POLL } else { NORMAL_POLL }
}

/// Starts one background polling loop per service, plus the menu-bar countdown tick.
pub fn start(app: &AppHandle) {
    crate::tray::refresh(app);
    let ticker = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            if crate::tray::countdown_on_screen(&ticker) {
                crate::tray::refresh(&ticker);
            }
        }
    });
    for service in SERVICES {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let settings = app.state::<SettingsState>();
                let delay = if settings.flag(enabled_setting(service)) {
                    let state = app.state::<MonitorState>();
                    // An idle CLI means the quota cannot have moved: skip the request, keep the cadence.
                    let snapshot = if service == "claude" && !claude_has_activity_since_last_fetch(&state).await {
                        state.latest()[service].clone()
                    } else {
                        check_service(&app, service, Trigger::Scheduled).await
                    };
                    next_delay(service, &snapshot, &settings)
                } else {
                    NORMAL_POLL
                };
                crate::schedule::sleep_for(delay).await;
            }
        });
    }
}

pub async fn run_manual(app: &AppHandle, service: &str) -> Value {
    let language = app.state::<SettingsState>().language();
    if !SERVICES.contains(&service) {
        return json!({ "ok": false, "message": crate::i18n::tr(&language, "app.authRefreshFailed") });
    }
    let snapshot = check_service(app, service, Trigger::Manual).await;
    let text = snapshot["message"].as_str().unwrap_or_default();
    // A 401 / scope / rate-limit answer is still a successful check: the
    // snapshot carries the error code so the card can offer a login again.
    if snapshot["errorCode"].is_string() {
        return json!({ "ok": true, "message": text });
    }
    if snapshot["status"] == "error" || snapshot["remaining"].is_null() {
        let message = if text.is_empty() { crate::i18n::tr(&language, "quotaCheck.noUsageYet") } else { text };
        return json!({ "ok": snapshot["status"] != "error", "message": message });
    }
    json!({ "ok": true, "message": crate::i18n::tr(&language, "quotaCheck.updated") })
}

fn credential_status(service: &str, outcome: Result<RawCredential, CredentialError>) -> Value {
    let (state, expires_at_ms) = match outcome {
        Ok(credential) => {
            let state = match credential.expires_at_ms {
                Some(expiry) if expiry <= now_ms() => "expired",
                Some(expiry) if expiry - now_ms() <= EXPIRING_SOON_MS => "expiring",
                _ => "ok",
            };
            (state, credential.expires_at_ms)
        }
        Err(CredentialError::Missing) => ("missing", None),
        Err(CredentialError::ReadFailed) => ("error", None),
    };
    json!({
        "service": service, "state": state,
        "expiresAt": expires_at_ms.map(iso_from_ms),
        "rotatedAt": null, "checkedAt": now_iso()
    })
}

/// One service's credential state, read fresh from its source.
pub async fn credential_state(app: &AppHandle, service: &str) -> Value {
    let state = app.state::<MonitorState>();
    match service {
        "cursor" => credential_status("cursor", credentials::cursor::read()),
        "claude" => {
            let manual = app.state::<SettingsState>().string("claudeManualToken");
            credential_status("claude", credentials::claude::read(&manual))
        }
        _ => {
            let codex = credentials::codex::resolve(&state.http).await.map(|auth| credentials::codex::as_raw(&auth));
            credential_status("codex", codex)
        }
    }
}

pub async fn auth_status(app: &AppHandle) -> Value {
    json!({
        "cursor": credential_state(app, "cursor").await,
        "claude": credential_state(app, "claude").await,
        "codex": credential_state(app, "codex").await
    })
}

fn token_result(ok: bool, code: Option<&str>, language: &str, key: &str) -> Value {
    let mut result = json!({ "ok": ok, "message": crate::i18n::tr(language, key) });
    if let Some(code) = code {
        result["code"] = json!(code);
    }
    result
}

/// "Paste a Claude token": it is stored only after it has just read the usage API.
pub async fn save_claude_token(app: &AppHandle, raw: &Value) -> Value {
    let settings = app.state::<SettingsState>();
    let state = app.state::<MonitorState>();
    let language = settings.language();
    let token = raw.as_str().unwrap_or_default().trim().to_string();
    if token.is_empty() {
        return token_result(false, Some("empty"), &language, "claudeToken.empty");
    }
    if !credentials::claude::is_oauth_token(&token) {
        return token_result(false, Some("formatInvalid"), &language, "claudeToken.formatInvalid");
    }
    let probe = collectors::claude::collect_with_token(&state.http, &language, &token, "manualToken").await;
    if probe.is_error {
        let (code, key) = match probe.extra.get("errorCode").and_then(Value::as_str) {
            Some("claudeScopeInsufficient") => ("scopeInsufficient", "claudeToken.scopeInsufficient"),
            Some("claudeLoginExpired") => ("loginExpired", "claudeToken.loginExpired"),
            Some("claudeRateLimited") => ("rateLimited", "claudeToken.rateLimited"),
            _ => ("apiFailed", "claudeToken.apiFailed"),
        };
        return token_result(false, Some(code), &language, key);
    }
    let key = if probe.windows.is_empty() { "claudeToken.savedNoUsage" } else { "claudeToken.saved" };
    settings.set_secret("claudeManualToken", &token);
    // The probe just read the usage API; publish that reading instead of asking again, so
    // card, tray and credential state agree at the cost of one request, not two.
    apply_scrape(app, "claude", probe);
    token_result(true, None, &language, key)
}

pub async fn clear_claude_token(app: &AppHandle) -> Value {
    let settings = app.state::<SettingsState>();
    settings.set_secret("claudeManualToken", "");
    check_service(app, "claude", Trigger::Credential).await;
    token_result(true, None, &settings.language(), "claudeToken.cleared")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(version: i64, fetched_at: &str) -> Value {
        let service = |name: &str| json!({ "service": name, "status": "ok", "windows": [{ "key": "session", "percent": 50 }] });
        json!({
            "version": version,
            "snapshot": { "cursor": service("cursor"), "claude": service("claude"), "codex": service("codex"), "fetchedAt": fetched_at }
        })
    }

    #[test]
    fn a_recent_saved_snapshot_is_reused() {
        let now = parse_iso_ms("2026-01-01T10:00:00.000Z").unwrap();
        let file = saved(SNAPSHOT_VERSION, "2026-01-01T08:00:00.000Z");
        assert!(usable_saved_snapshot(&file, now).is_some());
    }

    #[test]
    fn a_stale_or_future_snapshot_is_dropped() {
        let now = parse_iso_ms("2026-01-01T10:00:00.000Z").unwrap();
        assert!(usable_saved_snapshot(&saved(SNAPSHOT_VERSION, "2026-01-01T03:00:00.000Z"), now).is_none());
        assert!(usable_saved_snapshot(&saved(SNAPSHOT_VERSION, "2026-01-01T11:00:00.000Z"), now).is_none());
    }

    #[test]
    fn a_wrong_version_or_malformed_file_falls_back_to_a_cold_start() {
        let now = parse_iso_ms("2026-01-01T10:00:00.000Z").unwrap();
        assert!(usable_saved_snapshot(&saved(SNAPSHOT_VERSION + 1, "2026-01-01T09:00:00.000Z"), now).is_none());
        assert!(usable_saved_snapshot(&json!({ "version": SNAPSHOT_VERSION, "snapshot": { "fetchedAt": "2026-01-01T09:00:00.000Z" } }), now).is_none());
        assert!(usable_saved_snapshot(&json!("garbage"), now).is_none());
    }

    #[test]
    fn only_a_scheduled_claude_request_is_held_to_the_floor() {
        let now = 10 * MIN_CLAUDE_FETCH_GAP_MS;
        let recent = now - MIN_CLAUDE_FETCH_GAP_MS + 1;
        assert!(claude_throttled(Trigger::Scheduled, recent, now));
        for trigger in [Trigger::Manual, Trigger::Credential, Trigger::Confirm] {
            assert!(!claude_throttled(trigger, recent, now));
        }
    }

    #[test]
    fn the_floor_lifts_after_the_gap_and_on_the_first_ever_request() {
        let now = 10 * MIN_CLAUDE_FETCH_GAP_MS;
        assert!(!claude_throttled(Trigger::Scheduled, now - MIN_CLAUDE_FETCH_GAP_MS, now));
        assert!(!claude_throttled(Trigger::Scheduled, 0, now));
    }

    #[test]
    fn exhaustion_is_read_from_the_remaining_percent_of_the_primary_windows() {
        let windows = vec![json!({ "key": "session", "percent": 0 }), json!({ "key": "weekly_all", "percent": 40 })];
        assert!(session_exhausted(&windows));
        assert!(!weekly_exhausted(&windows));
        assert!(!session_exhausted(&[]));
    }

    #[test]
    fn the_saved_file_carries_no_credential_fields() {
        let file = saved(SNAPSHOT_VERSION, "2026-01-01T09:00:00.000Z").to_string().to_lowercase();
        assert!(!file.contains("token") && !file.contains("secret") && !file.contains("password"));
    }
}
