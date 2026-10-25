// Auto-update, a port of src/main/updater.ts on top of tauri-plugin-updater.
// Windows only, like the Electron build: updates are read from the latest
// GitHub Release's latest.json and verified against the key in tauri.conf.json.
// Everything below is a no-op elsewhere, so nothing touches the updater plugin
// on other platforms.
use std::{
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::settings::SettingsState;

const SUPPORTED: bool = cfg!(windows);
const STARTUP_DELAY: Duration = Duration::from_secs(10);
const PERIODIC_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Default)]
pub struct UpdaterState {
    checking: AtomicBool,
    // The update found by the last check, then the downloaded installer bytes.
    pending: Mutex<Option<Update>>,
    downloaded: Mutex<Option<Vec<u8>>>,
}

// Release notes come from that tag's own release-notes/<version>.json, not the
// English-only GitHub Release body, so the prompt always matches the exact tag
// it offers to install.
async fn fetch_release_notes(app: &AppHandle, version: &str) -> String {
    let url = format!(
        "https://raw.githubusercontent.com/xiaochen26wyl/Usage-Pulse/v{version}/release-notes/{version}.json"
    );
    let fetched = async {
        let notes: Value = reqwest::Client::new()
            .get(url)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .ok()?
            .json()
            .await
            .ok()?;
        let language = app.state::<SettingsState>().language();
        let pick = |key: &str| notes.get(key).and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_string);
        pick(&language).or_else(|| pick("en"))
    };
    fetched.await.unwrap_or_default()
}

// Every check (startup, periodic, manual) lands here: it answers its own caller
// and also emits update:available, so the banner shows whatever triggered it.
pub async fn check(app: &AppHandle) -> Value {
    if !SUPPORTED {
        return json!({ "status": "unsupported" });
    }
    let state = app.state::<UpdaterState>();
    // One check at a time: a periodic tick landing mid-manual-check would race it.
    if state.checking.swap(true, Ordering::SeqCst) {
        return json!({ "status": "checking" });
    }
    let result = run_check(app).await;
    state.checking.store(false, Ordering::SeqCst);
    result
}

async fn run_check(app: &AppHandle) -> Value {
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => return json!({ "status": "error", "message": error.to_string() }),
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let info = json!({
                "version": version,
                "releaseNotes": fetch_release_notes(app, &version).await,
                "releaseUrl": format!("https://github.com/xiaochen26wyl/Usage-Pulse/releases/tag/v{version}"),
            });
            let state = app.state::<UpdaterState>();
            *state.pending.lock().expect("updater lock poisoned") = Some(update);
            *state.downloaded.lock().expect("updater lock poisoned") = None;
            let _ = app.emit("update:available", info.clone());
            crate::notify::update_available(app, &version, info["releaseNotes"].as_str().unwrap_or_default());
            json!({ "status": "available", "info": info })
        }
        Ok(None) => json!({ "status": "not-available" }),
        Err(error) => json!({ "status": "error", "message": error.to_string() }),
    }
}

pub async fn download(app: &AppHandle) {
    if !SUPPORTED {
        return;
    }
    let state = app.state::<UpdaterState>();
    let Some(update) = state.pending.lock().expect("updater lock poisoned").clone() else { return };
    let mut received: u64 = 0;
    let mut last_percent: i64 = -1;
    let progress_app = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                received += chunk as u64;
                if let Some(total) = total.filter(|total| *total > 0) {
                    let percent = (received * 100 / total) as i64;
                    if percent != last_percent {
                        last_percent = percent;
                        let _ = progress_app.emit("update:download-progress", json!({ "percent": percent }));
                    }
                }
            },
            || {},
        )
        .await;
    match bytes {
        Ok(bytes) => {
            *state.downloaded.lock().expect("updater lock poisoned") = Some(bytes);
            let _ = app.emit("update:downloaded", Value::Null);
        }
        Err(error) => eprintln!("[Usage-Pulse] updater: download failed: {error}"),
    }
}

// On Windows the installer ends this process itself; restart() covers the case
// where it returns first.
pub fn install(app: &AppHandle) {
    if !SUPPORTED {
        return;
    }
    let state = app.state::<UpdaterState>();
    let update = state.pending.lock().expect("updater lock poisoned").clone();
    let bytes = state.downloaded.lock().expect("updater lock poisoned").take();
    let (Some(update), Some(bytes)) = (update, bytes) else { return };
    match update.install(bytes) {
        Ok(()) => app.restart(),
        Err(error) => eprintln!("[Usage-Pulse] updater: install failed: {error}"),
    }
}

// A check shortly after launch, then every 6 hours while the "auto check"
// setting is on (re-read each tick, so toggling it needs no re-arming).
pub fn start(app: &AppHandle) {
    if !SUPPORTED {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        let first = check(&app).await;
        // One line per launch, so an install smoke test can see the check ran.
        println!("[Usage-Pulse] updater: startup check -> {}", first["status"].as_str().unwrap_or("unknown"));
        loop {
            crate::schedule::sleep_for(PERIODIC_CHECK_INTERVAL).await;
            if app.state::<SettingsState>().flag("autoCheckForUpdates") {
                let _ = check(&app).await;
            }
        }
    });
}
