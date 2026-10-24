use std::{sync::Mutex, time::Duration};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    collectors::{self, Scrape},
    credentials::{self, CredentialError, RawCredential},
    settings::SettingsState,
    time::{iso_from_ms, now_iso, now_ms},
};

// Polling cadence, mirrors monitor-engine.ts: 15 minutes, 10 once a window runs
// low; Codex has one fixed cadence.
const FAST_POLL_THRESHOLD_PERCENT: f64 = 20.0;
const FAST_POLL: Duration = Duration::from_secs(10 * 60);
const NORMAL_POLL: Duration = Duration::from_secs(15 * 60);
const CODEX_POLL: Duration = Duration::from_secs(60);
// Mirrors EXPIRING_SOON_MS in src/shared/credential-utils.ts.
const EXPIRING_SOON_MS: i64 = 30 * 60 * 1000;
const SERVICES: [&str; 3] = ["cursor", "claude", "codex"];

pub struct MonitorState {
    latest: Mutex<Option<Value>>,
    pub http: reqwest::Client,
}

impl Default for MonitorState {
    fn default() -> Self {
        Self { latest: Mutex::new(None), http: collectors::cursor::http_client() }
    }
}

impl MonitorState {
    pub fn latest(&self) -> Value {
        self.latest.lock().expect("monitor lock poisoned").clone().unwrap_or(Value::Null)
    }
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
    let _ = app.emit("snapshot:updated", combined);
    crate::tray::refresh(app);
    snapshot
}

fn enabled_setting(service: &str) -> &'static str {
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
                tokio::time::sleep(delay).await;
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

pub async fn auth_status(app: &AppHandle) -> Value {
    let state = app.state::<MonitorState>();
    let manual = app.state::<SettingsState>().string("claudeManualToken");
    let codex = credentials::codex::resolve(&state.http).await.map(|auth| credentials::codex::as_raw(&auth));
    json!({
        "cursor": credential_status("cursor", credentials::cursor::read()),
        "claude": credential_status("claude", credentials::claude::read(&manual)),
        "codex": credential_status("codex", codex)
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
