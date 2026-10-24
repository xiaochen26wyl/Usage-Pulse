// LINE notifications: Flex bubbles broadcast to the user's own official account.
// A port of src/shared/line-templates.ts, src/main/line-notifier.ts and
// src/shared/quit-status.ts. LINE is a best-effort side channel: nothing here
// ever reports failure to the caller beyond a boolean.
use std::time::Duration;

use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::{
    i18n::{fill, tr},
    monitor::MonitorState,
    settings::SettingsState,
    time::{local_text_from_iso, now_iso, now_ms},
    tray_display,
};

const BROADCAST_URL: &str = "https://api.line.me/v2/bot/message/broadcast";
const MAX_TEXT_LENGTH: usize = 5000;
// LINE rejects a Flex message whose altText is longer than this.
const MAX_ALT_TEXT_LENGTH: usize = 400;

const BUBBLE_BG: &str = "#FFFFFF";
const TEXT_COLOR: &str = "#1F2328";
const TEXT_MUTED: &str = "#6E7681";
pub const EXHAUSTED_RED: &str = "#E5484D";

// Mirrors SERVICE_ACCENT in line-templates.ts (a white bubble cannot read the app's CSS).
fn accent(service: &str) -> &'static str {
    match service {
        "cursor" => "#1F2328",
        "claude" => "#E8945A",
        _ => "#3F87F7",
    }
}

pub fn service_label(service: &str) -> &'static str {
    match service {
        "cursor" => "Cursor",
        "claude" => "Claude Code",
        _ => "Codex",
    }
}

// JavaScript's number-to-string: 14 not 14.0, 14.5 stays.
fn js_number(value: f64) -> String {
    if value.fract() == 0.0 { format!("{}", value as i64) } else { format!("{value}") }
}

fn row(label: &str, value: &str) -> Value {
    json!({
        "type": "box", "layout": "baseline", "spacing": "sm",
        "contents": [
            { "type": "text", "text": label, "size": "sm", "color": TEXT_MUTED, "flex": 2 },
            { "type": "text", "text": value, "size": "sm", "color": TEXT_COLOR, "weight": "bold", "flex": 5, "wrap": true }
        ]
    })
}

struct Bubble<'a> {
    accent: &'a str,
    alt_text: String,
    title: &'a str,
    subtitle: String,
    rows: Vec<(String, String)>,
    note: Option<&'a str>,
    language: &'a str,
}

fn bubble(options: Bubble) -> Value {
    let mut contents = vec![
        json!({
            "type": "box", "layout": "vertical", "height": "5px", "cornerRadius": "3px",
            "backgroundColor": options.accent, "contents": [{ "type": "filler" }]
        }),
        json!({ "type": "text", "text": options.title, "weight": "bold", "size": "lg", "color": options.accent, "wrap": true }),
        json!({ "type": "text", "text": options.subtitle, "size": "sm", "color": TEXT_COLOR, "wrap": true }),
    ];
    contents.extend(options.rows.iter().map(|(label, value)| row(label, value)));
    if let Some(note) = options.note {
        contents.push(json!({ "type": "text", "text": note, "size": "sm", "color": TEXT_COLOR, "wrap": true }));
    }
    let now = local_text_from_iso(&now_iso()).unwrap_or_default();
    contents.push(json!({
        "type": "text", "text": fill(tr(options.language, "line.tpl.footer"), &[("time", &now)]),
        "size": "xxs", "color": TEXT_MUTED
    }));
    json!({
        "type": "flex",
        // The phone's push banner shows only altText, so it carries the whole message.
        "altText": options.alt_text,
        "contents": {
            "type": "bubble", "size": "kilo",
            "body": {
                "type": "box", "layout": "vertical", "backgroundColor": BUBBLE_BG,
                "paddingAll": "16px", "spacing": "md", "contents": contents
            }
        }
    })
}

pub struct QuotaOptions<'a> {
    pub service: &'a str,
    pub window_label: &'a str,
    /// Always *remaining* percent.
    pub remaining_percent: Option<f64>,
    pub threshold_percent: Option<f64>,
    pub reset_at: Option<&'a str>,
    pub language: &'a str,
}

fn remaining_rows(options: &QuotaOptions, remaining_text: &str, with_threshold: bool) -> Vec<(String, String)> {
    let language = options.language;
    let mut rows = vec![(tr(language, "line.tpl.remaining").to_string(), remaining_text.to_string())];
    if let (true, Some(threshold)) = (with_threshold, options.threshold_percent) {
        rows.push((tr(language, "line.tpl.threshold").to_string(), format!("{}%", js_number(threshold))));
    }
    if let Some(text) = options.reset_at.and_then(local_text_from_iso) {
        rows.push((tr(language, "line.tpl.resetAt").to_string(), text));
    }
    rows
}

fn remaining_text(options: &QuotaOptions) -> String {
    options
        .remaining_percent
        .map_or_else(|| tr(options.language, "app.unknown").to_string(), |value| format!("{}%", js_number(value)))
}

pub fn low_quota(options: &QuotaOptions) -> Value {
    let (label, language) = (service_label(options.service), options.language);
    let remaining = remaining_text(options);
    bubble(Bubble {
        accent: accent(options.service),
        alt_text: fill(
            tr(language, "line.tpl.altLow"),
            &[
                ("service", label),
                ("label", options.window_label),
                ("remaining", &remaining.replace('%', "")),
                ("threshold", &js_number(options.threshold_percent.unwrap_or(0.0))),
            ],
        ),
        title: tr(language, "line.tpl.lowTitle"),
        subtitle: format!("{label} · {}", options.window_label),
        rows: remaining_rows(options, &remaining, true),
        note: None,
        language,
    })
}

pub fn recovered(options: &QuotaOptions) -> Value {
    let (label, language) = (service_label(options.service), options.language);
    let remaining = remaining_text(options);
    bubble(Bubble {
        accent: accent(options.service),
        alt_text: fill(
            tr(language, "line.tpl.altRecovered"),
            &[("service", label), ("label", options.window_label), ("remaining", &remaining.replace('%', ""))],
        ),
        title: tr(language, "line.tpl.recoveredTitle"),
        subtitle: format!("{label} · {}", options.window_label),
        rows: remaining_rows(options, &remaining, false),
        note: None,
        language,
    })
}

pub fn exhausted(options: &QuotaOptions) -> Value {
    let (label, language) = (service_label(options.service), options.language);
    bubble(Bubble {
        accent: EXHAUSTED_RED,
        alt_text: fill(tr(language, "line.tpl.altExhausted"), &[("service", label), ("label", options.window_label)]),
        title: tr(language, "line.tpl.exhaustedTitle"),
        subtitle: format!("{label} · {}", options.window_label),
        rows: remaining_rows(options, "0%", false),
        note: None,
        language,
    })
}

/// Anything that is not a quota threshold: credential expiry, reset alarms.
pub fn plain_alert(service: &str, title: &str, body: &str, language: &str) -> Value {
    bubble(Bubble {
        accent: accent(service),
        alt_text: format!("{title} — {body}"),
        title,
        subtitle: service_label(service).to_string(),
        rows: Vec::new(),
        note: Some(body),
        language,
    })
}

fn quit_status(service: &str, window_label: &str, value: &str, reset_at: Option<&str>, language: &str) -> Value {
    let label = service_label(service);
    let mut rows = vec![(tr(language, "line.tpl.remaining").to_string(), value.to_string())];
    if let Some(text) = reset_at.and_then(local_text_from_iso) {
        rows.push((tr(language, "line.tpl.resetAt").to_string(), text));
    }
    bubble(Bubble {
        accent: accent(service),
        alt_text: fill(tr(language, "line.tpl.altQuit"), &[("service", label), ("label", window_label), ("value", value)]),
        title: tr(language, "line.tpl.quitTitle"),
        subtitle: format!("{label} · {window_label}"),
        rows,
        note: None,
        language,
    })
}

/// Several bubbles as one swipeable message; a lone bubble is returned as is.
pub fn carousel(mut bubbles: Vec<Value>) -> Value {
    if bubbles.len() == 1 {
        return bubbles.remove(0);
    }
    let alt: String = bubbles.iter().filter_map(|entry| entry["altText"].as_str()).collect::<Vec<_>>().join("\n");
    json!({
        "type": "flex",
        "altText": alt.chars().take(MAX_ALT_TEXT_LENGTH).collect::<String>(),
        "contents": { "type": "carousel", "contents": bubbles.iter().map(|entry| entry["contents"].clone()).collect::<Vec<_>>() }
    })
}

/// True when any of the service's reminders has LINE ticked (isLineEnabled).
pub fn line_enabled(settings: &SettingsState, service: &str) -> bool {
    let channels = settings.value("alertChannels");
    channels.as_object().is_some_and(|map| {
        map.iter().any(|(key, channel)| key.starts_with(&format!("{service}-")) && channel["line"].as_bool().unwrap_or(false))
    })
}

pub enum Target<'a> {
    /// One reminder's own LINE checkbox.
    Alert(&'a str),
    /// A message belonging to the service as a whole.
    Service(&'a str),
    /// Skip the check (test button, quit status).
    Force,
}

/// Broadcasts one message. Never fails loudly: a stale token or a network blip
/// must not take down the monitor that called this.
pub async fn broadcast(app: &AppHandle, mut message: Value, target: Target<'_>) -> bool {
    let settings = app.state::<SettingsState>();
    let allowed = match target {
        Target::Alert(alert) => settings.alert_channel(alert, "line"),
        Target::Service(service) => line_enabled(&settings, service),
        Target::Force => true,
    };
    let token = settings.string("lineChannelAccessToken");
    let token = token.trim();
    if !allowed || token.is_empty() {
        return false;
    }
    if message["type"] == "text" {
        if let Some(text) = message["text"].as_str() {
            message["text"] = json!(text.chars().take(MAX_TEXT_LENGTH).collect::<String>());
        }
    }
    let client = &app.state::<MonitorState>().http;
    client
        .post(BROADCAST_URL)
        .bearer_auth(token)
        .timeout(Duration::from_secs(15))
        .json(&json!({ "messages": [message] }))
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

/// Fire-and-forget from synchronous code.
pub fn broadcast_in_background(app: &AppHandle, message: Value, target: OwnedTarget) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let borrowed = match &target {
            OwnedTarget::Alert(alert) => Target::Alert(alert),
            OwnedTarget::Service(service) => Target::Service(service),
        };
        broadcast(&app, message, borrowed).await;
    });
}

pub enum OwnedTarget {
    Alert(String),
    Service(String),
}

pub async fn send_test(app: &AppHandle) -> bool {
    let settings = app.state::<SettingsState>();
    if settings.string("lineChannelAccessToken").trim().is_empty() {
        return false;
    }
    let language = settings.language();
    let time = local_text_from_iso(&now_iso()).unwrap_or_default();
    let text = fill(tr(&language, "line.testMessage"), &[("time", &time)]);
    broadcast(app, json!({ "type": "text", "text": text }), Target::Force).await
}

/// The "final status" message: one card per window still worth reporting, from
/// the cached snapshot only (never fetches).
pub async fn send_status(app: &AppHandle) -> bool {
    let settings = app.state::<SettingsState>();
    let snapshot = app.state::<MonitorState>().latest();
    if snapshot.is_null() {
        return false;
    }
    let language = settings.language();
    let now = now_ms();
    let mut cards = Vec::new();

    if settings.flag("enableCursorMonitoring") && line_enabled(&settings, "cursor") {
        let value = tray_display::cursor_overall_text(&snapshot["cursor"], now);
        if value != "?" {
            cards.push(quit_status("cursor", tr(&language, "window.label.cursorOverall"), &value, snapshot["cursor"]["resetsAt"].as_str(), &language));
        }
    }
    for (service, flag) in [("claude", "enableClaudeMonitoring"), ("codex", "enableCodexMonitoring")] {
        if !(settings.flag(flag) && line_enabled(&settings, service)) {
            continue;
        }
        let current = &snapshot[service];
        let weekly = if service == "claude" { tray_display::claude_weekly(current) } else { tray_display::codex_weekly(current) };
        for (window, fallback_label, text) in [
            (tray_display::session_window(current), "window.label.session", Some(tray_display::session_text(current, now))),
            (weekly, "window.label.weekly", weekly.and_then(|window| tray_display::weekly_text(window, now))),
        ] {
            let Some(window) = window.filter(|window| !window["remaining"].is_null()) else { continue };
            let label = window["label"].as_str().filter(|label| !label.is_empty()).unwrap_or_else(|| tr(&language, fallback_label));
            if let Some(text) = text {
                cards.push(quit_status(service, label, &text, window["resetsAt"].as_str(), &language));
            }
        }
    }
    if cards.is_empty() {
        return false;
    }
    broadcast(app, carousel(cards), Target::Force).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(remaining: Option<f64>) -> QuotaOptions<'static> {
        QuotaOptions { service: "claude", window_label: "5-hour window", remaining_percent: remaining, threshold_percent: Some(20.0), reset_at: None, language: "en" }
    }

    #[test]
    fn numbers_print_like_javascript() {
        assert_eq!(js_number(14.0), "14");
        assert_eq!(js_number(14.5), "14.5");
    }

    #[test]
    fn low_quota_bubble_carries_the_alt_text_and_accent() {
        let message = low_quota(&options(Some(14.0)));
        assert_eq!(message["altText"], "Claude Code · 5-hour window has 14% left, below the 20% threshold");
        assert_eq!(message["contents"]["body"]["contents"][1]["color"], "#E8945A");
    }

    #[test]
    fn a_lone_bubble_is_not_wrapped_but_several_become_a_carousel() {
        let one = low_quota(&options(Some(10.0)));
        assert_eq!(carousel(vec![one.clone()]), one);
        let many = carousel(vec![one.clone(), exhausted(&options(None))]);
        assert_eq!(many["contents"]["type"], "carousel");
        assert_eq!(many["contents"]["contents"].as_array().map(Vec::len), Some(2));
        assert!(many["altText"].as_str().is_some_and(|alt| alt.len() <= MAX_ALT_TEXT_LENGTH));
    }
}
