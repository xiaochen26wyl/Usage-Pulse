// The alarm popup: a small always-on-top window in the primary display's
// top-right corner. A port of src/main/alarm-window.ts. Each alert shows its own
// popup; anything arriving while one is on screen waits in a queue.
use std::{collections::VecDeque, sync::Mutex, time::Duration};

use serde_json::Value;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const LABEL: &str = "alarm";
const WIDTH: f64 = 380.0;
const HEIGHT: f64 = 240.0;
const EDGE_MARGIN: f64 = 16.0;
// Mirrors ALARM_POPUP_AUTO_DISMISS_SECONDS and SNOOZE_MS.
const AUTO_DISMISS: Duration = Duration::from_secs(30);
const SNOOZE: Duration = Duration::from_secs(5 * 60);

#[derive(Default)]
struct Inner {
    current: Option<Value>,
    queue: VecDeque<Value>,
    // Bumped on every show / close so a stale auto-dismiss timer can tell it was superseded.
    generation: u64,
    snooze: Option<tauri::async_runtime::JoinHandle<()>>,
}

#[derive(Default)]
pub struct AlarmWindowState {
    inner: Mutex<Inner>,
}

// Always the primary display's top-right corner, recomputed on every show so a
// resolution or monitor change since the last popup cannot leave it off-screen.
fn top_right(app: &AppHandle) -> LogicalPosition<f64> {
    let monitor = app.primary_monitor().ok().flatten();
    monitor.map_or(LogicalPosition::new(EDGE_MARGIN, EDGE_MARGIN), |monitor| {
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        LogicalPosition::new(
            (area.position.x as f64 + area.size.width as f64) / scale - WIDTH - EDGE_MARGIN,
            area.position.y as f64 / scale + EDGE_MARGIN,
        )
    })
}

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

fn create(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let position = top_right(app);
    // A window of its own rather than the popover: that one hides on blur,
    // which is exactly wrong for an alarm.
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("alarm.html".into()))
        .title("Usage-Pulse")
        .inner_size(WIDTH, HEIGHT)
        .position(position.x, position.y)
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .visible(false)
        .focused(false)
        .build()
}

fn display(app: &AppHandle, inner: &mut Inner, payload: Value) {
    inner.current = Some(payload.clone());
    inner.generation += 1;
    let generation = inner.generation;

    let existing = window(app);
    let Some(popup) = existing.clone().or_else(|| create(app).ok()) else { return };
    if existing.is_some() {
        let _ = popup.emit_to(LABEL, "alarm:payload", payload);
        let _ = popup.set_position(top_right(app));
    }
    let _ = popup.set_always_on_top(true);
    let _ = popup.show();

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(AUTO_DISMISS).await;
        let state = app.state::<AlarmWindowState>();
        let still_current = state.inner.lock().expect("alarm window lock poisoned").generation == generation;
        if still_current {
            close(&app);
        }
    });
}

pub fn show(app: &AppHandle, payload: Value) {
    let state = app.state::<AlarmWindowState>();
    let mut inner = state.inner.lock().expect("alarm window lock poisoned");
    if let Some(handle) = inner.snooze.take() {
        handle.abort();
    }
    if inner.current.is_some() && window(app).is_some() {
        inner.queue.push_back(payload);
        return;
    }
    display(app, &mut inner, payload);
}

pub fn current_payload(app: &AppHandle) -> Value {
    let state = app.state::<AlarmWindowState>();
    let inner = state.inner.lock().expect("alarm window lock poisoned");
    inner.current.clone().unwrap_or(Value::Null)
}

fn close_locked(app: &AppHandle, inner: &mut Inner) -> Option<Value> {
    inner.generation += 1;
    let closed = inner.current.take();
    if let Some(popup) = window(app) {
        let _ = popup.hide();
        let _ = popup.destroy();
    }
    if let Some(next) = inner.queue.pop_front() {
        display(app, inner, next);
    }
    closed
}

pub fn close(app: &AppHandle) {
    let state = app.state::<AlarmWindowState>();
    let mut inner = state.inner.lock().expect("alarm window lock poisoned");
    close_locked(app, &mut inner);
}

pub fn snooze(app: &AppHandle) {
    let state = app.state::<AlarmWindowState>();
    let mut inner = state.inner.lock().expect("alarm window lock poisoned");
    let Some(payload) = close_locked(app, &mut inner) else { return };
    if let Some(handle) = inner.snooze.take() {
        handle.abort();
    }
    let task_app = app.clone();
    inner.snooze = Some(tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SNOOZE).await;
        // Let go of our own handle first: show() aborts a pending snooze.
        drop(task_app.state::<AlarmWindowState>().inner.lock().expect("alarm window lock poisoned").snooze.take());
        show(&task_app, payload);
    }));
}

/// The page reports its content height; the window follows it.
pub fn fit_height(app: &AppHandle, height: f64) {
    if let Some(popup) = window(app) {
        let _ = popup.set_size(LogicalSize::new(WIDTH, height.clamp(80.0, 600.0)));
        let _ = popup.set_position(top_right(app));
    }
}

/// Shutdown: drop everything queued and close what is showing.
pub fn destroy(app: &AppHandle) {
    let state = app.state::<AlarmWindowState>();
    let mut inner = state.inner.lock().expect("alarm window lock poisoned");
    if let Some(handle) = inner.snooze.take() {
        handle.abort();
    }
    inner.queue.clear();
    close_locked(app, &mut inner);
}
