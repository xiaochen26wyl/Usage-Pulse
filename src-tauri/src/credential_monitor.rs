// Slow sweep over every credential, so a lapsed login is noticed within hours
// rather than whenever a quota call happens to come back 401. A port of the
// notifying half of src/main/credential-monitor.ts. It only reads, through
// crate::credentials, which is read-only by construction.
use std::time::Duration;

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::{monitor, settings::SettingsState};

// Mirrors CREDENTIAL_CHECK_INTERVAL_MS in src/shared/credential-utils.ts.
const SWEEP_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);
const FIRST_SWEEP_DELAY: Duration = Duration::from_secs(45);

fn unusable(state: &str) -> bool {
    matches!(state, "expired" | "missing" | "error")
}

/// True when any service's state or expiry differs; `checkedAt` alone is not a change.
fn auth_changed(previous: &Value, next: &Value) -> bool {
    monitor::SERVICES
        .iter()
        .any(|service| previous[*service]["state"] != next[*service]["state"] || previous[*service]["expiresAt"] != next[*service]["expiresAt"])
}

/// One pass over every enabled credential. Returns the full status, which the
/// open panel replaces wholesale, so a switched-off service keeps its last
/// known entry (read once if there is none yet) instead of being probed.
async fn sweep(app: &AppHandle, last: &Value) -> Value {
    let mut auth = json!({});
    for service in monitor::SERVICES {
        // A service the user switched off is never probed.
        if !app.state::<SettingsState>().flag(monitor::enabled_setting(service)) {
            auth[service] = if last[service].is_object() { last[service].clone() } else { monitor::credential_state(app, service).await };
            continue;
        }
        let mut status = monitor::credential_state(app, service).await;
        if unusable(status["state"].as_str().unwrap_or("ok")) {
            // Hitting the quota API is what normally prompts the IDE to renew a
            // lapsed token; only if it still looks dead afterwards has it failed.
            monitor::check_service(app, service).await;
            status = monitor::credential_state(app, service).await;
        }
        let state = status["state"].as_str().unwrap_or("ok");
        auth[service] = status.clone();
        if unusable(state) {
            crate::notify::credential_unusable(app, service, state, status["expiresAt"].as_str());
        } else {
            crate::notify::credential_usable(app, service);
        }
    }
    auth
}

pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_SWEEP_DELAY).await;
        let mut last = Value::Null;
        loop {
            let auth = sweep(&app, &last).await;
            // Lets the sweep reach an already-open panel, which otherwise only
            // refreshes its credential rows on mount or a manual re-detect.
            if auth_changed(&last, &auth) {
                let _ = app.emit("auth:updated", auth.clone());
            }
            last = auth;
            crate::schedule::sleep_for(SWEEP_INTERVAL).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth(state: &str, checked_at: &str) -> Value {
        let status = |service: &str| json!({ "service": service, "state": state, "expiresAt": null, "rotatedAt": null, "checkedAt": checked_at });
        json!({ "cursor": status("cursor"), "claude": status("claude"), "codex": status("codex") })
    }

    #[test]
    fn the_first_sweep_counts_as_a_change() {
        assert!(auth_changed(&Value::Null, &auth("ok", "t1")));
    }

    #[test]
    fn a_new_check_time_alone_is_not_a_change() {
        assert!(!auth_changed(&auth("ok", "t1"), &auth("ok", "t2")));
    }

    #[test]
    fn a_state_change_is_one() {
        assert!(auth_changed(&auth("ok", "t1"), &auth("expired", "t1")));
    }

    #[test]
    fn the_payload_holds_only_derived_status() {
        let text = auth("ok", "t1").to_string().to_lowercase();
        assert!(!text.contains("token") && !text.contains("secret"));
    }
}
