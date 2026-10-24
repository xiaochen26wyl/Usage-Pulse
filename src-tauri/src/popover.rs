use std::{
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Rect, Window, WindowEvent, WebviewWindow,
    WebviewWindowBuilder,
};

const LABEL: &str = "main";
const WIDTH: f64 = 460.0;
const HEIGHT_RATIO: f64 = 0.9;
const MIN_HEIGHT: f64 = 400.0;
const HEIGHT_FALLBACK: f64 = 700.0;
// After hiding, the window is kept this long so a quick re-open is instant;
// past that it is closed to give the renderer's memory back.
const IDLE_CLOSE: Duration = Duration::from_secs(60);
// Clicking the tray icon while the popover is open first blurs (hides) it and
// then fires the click; without this guard that click would re-open it.
const BLUR_CLICK_GUARD: Duration = Duration::from_millis(250);

#[derive(Default)]
pub struct PopoverState {
    // Bumped on every show / hide so a stale idle timer can tell it was superseded.
    generation: AtomicU64,
    blurred_at: Mutex<Option<Instant>>,
}

// The window is declared in tauri.conf.json (hidden), so it already exists once
// the app is up: this is the "preload".
pub fn init(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        apply_size(&window, None);
    }
}

// Re-creates the popover from its config after an idle close.
fn ensure_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return Ok(window);
    }
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == LABEL)
        .expect("popover window is declared in tauri.conf.json");
    WebviewWindowBuilder::from_config(app, config)?.build()
}

// Height is 90% of the work area (never under 400), on the display the tray is on.
fn apply_size(window: &WebviewWindow, tray: Option<&Rect>) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let monitor = tray
        .and_then(|rect| {
            let position = rect.position.to_physical::<f64>(scale);
            window.monitor_from_point(position.x, position.y).ok().flatten()
        })
        .or_else(|| window.primary_monitor().ok().flatten());
    let height = monitor.map_or(HEIGHT_FALLBACK, |monitor| {
        let work_height = monitor.work_area().size.height as f64 / monitor.scale_factor();
        (work_height * HEIGHT_RATIO).round().max(MIN_HEIGHT)
    });
    let _ = window.set_size(tauri::LogicalSize::new(WIDTH, height));
}

// Centred under the tray icon (above it when the tray sits at the bottom of the
// screen, as on Windows), clamped inside the display's work area.
fn place(window: &WebviewWindow, tray: &Rect) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let tray_position = tray.position.to_physical::<i32>(scale);
    let tray_size: PhysicalSize<u32> = tray.size.to_physical(scale);
    let Ok(size) = window.outer_size() else { return };
    let Some(monitor) = window
        .monitor_from_point(tray_position.x as f64, tray_position.y as f64)
        .ok()
        .flatten()
    else {
        return;
    };
    let area = monitor.work_area();
    let (left, top) = (area.position.x, area.position.y);
    let (right, bottom) = (left + area.size.width as i32, top + area.size.height as i32);

    let centre_x = tray_position.x + tray_size.width as i32 / 2;
    let x = (centre_x - size.width as i32 / 2).clamp(left, (right - size.width as i32).max(left));
    let tray_at_bottom = tray_position.y > top + area.size.height as i32 / 2;
    let y = if tray_at_bottom {
        tray_position.y - size.height as i32
    } else {
        tray_position.y + tray_size.height as i32
    };
    let y = y.clamp(top, (bottom - size.height as i32).max(top));
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

pub fn show_at(app: &AppHandle, tray: Rect) {
    let Ok(window) = ensure_window(app) else { return };
    app.state::<PopoverState>().generation.fetch_add(1, Ordering::SeqCst);
    apply_size(&window, Some(&tray));
    place(&window, &tray);
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn toggle(app: &AppHandle, tray: Rect) {
    let state = app.state::<PopoverState>();
    let visible = app
        .get_webview_window(LABEL)
        .is_some_and(|window| window.is_visible().unwrap_or(false));
    if visible {
        hide(app);
        return;
    }
    let just_blurred = state
        .blurred_at
        .lock()
        .expect("blur lock poisoned")
        .is_some_and(|at| at.elapsed() < BLUR_CLICK_GUARD);
    if !just_blurred {
        show_at(app, tray);
    }
}

pub fn hide(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else { return };
    let _ = window.hide();
    schedule_idle_close(app);
}

fn schedule_idle_close(app: &AppHandle) {
    let state = app.state::<PopoverState>();
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(IDLE_CLOSE);
        let state = app.state::<PopoverState>();
        if state.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Some(window) = app.get_webview_window(LABEL) {
            if !window.is_visible().unwrap_or(false) {
                let _ = window.close();
            }
        }
    });
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != LABEL {
        return;
    }
    if let WindowEvent::Focused(false) = event {
        let app = window.app_handle();
        *app.state::<PopoverState>().blurred_at.lock().expect("blur lock poisoned") = Some(Instant::now());
        hide(app);
    }
}
