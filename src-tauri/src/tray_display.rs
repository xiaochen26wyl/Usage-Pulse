// What the menu bar shows. A port of the display half of src/shared/tray-display.ts
// (the 10-minute weekly cache is not ported: values are recomputed on each redraw).
use serde_json::Value;

use crate::time::parse_iso_ms;

pub type Rgb = (u8, u8, u8);

// Mirrors src/shared/tray-value-color.ts.
pub const BACKGROUND: Rgb = (0x18, 0x1D, 0x25);
pub const VALUE_COLOR: Rgb = (0xFF, 0xFF, 0xFF);
const CURSOR_LABEL: Rgb = (0xC0, 0x84, 0xFC);
const CLAUDE_LABEL: Rgb = (0xE8, 0x94, 0x5A);
const CODEX_LABEL: Rgb = (0x3F, 0x87, 0xF7);
const WEEKLY: Rgb = (0xFA, 0xCC, 0x15);
const WEEKLY_LOW: Rgb = (0xFF, 0x5A, 0x5A);
const WEEKLY_LOW_THRESHOLD_PERCENT: f64 = 5.0;

pub struct Column {
    pub label: &'static str,
    pub label_color: Rgb,
    pub value: String,
    pub weekly: Option<(String, Rgb)>,
}

fn unknown_text(language: &str) -> &'static str {
    if language == "zh" { "未知" } else { "N/A" }
}

fn window<'a>(snapshot: &'a Value, key: &str) -> Option<&'a Value> {
    snapshot["windows"].as_array()?.iter().find(|window| window["key"] == key)
}

fn claude_weekly_window(snapshot: &Value) -> Option<&Value> {
    ["weekly_all", "weekly_scoped", "weekly"].iter().find_map(|key| window(snapshot, key))
}

fn remaining_of(window: Option<&Value>) -> Option<f64> {
    window?["remaining"].as_f64()
}

fn rounded(value: f64) -> i64 {
    value.round() as i64
}

fn snapshot_value_text(snapshot: &Value) -> String {
    match snapshot["unit"].as_str() {
        Some("usd") => snapshot["remaining"].as_f64().map_or("?".into(), |value| format!("${value:.1}")),
        Some("percent") => snapshot["remaining"]
            .as_f64()
            .or_else(|| snapshot["percent"].as_f64())
            .map_or("?".into(), |value| format!("{}%", rounded(value))),
        _ => snapshot["remaining"].as_f64().map_or("?".into(), |value| value.to_string()),
    }
}

fn reset_ms(resets_at: &Value) -> Option<i64> {
    parse_iso_ms(resets_at.as_str()?)
}

fn format_countdown(resets_at: &Value, now_ms: i64) -> Option<String> {
    let remaining = reset_ms(resets_at)? - now_ms;
    if remaining <= 0 {
        return None;
    }
    let hours = remaining as f64 / 3_600_000.0;
    Some(if hours >= 1.0 { format!("{hours:.1}h") } else { format!("{}m", rounded(remaining as f64 / 60_000.0).max(1)) })
}

fn format_countdown_with_days(resets_at: &Value, now_ms: i64) -> Option<String> {
    let days = (reset_ms(resets_at)? - now_ms) as f64 / 86_400_000.0;
    if days >= 1.0 { Some(format!("{}d", rounded(days))) } else { format_countdown(resets_at, now_ms) }
}

// Cursor's windows store *used* percent; the menu bar speaks in remaining.
fn cursor_remaining(snapshot: &Value, key: &str) -> Option<f64> {
    let used = window(snapshot, key)?["percent"].as_f64()?;
    Some((100.0 - used).clamp(0.0, 100.0))
}

fn cursor_window_text(remaining: f64, snapshot: &Value, now_ms: i64) -> String {
    if rounded(remaining) <= 0 {
        format_countdown_with_days(&snapshot["resetsAt"], now_ms).unwrap_or_else(|| "0%".into())
    } else {
        format!("{}%", rounded(remaining))
    }
}

/// cursorTrayValueText: the single overall figure, with its fallback chain.
pub fn cursor_overall_text(snapshot: &Value, now_ms: i64) -> String {
    let models = cursor_remaining(snapshot, "cursor_models");
    let advanced = cursor_remaining(snapshot, "other_models");
    for remaining in [models, advanced].into_iter().flatten() {
        if rounded(remaining) > 0 {
            return format!("{}%", rounded(remaining));
        }
    }
    if models.is_some() || advanced.is_some() {
        return format_countdown_with_days(&snapshot["resetsAt"], now_ms).unwrap_or_else(|| "0%".into());
    }
    snapshot_value_text(snapshot)
}

pub fn session_text(snapshot: &Value, now_ms: i64) -> String {
    session_value(snapshot, now_ms)
}

pub fn weekly_text(window: &Value, now_ms: i64) -> Option<String> {
    weekly_value(window, now_ms).map(|(text, _)| text)
}

pub fn claude_weekly(snapshot: &Value) -> Option<&Value> {
    claude_weekly_window(snapshot)
}

pub fn codex_weekly(snapshot: &Value) -> Option<&Value> {
    window(snapshot, "weekly")
}

pub fn session_window(snapshot: &Value) -> Option<&Value> {
    window(snapshot, "session")
}

fn cursor_value(snapshot: &Value, now_ms: i64) -> String {
    let models = cursor_remaining(snapshot, "cursor_models");
    let advanced = cursor_remaining(snapshot, "other_models");
    if let (Some(models), Some(_)) = (models, advanced) {
        return cursor_window_text(models, snapshot, now_ms);
    }
    for remaining in [models, advanced].into_iter().flatten() {
        if rounded(remaining) > 0 {
            return format!("{}%", rounded(remaining));
        }
    }
    if models.is_some() || advanced.is_some() {
        return format_countdown_with_days(&snapshot["resetsAt"], now_ms).unwrap_or_else(|| "0%".into());
    }
    snapshot_value_text(snapshot)
}

fn cursor_second(snapshot: &Value, now_ms: i64) -> Option<(String, f64)> {
    let advanced = cursor_remaining(snapshot, "other_models")?;
    cursor_remaining(snapshot, "cursor_models")?;
    Some((cursor_window_text(advanced, snapshot, now_ms), advanced))
}

fn session_value(snapshot: &Value, now_ms: i64) -> String {
    match remaining_of(window(snapshot, "session")) {
        Some(remaining) if rounded(remaining) <= 0 => format_countdown(&window(snapshot, "session").unwrap()["resetsAt"], now_ms).unwrap_or_else(|| "0%".into()),
        Some(remaining) => format!("{}%", rounded(remaining)),
        None => snapshot_value_text(snapshot),
    }
}

fn weekly_value(window: &Value, now_ms: i64) -> Option<(String, f64)> {
    let remaining = window["remaining"].as_f64()?;
    let text = if rounded(remaining) <= 0 {
        format_countdown_with_days(&window["resetsAt"], now_ms).unwrap_or_else(|| "0%".into())
    } else {
        format!("{}%", rounded(remaining))
    };
    Some((text, remaining))
}

fn weekly_color(remaining: f64) -> Rgb {
    if rounded(remaining) as f64 <= WEEKLY_LOW_THRESHOLD_PERCENT { WEEKLY_LOW } else { WEEKLY }
}

/// Reset time a countdown on screen ticks against; None while only percentages show.
pub fn has_countdown(combined: &Value, enabled: &[&str]) -> bool {
    let spent = |remaining: Option<f64>| remaining.is_none_or(|value| rounded(value) <= 0);
    enabled.iter().any(|service| {
        let snapshot = &combined[*service];
        if *service == "cursor" {
            let (models, advanced) = (cursor_remaining(snapshot, "cursor_models"), cursor_remaining(snapshot, "other_models"));
            let any = models.is_some() || advanced.is_some();
            let shows = if models.is_some() && advanced.is_some() { spent(models) || spent(advanced) } else { spent(models) && spent(advanced) };
            return any && shows && snapshot["resetsAt"].is_string();
        }
        remaining_of(window(snapshot, "session")).is_some_and(|remaining| rounded(remaining) <= 0) && window(snapshot, "session").is_some_and(|w| w["resetsAt"].is_string())
    })
}

pub fn columns(combined: Option<&Value>, enabled: &[&str], show_weekly: bool, language: &str, now_ms: i64) -> Vec<Column> {
    let localize = |text: String| if text == "?" { unknown_text(language).to_string() } else { text };
    enabled
        .iter()
        .map(|service| {
            let (label, label_color) = match *service {
                "cursor" => ("Cursor", CURSOR_LABEL),
                "claude" => ("Claude", CLAUDE_LABEL),
                _ => ("Codex", CODEX_LABEL),
            };
            let Some(combined) = combined else {
                return Column { label, label_color, value: unknown_text(language).into(), weekly: None };
            };
            let snapshot = &combined[*service];
            let value = localize(match *service {
                "cursor" => cursor_value(snapshot, now_ms),
                _ => session_value(snapshot, now_ms),
            });
            let second = if !show_weekly {
                None
            } else {
                match *service {
                    "cursor" => cursor_second(snapshot, now_ms),
                    "claude" => claude_weekly_window(snapshot).and_then(|w| weekly_value(w, now_ms)),
                    _ => window(snapshot, "weekly").and_then(|w| weekly_value(w, now_ms)),
                }
            };
            Column { label, label_color, value, weekly: second.map(|(text, remaining)| (localize(text), weekly_color(remaining))) }
        })
        .collect()
}
