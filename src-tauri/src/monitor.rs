use std::{path::PathBuf, sync::Mutex, time::Duration};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    collectors::{self, Scrape},
    credentials::{self, CredentialError, RawCredential},
    settings::SettingsState,
    time::{iso_from_ms, now_iso, now_ms, parse_iso_ms},
};

// Polling cadence, mirrors monitor-engine.ts: 15 minutes, 10 once a window runs
// low; Codex has one fixed cadence.
const FAST_POLL_THRESHOLD_PERCENT: f64 = 20.0;
const FAST_POLL: Duration = Duration::from_secs(10 * 60);
const NORMAL_POLL: Duration = Duration::from_secs(15 * 60);
const CODEX_POLL: Duration = Duration::from_secs(60);
// Mirrors EXPIRING_SOON_MS in src/shared/credential-utils.ts.
const EXPIRING_SOON_MS: i64 = 30 * 60 * 1000;
pub const SERVICES: [&str; 3] = ["cursor", "claude", "codex"];

// A saved reading older than this is not a basis for "what changed": the
// shortest quota window is 5 hours, so it has almost certainly reset since.
const SNAPSHOT_MAX_AGE_MS: i64 = 6 * 60 * 60 * 1000;
const SNAPSHOT_VERSION: i64 = 1;

pub struct MonitorState {
    latest: Mutex<Option<Value>>,
    path: Mutex<Option<PathBuf>>,
    pub http: reqwest::Client,
}

impl Default for MonitorState {
    fn default() -> Self {
        Self { latest: Mutex::new(None), path: Mutex::new(None), http: collectors::cursor::http_client() }
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

type BoxedCheck = std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send>>;

// Boxed so the confirmation task, which calls back into check_service, does not
// make that async fn's type refer to itself.
fn check_service_boxed(app: AppHandle, service: &'static str) -> BoxedCheck {
    Box::pin(async move { check_service(&app, service).await })
}

fn schedule_confirmation(app: &AppHandle, service: &'static str) {
    let task_app = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(crate::notify::CONFIRM_DELAY_SECS)).await;
        check_service_boxed(task_app, service).await;
    });
    app.state::<crate::notify::NotifyState>().set_confirmation(service, handle);
}

/// Runs one service's check, stores the result, raises any alerts and tells the renderer.
pub async fn check_service(app: &AppHandle, service: &str) -> Value {
    let state = app.state::<MonitorState>();
    let settings = app.state::<SettingsState>();
    let language = settings.language();
    let scrape = match service {
        "cursor" => collectors::cursor::collect(&state.http, &language).await,
        "claude" => collectors::claude::collect(&state.http, &language, &settings.string("claudeManualToken")).await,
        "codex" => collectors::codex::collect(&state.http, &language).await,
        _ => return Value::Null,
    };
    let snapshot = make_snapshot(service, scrape, &settings);

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
                    let snapshot = check_service(&app, service).await;
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
    let snapshot = check_service(app, service).await;
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
    // Re-run through the normal path so card, tray and credential state agree.
    check_service(app, "claude").await;
    token_result(true, None, &language, key)
}

pub async fn clear_claude_token(app: &AppHandle) -> Value {
    let settings = app.state::<SettingsState>();
    settings.set_secret("claudeManualToken", "");
    check_service(app, "claude").await;
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
    fn the_saved_file_carries_no_credential_fields() {
        let file = saved(SNAPSHOT_VERSION, "2026-01-01T09:00:00.000Z").to_string().to_lowercase();
        assert!(!file.contains("token") && !file.contains("secret") && !file.contains("password"));
    }
}
