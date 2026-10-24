mod collectors;
mod credentials;
mod i18n;
mod i18n_table;
mod ipc;
mod line;
mod monitor;
mod notify;
mod secrets;
mod popover;
mod settings;
mod time;
mod tray_display;
mod tray_image;
mod tray;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Manager, RunEvent};

static QUITTING: AtomicBool = AtomicBool::new(false);

pub fn run() {
    let app = tauri::Builder::default()
        .manage(popover::PopoverState::default())
        .manage(monitor::MonitorState::default())
        .invoke_handler(tauri::generate_handler![ipc::ipc_invoke])
        .on_window_event(popover::on_window_event)
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            app.manage(settings::SettingsState::load(data_dir.join("settings.json")));
            app.manage(notify::NotifyState::load(data_dir.join("notifications.json")));
            // Menu-bar app: no Dock icon.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            tray::create(app.handle())?;
            popover::init(app.handle());
            monitor::start(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Usage-Pulse");

    app.run(|_app, event| {
        // The popover is closed on purpose after it has been idle (see
        // popover.rs); that must not take the whole app down with it. Only an
        // explicit app.exit() carries an exit code.
        if let RunEvent::ExitRequested { api, code, .. } = event {
            if code.is_none() {
                api.prevent_exit();
            } else if !QUITTING.swap(true, Ordering::SeqCst) {
                // First explicit exit: send the final LINE status, then really quit.
                api.prevent_exit();
                let app = _app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), line::send_status(&app)).await;
                    app.exit(0);
                });
            }
        }
    });
}
