use tauri::{
    AppHandle, Manager,
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use crate::{monitor::MonitorState, popover, settings::SettingsState, time::now_ms, tray_display, tray_image};

const TRAY_ID: &str = "main";
const MENU_OPEN: &str = "open";
const MENU_QUIT: &str = "quit";
#[cfg(windows)]
const MENU_CHECK_UPDATES: &str = "check-updates";

// Mirrors tray.menu.* in src/shared/i18n.ts.
fn menu_labels(language: &str) -> (&'static str, &'static str) {
    match language {
        "en" => ("Open Usage-Pulse", "Quit"),
        "ja" => ("Usage-Pulse を開く", "終了"),
        "ko" => ("Usage-Pulse 열기", "종료"),
        _ => ("開啟 Usage-Pulse", "離開"),
    }
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let language = app.state::<SettingsState>().language();
    let (open_label, quit_label) = menu_labels(&language);
    let open = MenuItem::with_id(app, MENU_OPEN, open_label, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, quit_label, true, None::<&str>)?;
    // Updates are Windows-only (see updater.rs), so is the menu item.
    #[cfg(windows)]
    let menu = {
        let label = crate::i18n::tr(&language, "tray.menu.checkForUpdates");
        let check = MenuItem::with_id(app, MENU_CHECK_UPDATES, label, true, None::<&str>)?;
        Menu::with_items(app, &[&open, &check, &separator, &quit])?
    };
    #[cfg(not(windows))]
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(include_bytes!("../../assets/tray/icon@2x.png"))?)
        .tooltip("Usage-Pulse")
        // Left click toggles the popover; the menu is for right click only.
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            MENU_OPEN => {
                if let Some(rect) = app.tray_by_id(TRAY_ID).and_then(|tray| tray.rect().ok().flatten()) {
                    popover::show_at(app, rect);
                }
            }
            #[cfg(windows)]
            MENU_CHECK_UPDATES => {
                if let Some(rect) = rect(app) {
                    popover::show_at(app, rect);
                }
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::updater::check(&app).await;
                });
            }
            MENU_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                popover::toggle(tray.app_handle(), rect);
            }
        })
        .build(app)?;
    Ok(())
}

// Where the tray icon sits, for placing the popover when something other than a
// tray click (a second launch) asks for it.
pub fn rect(app: &AppHandle) -> Option<tauri::Rect> {
    app.tray_by_id(TRAY_ID).and_then(|tray| tray.rect().ok().flatten())
}

fn enabled_services(settings: &SettingsState) -> Vec<&'static str> {
    let services: Vec<&'static str> = [("cursor", "enableCursorMonitoring"), ("claude", "enableClaudeMonitoring"), ("codex", "enableCodexMonitoring")]
        .into_iter()
        .filter(|(_, flag)| settings.flag(flag))
        .map(|(service, _)| service)
        .collect();
    if services.is_empty() { vec!["cursor", "claude", "codex"] } else { services }
}

/// Redraws the menu-bar image from the latest snapshot (macOS only, like the
/// Electron build: elsewhere the tooltip is the display).
pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let settings = app.state::<SettingsState>();
    let latest = app.state::<MonitorState>().latest();
    let enabled = enabled_services(&settings);
    let columns = tray_display::columns(
        (!latest.is_null()).then_some(&latest),
        &enabled,
        settings.flag("showWeeklyInTray"),
        &settings.language(),
        now_ms(),
    );
    if cfg!(target_os = "macos") {
        if let Some((rgba, width, height)) = tray_image::render(&columns) {
            let _ = tray.set_icon(Some(Image::new_owned(rgba, width, height)));
            let _ = tray.set_icon_as_template(false);
        }
    }
    let lines: Vec<String> = std::iter::once("Usage-Pulse".to_string())
        .chain(columns.iter().map(|column| format!("{}: {}", column.label, column.value)))
        .collect();
    let _ = tray.set_tooltip(Some(lines.join("\n")));
}

/// True while a countdown (a spent window) is on screen and needs a per-minute redraw.
pub fn countdown_on_screen(app: &AppHandle) -> bool {
    let latest = app.state::<MonitorState>().latest();
    !latest.is_null() && tray_display::has_countdown(&latest, &enabled_services(&app.state::<SettingsState>()))
}
