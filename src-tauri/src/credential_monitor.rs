// Slow sweep over every credential, so a lapsed login is noticed within hours
// rather than whenever a quota call happens to come back 401. A port of the
// notifying half of src/main/credential-monitor.ts. It only reads, through
// crate::credentials, which is read-only by construction.
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::{monitor, settings::SettingsState};

// Mirrors CREDENTIAL_CHECK_INTERVAL_MS in src/shared/credential-utils.ts.
const SWEEP_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);
const FIRST_SWEEP_DELAY: Duration = Duration::from_secs(45);

fn unusable(state: &str) -> bool {
    matches!(state, "expired" | "missing" | "error")
}

async fn sweep(app: &AppHandle) {
    for service in monitor::SERVICES {
        // A service the user switched off is never probed.
        if !app.state::<SettingsState>().flag(monitor::enabled_setting(service)) {
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
        if unusable(state) {
            crate::notify::credential_unusable(app, service, state, status["expiresAt"].as_str());
        } else {
            crate::notify::credential_usable(app, service);
        }
    }
}

pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_SWEEP_DELAY).await;
        loop {
            sweep(&app).await;
            tokio::time::sleep(SWEEP_INTERVAL).await;
        }
    });
}
