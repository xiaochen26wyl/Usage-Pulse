// Reset-time alarms. A port of src/main/alarm-service.ts and src/shared/alarm-utils.ts.
//
// The Electron build arms one setTimeout per target. Here a 5-second tick
// re-evaluates every target against the wall clock instead: monotonic timers do
// not advance while the machine sleeps, and the evaluation is idempotent
// (every decision is recorded per fireAt), so a late wake-up still rings
// exactly once for an alarm that was watched go from pending to due.
use std::{path::PathBuf, sync::Mutex, time::Duration};

use serde_json::{Map, Value, json};
use tauri::{AppHandle, Manager};

use crate::{
    i18n::{fill, tr},
    line,
    monitor::MonitorState,
    notify,
    settings::SettingsState,
    time::{iso_from_ms, now_iso, now_ms, parse_iso_ms},
};

// The subscription alarm rings this long before the plan's expiry.
const CLAUDE_BILLING_LEAD_MS: i64 = 24 * 60 * 60 * 1000;
const TICK: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq)]
pub struct Target {
    pub id: &'static str,
    pub service: &'static str,
    pub fire_at: String,
    pub label: String,
}

impl Target {
    fn json(&self) -> Value {
        json!({ "id": self.id, "service": self.service, "fireAt": self.fire_at, "label": self.label })
    }
}

#[derive(Debug, PartialEq)]
enum Action {
    Schedule,
    Fire,
    Skip,
}

// ---- pure rules ----------------------------------------------------------

/// A due target, however late, is judged one way: it rings only for the exact fireAt this app watched arm while it was
/// still in the future, however late it was finally noticed.
fn decide(fire_at: &str, now: i64, observed_pending: Option<&str>) -> Action {
    let Some(fire_ms) = parse_iso_ms(fire_at) else { return Action::Skip };
    if now < fire_ms {
        return Action::Schedule;
    }
    if observed_pending == Some(fire_at) { Action::Fire } else { Action::Skip }
}

fn claude_billing_fire_at(expires_at: &Value) -> Option<String> {
    let expires = parse_iso_ms(expires_at.as_str()?)?;
    Some(iso_from_ms(expires - CLAUDE_BILLING_LEAD_MS))
}

fn next_target(targets: &[Target], now: i64) -> Option<&Target> {
    targets
        .iter()
        .filter_map(|target| parse_iso_ms(&target.fire_at).filter(|ms| *ms > now).map(|ms| (ms, target)))
        .min_by_key(|(ms, _)| *ms)
        .map(|(_, target)| target)
}

fn text(value: &Value) -> Option<String> {
    value.as_str().filter(|text| !text.is_empty()).map(str::to_string)
}

fn collect_targets(settings: &SettingsState, snapshot: &Value, language: &str, last_good: &AlarmState) -> Vec<Target> {
    let label = |value: &Value, key: &str| text(value).unwrap_or_else(|| tr(language, key).to_string());
    let (cursor, claude, codex) = (&snapshot["cursor"], &snapshot["claude"], &snapshot["codex"]);
    let specs: [(&'static str, &'static str, Option<String>, String); 7] = [
        ("cursor-billing", "cursor", text(&cursor["resetsAt"]), label(&cursor["resetLabel"], "fallback.billingCycle")),
        ("claude-session", "claude", text(&claude["resetsAt"]), label(&claude["resetLabel"], "window.label.session")),
        ("claude-weekly", "claude", text(&claude["weeklyResetAt"]), label(&claude["weeklyResetLabel"], "window.label.weekly")),
        ("claude-billing", "claude", claude_billing_fire_at(&claude["billingResetAt"]), label(&claude["billingResetLabel"], "fallback.claudeBilling")),
        ("codex-session", "codex", text(&codex["resetsAt"]), label(&codex["resetLabel"], "window.label.session")),
        ("codex-weekly", "codex", text(&codex["weeklyResetAt"]), label(&codex["weeklyResetLabel"], "window.label.weekly")),
        ("codex-billing", "codex", text(&codex["billingResetAt"]), label(&codex["billingResetLabel"], "fallback.codexBilling")),
    ];
    let mut targets = Vec::new();
    for (id, service, reset_at, label) in specs {
        if !notify::alert_enabled(settings, id) {
            continue;
        }
        // A credential outage blanks resetsAt; keep arming from what was last known.
        let trusted = notify::is_trusted(&snapshot[service]);
        let reset_at = reset_at.or_else(|| if trusted { None } else { last_good.get("lastGood", id) });
        let Some(fire_at) = reset_at.filter(|at| parse_iso_ms(at).is_some()) else { continue };
        targets.push(Target { id, service, fire_at, label });
    }
    targets
}

// ---- persistence ---------------------------------------------------------

/// What has rung (`fired`), what was seen pending (`pending`) and the last
/// healthy reset time per source (`lastGood`), kept across restarts.
pub struct AlarmState {
    path: PathBuf,
    data: Mutex<Map<String, Value>>,
}

impl AlarmState {
    pub fn load(path: PathBuf) -> Self {
        let data = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        Self { path, data: Mutex::new(data) }
    }

    fn get(&self, kind: &str, id: &str) -> Option<String> {
        let data = self.data.lock().expect("alarm state lock poisoned");
        data.get(kind)?.get(id)?.as_str().map(str::to_string)
    }

    /// Records `fire_at` for the id; true when that changed anything.
    fn set(&self, kind: &str, id: &str, fire_at: &str) -> bool {
        let mut data = self.data.lock().expect("alarm state lock poisoned");
        let bucket = data.entry(kind.to_string()).or_insert_with(|| json!({}));
        if bucket[id].as_str() == Some(fire_at) {
            return false;
        }
        bucket[id] = json!(fire_at);
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(serialized) = serde_json::to_string(&*data) {
            let temp = self.path.with_extension("json.tmp");
            if std::fs::write(&temp, serialized).is_ok() {
                let _ = std::fs::rename(&temp, &self.path);
            }
        }
        true
    }
}

// ---- engine --------------------------------------------------------------

fn latest(app: &AppHandle) -> Option<Value> {
    Some(app.state::<MonitorState>().latest()).filter(|snapshot| !snapshot.is_null())
}

fn current_targets(app: &AppHandle) -> Vec<Target> {
    let Some(snapshot) = latest(app) else { return Vec::new() };
    let settings = app.state::<SettingsState>();
    collect_targets(&settings, &snapshot, &settings.language(), &app.state::<AlarmState>())
}

/// Re-evaluates every target. Safe to call as often as we like.
pub fn rearm(app: &AppHandle) -> Vec<Target> {
    let Some(snapshot) = latest(app) else { return Vec::new() };
    let settings = app.state::<SettingsState>();
    let state = app.state::<AlarmState>();
    let targets = collect_targets(&settings, &snapshot, &settings.language(), &state);
    let now = now_ms();

    for target in &targets {
        if notify::is_trusted(&snapshot[target.service]) {
            state.set("lastGood", target.id, &target.fire_at);
        }
        match decide(&target.fire_at, now, state.get("pending", target.id).as_deref()) {
            // Still ahead: this observation earns it the right to ring later,
            // even after a sleep that carries it well past the grace window.
            Action::Schedule => {
                state.set("pending", target.id, &target.fire_at);
            }
            // Never observed pending (fresh install, credential gap): consume it
            // quietly, we cannot claim this occurrence just reset.
            Action::Skip => {
                state.set("fired", target.id, &target.fire_at);
            }
            Action::Fire => fire(app, &snapshot, target),
        }
    }
    targets
}

fn title_key(id: &str) -> &'static str {
    match id {
        "cursor-billing" => "alarm.popup.title.cursorPeriod",
        "claude-billing" => "alarm.popup.title.claudePeriod",
        "codex-billing" => "alarm.popup.title.codexPeriod",
        _ => "alarm.popup.title",
    }
}

fn fire(app: &AppHandle, snapshot: &Value, target: &Target) {
    let state = app.state::<AlarmState>();
    if state.get("fired", target.id).as_deref() == Some(target.fire_at.as_str()) {
        return;
    }
    state.set("fired", target.id, &target.fire_at);

    // Settings are read now, not when the target was armed: they may have changed since.
    let settings = app.state::<SettingsState>();
    let language = settings.language();
    let service = line::service_label(target.service);
    let reason = match target.id {
        "cursor-billing" => tr(&language, "reason.cursorPeriodEnded").to_string(),
        "claude-billing" => tr(&language, "reason.claudePeriodEnded").to_string(),
        "codex-billing" => tr(&language, "reason.codexPeriodEnded").to_string(),
        _ => fill(tr(&language, "reason.resetFired"), &[("service", service), ("label", &target.label)]),
    };

    notify::send_quota_notification(&language, snapshot, &reason);

    if settings.alert_channel(target.id, "line") {
        let title = fill(tr(&language, title_key(target.id)), &[("service", service)]);
        line::broadcast_in_background(
            app,
            line::plain_alert(target.service, &title, &reason, &language),
            line::OwnedTarget::Alert(target.id.to_string()),
        );
    }

    if settings.alert_channel(target.id, "popup") {
        crate::alarm_window::show(
            app,
            json!({
                "id": target.id, "service": target.service, "label": target.label,
                "fireAt": target.fire_at, "language": language
            }),
        );
    }
}

pub fn report(app: &AppHandle) -> Value {
    let targets = current_targets(app);
    json!({ "nextTarget": next_target(&targets, now_ms()).map_or(Value::Null, Target::json) })
}

pub fn show_test_popup(app: &AppHandle) {
    let language = app.state::<SettingsState>().language();
    crate::alarm_window::show(
        app,
        json!({
            "id": "test", "service": "codex", "label": tr(&language, "alertLabel.codexSession"),
            "fireAt": now_iso(), "language": language,
            "countdownTarget": iso_from_ms(now_ms() + 11 * 60_000)
        }),
    );
}

/// The wall-clock tick that stands in for per-target timers.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(TICK).await;
            rearm(&app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const AT: &str = "2026-01-01T10:00:00.000Z";

    fn ms(iso: &str) -> i64 {
        parse_iso_ms(iso).unwrap()
    }

    #[test]
    fn future_target_is_scheduled() {
        assert_eq!(decide(AT, ms(AT) - 1000, None), Action::Schedule);
    }

    #[test]
    fn due_target_rings_only_if_seen_pending() {
        assert_eq!(decide(AT, ms(AT) + 1000, Some(AT)), Action::Fire);
        assert_eq!(decide(AT, ms(AT) + 1000, None), Action::Skip);
        assert_eq!(decide(AT, ms(AT) + 1000, Some("2026-01-01T05:00:00.000Z")), Action::Skip);
    }

    #[test]
    fn late_wakeup_still_rings_for_a_watched_target() {
        assert_eq!(decide(AT, ms(AT) + 3 * 60 * 60 * 1000, Some(AT)), Action::Fire);
    }

    #[test]
    fn billing_alarm_leads_expiry_by_a_day() {
        assert_eq!(claude_billing_fire_at(&json!("2026-01-02T10:00:00.000Z")).as_deref(), Some(AT));
        assert_eq!(claude_billing_fire_at(&Value::Null), None);
    }

    #[test]
    fn next_target_is_the_soonest_future_one() {
        let target = |id, fire_at: &str| Target { id, service: "codex", fire_at: fire_at.into(), label: String::new() };
        let targets = [
            target("codex-session", "2026-01-01T09:00:00.000Z"),
            target("codex-weekly", "2026-01-03T10:00:00.000Z"),
            target("codex-billing", "2026-01-02T10:00:00.000Z"),
        ];
        assert_eq!(next_target(&targets, ms(AT)).map(|target| target.id), Some("codex-billing"));
    }
}
