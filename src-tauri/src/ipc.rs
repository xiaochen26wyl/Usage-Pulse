use std::process::Command;

use serde_json::{Value, json};
use tauri::{AppHandle, State};

use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::{monitor, settings::SettingsState, updater};

// Mirrors SUPPORT_LINKS in src/shared/support-links.ts: the only destinations
// the app ever opens on the renderer's behalf.
const SUPPORT_LINKS: [&str; 5] = [
    "https://www.threads.com/@xiaochen26wyl",
    "https://lin.ee/6XYi49XZ",
    "https://www.instagram.com/xiaochen26wyl/",
    "https://wa.me/message/ZENT2RTQIGPEI1",
    "https://www.linkedin.com/in/wenyu-li-1a9868bb/",
];

fn is_support_link(url: &str) -> bool {
    SUPPORT_LINKS.contains(&url)
}

fn open_external(url: &str) -> Result<(), String> {
    if !is_support_link(url) {
        return Err("url is not an allowed support link".to_string());
    }
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(url).status();
    // No shell in between (so no quoting rules for the url) and no console
    // window flashing up: CREATE_NO_WINDOW.
    #[cfg(target_os = "windows")]
    let status = {
        use std::os::windows::process::CommandExt;
        Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).creation_flags(0x0800_0000).status()
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open").arg(url).status();
    status.map(|_| ()).map_err(|error| error.to_string())
}

const MAX_CLIPBOARD_LENGTH: usize = 256;

// Mirrors asClipboardText in src/main/ipc-validation.ts: whatever lands on the
// clipboard is pasted into a shell, so no control characters and a short cap.
fn clipboard_text(value: &Value) -> Option<&str> {
    let text = value.as_str()?;
    if text.chars().count() > MAX_CLIPBOARD_LENGTH || text.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(text)
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
            crate::ide_launch::apply(&app, settings.flag("launchWithIde"));
            crate::ide_presence::sync(&app);
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
        "app:clear-clipboard" => {
            let _ = app.clipboard().clear();
            Ok(Value::Null)
        }
        "app:copy-to-clipboard" => {
            if let Some(text) = clipboard_text(&arg) {
                let _ = app.clipboard().write_text(text);
            }
            Ok(Value::Null)
        }
        "app:secret-storage-available" => Ok(json!(settings.secret_store_available())),

        "history:get-stats" => Ok(crate::history::get_stats().await),
        "history:clean" => match arg.as_str() {
            Some(service @ ("claude" | "codex")) => Ok(crate::history::clean(&app, service).await),
            _ => Err("history:clean received an unknown service".to_string()),
        },

        "alarm:get-status" => Ok(crate::alarm::report(&app)),
        "alarm:rearm" => {
            crate::alarm::rearm(&app);
            Ok(crate::alarm::report(&app))
        }
        "alarm:test-popup" => {
            crate::alarm::show_test_popup(&app);
            Ok(Value::Null)
        }
        "alarm:request-payload" => Ok(crate::alarm_window::current_payload(&app)),
        "alarm:dismiss" => {
            crate::alarm_window::close(&app);
            Ok(Value::Null)
        }
        "alarm:snooze" => {
            crate::alarm_window::snooze(&app);
            Ok(Value::Null)
        }
        "alarm:fit-size" => {
            crate::alarm_window::fit_height(&app, arg.as_f64().unwrap_or(240.0));
            Ok(Value::Null)
        }

        "update:check" => Ok(updater::check(&app).await),
        "update:download" => {
            updater::download(&app).await;
            Ok(Value::Null)
        }
        "update:install" => {
            updater::install(&app);
            Ok(Value::Null)
        }

        other => Err(format!("unknown channel: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_support_links_are_opened() {
        assert!(is_support_link("https://lin.ee/6XYi49XZ"));
        assert!(!is_support_link("https://example.com"));
        assert!(!is_support_link("https://lin.ee/6XYi49XZ&calc.exe"));
        assert!(!is_support_link("file:///C:/Windows/System32/calc.exe"));
        assert!(!is_support_link(""));
    }
}
