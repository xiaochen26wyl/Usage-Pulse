// Low-quota, exhausted and recovered alerts. A port of the alert half of
// src/main/monitor-engine.ts: one-shot latches per alert, a hysteresis band
// before a latch is cleared, and no alert from a reading we cannot trust.
use std::{collections::HashMap, path::PathBuf, sync::Mutex};

use serde_json::{Map, Value, json};
use tauri::{AppHandle, Manager};

use crate::{
    i18n::{fill, tr},
    settings::SettingsState,
    time::{local_text_from_iso, now_iso, now_ms, parse_iso_ms},
};

const RECOVERY_HYSTERESIS_PERCENT: f64 = 5.0;
pub const CONFIRM_DELAY_SECS: u64 = 90;
const APP_ID: &str = "com.xiaochen26wyl.usagepulse";

// ---- trust ---------------------------------------------------------------

/// A reading with real windows and no error. Mirrors snapshot-trust.ts.
pub fn is_trusted(snapshot: &Value) -> bool {
    !snapshot.is_null()
        && !matches!(snapshot["status"].as_str(), Some("error" | "unknown"))
        && snapshot["windows"].as_array().is_some_and(|windows| !windows.is_empty())
}

// ---- latch store ---------------------------------------------------------

/// What fired last per scope (`lowquota:<id>`, `change:<service>`), kept across restarts.
pub struct NotifyState {
    path: PathBuf,
    records: Mutex<Map<String, Value>>,
    confirmations: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
}

impl NotifyState {
    pub fn load(path: PathBuf) -> Self {
        let records = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        Self { path, records: Mutex::new(records), confirmations: Mutex::new(HashMap::new()) }
    }

    fn save(&self, records: &Map<String, Value>) {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(text) = serde_json::to_string(records) {
            let temp = self.path.with_extension("json.tmp");
            if std::fs::write(&temp, text).is_ok() {
                let _ = std::fs::rename(&temp, &self.path);
            }
        }
    }

    fn last(records: &Map<String, Value>, scope: &str) -> (String, String) {
        let record = records.get(scope).unwrap_or(&Value::Null);
        (record["key"].as_str().unwrap_or_default().to_string(), record["at"].as_str().unwrap_or_default().to_string())
    }

    fn get_key(&self, scope: &str) -> String {
        Self::last(&self.records.lock().expect("notify lock poisoned"), scope).0
    }

    /// First sight of `key` for this scope fires; the same key stays silent however long it lasts.
    fn should_fire_once(&self, scope: &str, key: &str) -> bool {
        let mut records = self.records.lock().expect("notify lock poisoned");
        if Self::last(&records, scope).0 == key {
            return false;
        }
        records.insert(scope.to_string(), json!({ "key": key, "at": now_iso() }));
        self.save(&records);
        true
    }

    /// Same key inside the cooldown stays silent.
    fn should_notify(&self, scope: &str, key: &str, cooldown_ms: i64) -> bool {
        let mut records = self.records.lock().expect("notify lock poisoned");
        let (last_key, last_at) = Self::last(&records, scope);
        let last_ms = parse_iso_ms(&last_at).unwrap_or(0);
        if last_key == key && last_ms > 0 && now_ms() - last_ms < cooldown_ms {
            return false;
        }
        records.insert(scope.to_string(), json!({ "key": key, "at": now_iso() }));
        self.save(&records);
        true
    }

    /// Removes a latch; true when there was one (the one-shot gate for "recovered").
    fn clear(&self, scope: &str) -> bool {
        let mut records = self.records.lock().expect("notify lock poisoned");
        let existed = records.remove(scope).is_some_and(|record| record["key"].as_str().is_some_and(|key| !key.is_empty()));
        self.save(&records);
        existed
    }

    /// Re-arms a held alert's confirmation, replacing one still pending.
    pub fn set_confirmation(&self, service: &str, handle: tauri::async_runtime::JoinHandle<()>) {
        if let Some(previous) = self.confirmations.lock().expect("notify lock poisoned").insert(service.to_string(), handle) {
            previous.abort();
        }
    }
}

// ---- window state --------------------------------------------------------

struct WindowState {
    low: bool,
    exhausted: bool,
    remaining_percent: Option<f64>,
    resets_at: Option<String>,
}

fn find<'a>(windows: &'a [Value], keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| windows.iter().find(|window| window["key"] == *key))
}

// Cursor stores *used* percent, the others *remaining*.
fn window_state(window: Option<&Value>, cursor: bool, threshold: f64) -> WindowState {
    let percent = window.and_then(|window| window["percent"].as_f64());
    let remaining = percent.map(|value| if cursor { (100.0 - value).clamp(0.0, 100.0) } else { value });
    WindowState {
        low: remaining.is_some_and(|value| value <= threshold),
        exhausted: remaining.is_some_and(|value| value <= 0.0),
        remaining_percent: remaining,
        resets_at: window.and_then(|window| window["resetsAt"].as_str()).map(str::to_string),
    }
}

// ---- firing --------------------------------------------------------------

fn service_label(service: &str) -> &'static str {
    match service {
        "cursor" => "Cursor",
        "claude" => "Claude Code",
        _ => "Codex",
    }
}

fn format_value(value: &Value, unit: &str) -> String {
    match value.as_f64() {
        None => "N/A".into(),
        Some(number) if unit == "usd" => format!("${number:.2}"),
        Some(number) if unit == "percent" => format!("{}%", number.round() as i64),
        Some(number) => number.to_string(),
    }
}

fn quota_line(snapshot: &Value) -> String {
    let unit = snapshot["unit"].as_str().unwrap_or("");
    format!("{} / {}", format_value(&snapshot["remaining"], unit), format_value(&snapshot["total"], unit))
}

/// The single exit for desktop notifications.
pub fn send_desktop(title: &str, body: &str) {
    let (title, body) = (title.to_string(), body.to_string());
    // notify-rust talks to the OS synchronously; keep it off the async workers.
    std::thread::spawn(move || {
        #[cfg(all(target_os = "macos", not(debug_assertions)))]
        let _ = notify_rust::set_application(APP_ID);
        let _ = APP_ID;
        let _ = notify_rust::Notification::new()
            .summary(&title)
            .body(&body)
            .timeout(notify_rust::Timeout::Milliseconds(30_000))
            .show();
    });
}

fn send_quota_notification(language: &str, combined: &Value, reason: &str) {
    send_desktop(
        tr(language, "notification.title"),
        &format!("{reason}\nCursor: {} | Claude Code: {}", quota_line(&combined["cursor"]), quota_line(&combined["claude"])),
    );
}

struct Ctx<'a> {
    app: &'a AppHandle,
    notify: &'a NotifyState,
    settings: &'a SettingsState,
    combined: &'a Value,
    language: &'a str,
}

fn send_line(ctx: &Ctx, alert_key: &str, message: Value) {
    crate::line::broadcast_in_background(ctx.app, message, crate::line::OwnedTarget::Alert(alert_key.to_string()));
}

// One-shot: the desktop notice and the LINE bubble go out together, once per occurrence.
fn fire_low_quota_alert(ctx: &Ctx, id: &str, alert: &WindowAlert, exhausted: bool, dedupe_key: &str, reason: &str, reset_at: Option<&str>) -> bool {
    if !ctx.notify.should_fire_once(&format!("lowquota:{id}"), dedupe_key) {
        return false;
    }
    send_quota_notification(ctx.language, ctx.combined, reason);
    let options = crate::line::QuotaOptions {
        service: alert.service,
        window_label: &alert.label,
        remaining_percent: if exhausted { Some(0.0) } else { alert.state.remaining_percent },
        threshold_percent: Some(alert.threshold),
        reset_at,
        language: ctx.language,
    };
    send_line(ctx, alert.low_id, if exhausted { crate::line::exhausted(&options) } else { crate::line::low_quota(&options) });
    true
}

fn fire_recovered(ctx: &Ctx, alert_key: &str, service: &str, label: &str, remaining: Option<f64>, reset_at: Option<&str>) {
    let reason = fill(tr(ctx.language, "reason.quotaRecoveredNotify"), &[("service", service_label(service)), ("label", label)]);
    send_quota_notification(ctx.language, ctx.combined, &reason);
    let options = crate::line::QuotaOptions {
        service,
        window_label: label,
        remaining_percent: remaining,
        threshold_percent: None,
        reset_at,
        language: ctx.language,
    };
    send_line(ctx, alert_key, crate::line::recovered(&options));
}

struct WindowAlert<'a> {
    service: &'a str,
    state: WindowState,
    low_id: &'a str,
    exhausted_id: Option<&'a str>,
    label: String,
    threshold: f64,
    fallback_reset_at: Option<String>,
    // Session windows hand the recovered notice back to the caller.
    defer_recovered: bool,
}

/// Returns (notified, recovered-but-deferred).
fn fire_window_alert(ctx: &Ctx, alert: &WindowAlert) -> (bool, bool) {
    let state = &alert.state;
    let reset_at = state.resets_at.clone().or_else(|| alert.fallback_reset_at.clone());
    let label_service = service_label(alert.service);

    if let (Some(exhausted_id), true) = (alert.exhausted_id, state.exhausted) {
        let reset_text = reset_at.as_deref().and_then(local_text_from_iso).unwrap_or_else(|| tr(ctx.language, "app.unknown").to_string());
        let reason = fill(
            tr(ctx.language, "reason.quotaExhaustedNotify"),
            &[("service", label_service), ("label", &alert.label), ("resetTime", &reset_text)],
        );
        let key = reset_at.clone().unwrap_or_else(|| "exhausted".into());
        return (fire_low_quota_alert(ctx, exhausted_id, alert, true, &key, &reason, reset_at.as_deref()), false);
    }

    if !state.low {
        let recovered_enough = state.remaining_percent.is_some_and(|value| value > alert.threshold + RECOVERY_HYSTERESIS_PERCENT);
        if recovered_enough {
            let had_low = ctx.notify.clear(&format!("lowquota:{}", alert.low_id));
            let had_exhausted = alert.exhausted_id.is_some_and(|id| ctx.notify.clear(&format!("lowquota:{id}")));
            if had_low || had_exhausted {
                if alert.defer_recovered {
                    return (false, true);
                }
                fire_recovered(ctx, alert.low_id, alert.service, &alert.label, state.remaining_percent, reset_at.as_deref());
                return (true, false);
            }
        }
        return (false, false);
    }

    let threshold_text = format!("{}", alert.threshold);
    let reason = fill(
        tr(ctx.language, "reason.lowQuotaNotify"),
        &[("service", &format!("{label_service}·{}", alert.label)), ("threshold", &threshold_text)],
    );
    let key = format!("{}|{}", alert.threshold, reset_at.as_deref().unwrap_or("none"));
    (fire_low_quota_alert(ctx, alert.low_id, alert, false, &key, &reason, reset_at.as_deref()), false)
}

// A latch raised for a window that has since vanished from the payload clears
// once the reset time it was raised for has passed.
fn vanished_latch_cleared(latch_key: &str) -> bool {
    let reset = latch_key.split_once('|').map_or("", |(_, reset)| reset);
    if reset == "none" {
        return false;
    }
    parse_iso_ms(reset).is_none_or(|ms| ms <= now_ms())
}

fn session_alerts(ctx: &Ctx, service: &str, snapshot: &Value, low_id: &str, threshold: f64, label_key: &str) -> bool {
    if !alert_enabled(ctx.settings, low_id) {
        return false;
    }
    let windows = snapshot["windows"].as_array().cloned().unwrap_or_default();
    let state = window_state(find(&windows, &["session"]), false, threshold);
    let remaining = state.remaining_percent;
    let label = tr(ctx.language, label_key).to_string();
    let (mut notified, mut recovered) = fire_window_alert(
        ctx,
        &WindowAlert {
            service,
            state,
            low_id,
            exhausted_id: None,
            label: label.clone(),
            threshold,
            fallback_reset_at: snapshot["resetsAt"].as_str().map(str::to_string),
            defer_recovered: true,
        },
    );
    if !recovered && remaining.is_none() {
        let scope = format!("lowquota:{low_id}");
        let latch = ctx.notify.get_key(&scope);
        if !latch.is_empty() && vanished_latch_cleared(&latch) {
            recovered = ctx.notify.clear(&scope);
        }
    }
    if recovered {
        fire_recovered(ctx, low_id, service, &label, remaining, None);
        notified = true;
    }
    notified
}

pub fn alert_enabled(settings: &SettingsState, alert: &str) -> bool {
    settings.alert_channel(alert, "popup") || settings.alert_channel(alert, "line")
}

/// Runs the alert checks for one service's fresh snapshot.
pub fn handle_alerts(app: &AppHandle, service: &str, combined: &Value) -> bool {
    let notify = app.state::<NotifyState>();
    let settings = app.state::<SettingsState>();
    let language = settings.language();
    let ctx = Ctx { app, notify: &notify, settings: &settings, combined, language: &language };
    let snapshot = &combined[service];
    let windows = snapshot["windows"].as_array().cloned().unwrap_or_default();
    let threshold = |key: &str| settings.number(key, 20.0);
    let mut notified = false;

    match service {
        "cursor" => {
            let fallback = snapshot["resetsAt"].as_str().map(str::to_string);
            let specs = [
                ("cursor-advanced-models-low", "cursor-advanced-models-exhausted", "other_models", "alertLabel.cursorAdvancedModels", "cursorAdvancedModelsLowThresholdPercent"),
                ("cursor-models-low", "cursor-models-exhausted", "cursor_models", "alertLabel.cursorModels", "cursorModelsLowThresholdPercent"),
            ];
            for (low_id, exhausted_id, key, label_key, threshold_key) in specs {
                if !alert_enabled(&settings, low_id) {
                    continue;
                }
                let limit = threshold(threshold_key);
                let (fired, _) = fire_window_alert(
                    &ctx,
                    &WindowAlert {
                        service,
                        state: window_state(find(&windows, &[key]), true, limit),
                        low_id,
                        exhausted_id: Some(exhausted_id),
                        label: tr(&language, label_key).to_string(),
                        threshold: limit,
                        fallback_reset_at: fallback.clone(),
                        defer_recovered: false,
                    },
                );
                notified |= fired;
            }
        }
        "claude" | "codex" => {
            let (session_id, weekly_id, weekly_exhausted_id, session_threshold, weekly_threshold, session_label, weekly_label, weekly_keys): (&str, &str, &str, f64, f64, &str, &str, &[&str]) =
                if service == "claude" {
                    (
                        "claude-session-low", "claude-weekly-low", "claude-weekly-exhausted",
                        threshold("claudeSessionLowThresholdPercent"), threshold("claudeWeeklyLowThresholdPercent"),
                        "alertLabel.claudeSession", "alertLabel.claudeWeekly", &["weekly_all", "weekly_scoped", "weekly"],
                    )
                } else {
                    (
                        "codex-session-low", "codex-weekly-low", "codex-weekly-exhausted",
                        threshold("codexSessionLowThresholdPercent"), threshold("codexWeeklyLowThresholdPercent"),
                        "alertLabel.codexSession", "alertLabel.codexWeekly", &["weekly"],
                    )
                };
            notified |= session_alerts(&ctx, service, snapshot, session_id, session_threshold, session_label);
            if alert_enabled(&settings, weekly_id) {
                let (fired, _) = fire_window_alert(
                    &ctx,
                    &WindowAlert {
                        service,
                        state: window_state(find(&windows, weekly_keys), false, weekly_threshold),
                        low_id: weekly_id,
                        exhausted_id: Some(weekly_exhausted_id),
                        label: tr(&language, weekly_label).to_string(),
                        threshold: weekly_threshold,
                        fallback_reset_at: snapshot["weeklyResetAt"].as_str().map(str::to_string),
                        defer_recovered: false,
                    },
                );
                notified |= fired;
            }
        }
        _ => {}
    }
    notified
}

/// Would this reading have raised an alert, had it been trusted? Decides whether
/// a held reading is worth confirming.
pub fn would_alert(app: &AppHandle, service: &str, snapshot: &Value) -> bool {
    let settings = app.state::<SettingsState>();
    let windows = snapshot["windows"].as_array().cloned().unwrap_or_default();
    let number = |key: &str| settings.number(key, 20.0);
    let check = |alert: &str, state: WindowState| alert_enabled(&settings, alert) && (state.low || state.exhausted);
    match service {
        "cursor" => {
            check("cursor-advanced-models-low", window_state(find(&windows, &["other_models"]), true, number("cursorAdvancedModelsLowThresholdPercent")))
                || check("cursor-models-low", window_state(find(&windows, &["cursor_models"]), true, number("cursorModelsLowThresholdPercent")))
        }
        "claude" => {
            let session = window_state(find(&windows, &["session"]), false, number("claudeSessionLowThresholdPercent"));
            (alert_enabled(&settings, "claude-session-low") && session.low)
                || check("claude-weekly-low", window_state(find(&windows, &["weekly_all", "weekly_scoped", "weekly"]), false, number("claudeWeeklyLowThresholdPercent")))
        }
        "codex" => {
            let session = window_state(find(&windows, &["session"]), false, number("codexSessionLowThresholdPercent"));
            (alert_enabled(&settings, "codex-session-low") && session.low)
                || check("codex-weekly-low", window_state(find(&windows, &["weekly"]), false, number("codexWeeklyLowThresholdPercent")))
        }
        _ => false,
    }
}

/// "Quota changed" notice, rate-limited by the user's cooldown.
pub fn notify_changed(app: &AppHandle, service: &str, combined: &Value) -> bool {
    let notify = app.state::<NotifyState>();
    let settings = app.state::<SettingsState>();
    let snapshot = &combined[service];
    let key = json!({
        "remaining": snapshot["remaining"], "total": snapshot["total"],
        "percent": snapshot["percent"], "status": snapshot["status"]
    })
    .to_string();
    let cooldown_ms = (settings.number("notifyCooldownMinutes", 15.0) * 60_000.0) as i64;
    if !notify.should_notify(&format!("change:{service}"), &key, cooldown_ms) {
        return false;
    }
    send_quota_notification(&settings.language(), combined, tr(&settings.language(), "reason.changed"));
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> NotifyState {
        NotifyState::load(std::env::temp_dir().join(format!("usage-pulse-notify-{}-{}.json", std::process::id(), now_ms())))
    }

    #[test]
    fn a_latch_fires_once_until_cleared() {
        let notify = store();
        assert!(notify.should_fire_once("lowquota:x", "20|none"));
        assert!(!notify.should_fire_once("lowquota:x", "20|none"));
        assert!(notify.should_fire_once("lowquota:x", "30|none"));
        assert!(notify.clear("lowquota:x"));
        assert!(!notify.clear("lowquota:x"));
        assert!(notify.should_fire_once("lowquota:x", "30|none"));
    }

    #[test]
    fn cursor_windows_count_used_percent_as_remaining() {
        let window = json!({ "key": "cursor_models", "percent": 85.0 });
        let state = window_state(Some(&window), true, 20.0);
        assert_eq!(state.remaining_percent, Some(15.0));
        assert!(state.low && !state.exhausted);
        let spent = window_state(Some(&json!({ "percent": 100.0 })), true, 20.0);
        assert!(spent.exhausted);
    }

    #[test]
    fn untrusted_readings_are_never_alarm_material() {
        assert!(!is_trusted(&Value::Null));
        assert!(!is_trusted(&json!({ "status": "error", "windows": [{}] })));
        assert!(!is_trusted(&json!({ "status": "ok", "windows": [] })));
        assert!(is_trusted(&json!({ "status": "low", "windows": [{}] })));
    }

    #[test]
    fn a_vanished_window_latch_clears_only_after_its_reset_time() {
        assert!(!vanished_latch_cleared("20|none"));
        assert!(vanished_latch_cleared("20|2000-01-01T00:00:00.000Z"));
        assert!(!vanished_latch_cleared("20|2999-01-01T00:00:00.000Z"));
    }
}
