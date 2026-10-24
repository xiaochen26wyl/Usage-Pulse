use std::process::Command;

use serde_json::{Value, json};
use tauri::{AppHandle, State};

use crate::{monitor, settings::SettingsState};

// Mirrors SUPPORT_LINKS in src/shared/support-links.ts: the only destinations
// the app ever opens on the renderer's behalf.
const SUPPORT_LINKS: [&str; 5] = [
    "https://www.threads.com/@xiaochen26wyl",
    "https://lin.ee/6XYi49XZ",
    "https://www.instagram.com/xiaochen26wyl/",
    "https://wa.me/message/ZENT2RTQIGPEI1",
    "https://www.linkedin.com/in/wenyu-li-1a9868bb/",
];

fn open_external(url: &str) -> Result<(), String> {
    if !SUPPORT_LINKS.contains(&url) {
        return Err("url is not an allowed support link".to_string());
    }
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(url).status();
    #[cfg(target_os = "windows")]
    let status = Command::new("cmd").args(["/C", "start", "", url]).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open").arg(url).status();
    status.map(|_| ()).map_err(|error| error.to_string())
}

// Every request from the renderer arrives here, keyed by the same
// `domain:action` channel names the Electron build uses. Channels still waiting
// for their phase answer with the neutral value the UI already copes with.
#[tauri::command]
pub async fn ipc_invoke(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    monitor_state: State<'_, monitor::MonitorState>,
    channel: String,
    arg: Option<Value>,
) -> Result<Value, String> {
    let arg = arg.unwrap_or(Value::Null);
    match channel.as_str() {
        "settings:get" => Ok(settings.masked()),
        "settings:save" => {
            let saved = settings.save(&arg);
            crate::tray::refresh(&app);
            Ok(saved)
        }

        "auth:status" => Ok(monitor::auth_status(&app).await),
        "auth:check" => Ok(monitor::auth_status(&app)
            .await
            .get(arg.as_str().unwrap_or_default())
            .cloned()
            .unwrap_or(Value::Null)),

        "monitor:run-manual" => Ok(monitor::run_manual(&app, arg.as_str().unwrap_or_default()).await),
        "monitor:get-latest" => Ok(monitor_state.latest()),

        "claude:save-token" => Ok(monitor::save_claude_token(&app, &arg).await),
        "claude:clear-token" => Ok(monitor::clear_claude_token(&app).await),
        "line:send-test" => Ok(json!(crate::line::send_test(&app).await)),
        "line:send-status" => Ok(json!(crate::line::send_status(&app).await)),

        "app:quit" => {
            app.exit(0);
            Ok(Value::Null)
        }
        "app:open-external" => {
            open_external(arg.as_str().unwrap_or_default())?;
            Ok(Value::Null)
        }
        "app:clear-clipboard" | "app:copy-to-clipboard" => Ok(Value::Null),
        "app:secret-storage-available" => Ok(json!(settings.secret_store_available())),

        "history:get-stats" => {
            let empty = json!({ "fileCount": 0, "totalBytes": 0, "staleFileCount": 0, "staleBytes": 0 });
            Ok(json!({ "claude": empty, "codex": empty }))
        }
        "history:clean" => Ok(json!({
            "service": arg, "status": "blocked", "reason": "probeFailed",
            "trashed": 0, "failed": 0, "dbRowsDeleted": 0
        })),

        "alarm:get-status" | "alarm:rearm" => Ok(json!({ "nextTarget": null })),
        "alarm:test-popup" | "alarm:dismiss" | "alarm:snooze" | "alarm:fit-size" => Ok(Value::Null),
        "alarm:request-payload" => Ok(Value::Null),

        "update:check" => Ok(json!({ "status": "unsupported" })),
        "update:download" | "update:install" => Ok(Value::Null),

        other => Err(format!("unknown channel: {other}")),
    }
}
