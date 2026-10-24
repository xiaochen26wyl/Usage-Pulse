use serde_json::{Map, Value, json};

use super::{Scrape, clamp_percent, to_iso_time, to_number};
use crate::{
    credentials::{self, CredentialError},
    i18n::{fill, tr},
    time::now_ms,
};

const USAGE_URLS: [&str; 2] = [
    "https://chatgpt.com/backend-api/wham/usage",
    "https://chatgpt.com/backend-api/codex/usage",
];
const SESSION_WINDOW_SECONDS: f64 = 5.0 * 60.0 * 60.0;
const WEEKLY_WINDOW_SECONDS: f64 = 7.0 * 24.0 * 60.0 * 60.0;
const DURATION_TOLERANCE: f64 = 0.12;

#[derive(Default)]
struct Slots {
    session: bool,
    weekly: bool,
}

struct CodexWindow {
    key: String,
    label: String,
    used_percent: Option<f64>,
    resets_at: Option<String>,
}

fn near(seconds: f64, target: f64) -> bool {
    (seconds - target).abs() / target <= DURATION_TOLERANCE
}

fn first_number(raw: &Value, fields: &[&str]) -> Option<f64> {
    fields.iter().find_map(|field| to_number(raw.get(*field)))
}

fn window_seconds(raw: &Value) -> Option<f64> {
    first_number(raw, &["limit_window_seconds", "limitWindowSeconds", "window_seconds", "windowSeconds"])
        .filter(|seconds| *seconds > 0.0)
        .or_else(|| {
            first_number(raw, &["limit_window_minutes", "limitWindowMinutes", "window_duration_mins", "windowDurationMins"])
                .filter(|minutes| *minutes > 0.0)
                .map(|minutes| minutes * 60.0)
        })
}

fn used_percent_of(raw: &Value) -> Option<f64> {
    ["used_percent", "usedPercent", "utilization", "percentUsed"]
        .iter()
        .find_map(|field| to_number(raw.get(*field)))
        .map(clamp_percent)
}

fn direct_reset(raw: &Value) -> Option<String> {
    ["reset_at", "resetAt", "resets_at", "resetsAt"].iter().find_map(|field| to_iso_time(raw.get(*field)))
}

fn reset_after_seconds(raw: &Value) -> Option<f64> {
    first_number(raw, &["reset_after_seconds", "resetAfterSeconds", "reset_after"]).filter(|seconds| *seconds >= 0.0)
}

fn reset_seconds_remaining(raw: &Value, now: i64) -> Option<f64> {
    if let Some(direct) = direct_reset(raw) {
        let diff = (crate::time::parse_iso_ms(&direct)? - now) as f64 / 1000.0;
        return (diff >= 0.0).then_some(diff);
    }
    reset_after_seconds(raw)
}

fn resets_at_of(raw: &Value, now: i64) -> Option<String> {
    direct_reset(raw).or_else(|| reset_after_seconds(raw).map(|after| crate::time::iso_from_ms(now + (after * 1000.0) as i64)))
}

fn raw_name_of(raw: &Value) -> String {
    ["name", "id", "type", "model", "window", "limit", "key"]
        .iter()
        .find_map(|field| match raw.get(*field)? {
            Value::String(text) => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn slug(name: &str) -> String {
    let mut out = String::new();
    for ch in name.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() { "unknown".into() } else { trimmed.to_string() }
}

fn is_primary(name: &str) -> bool {
    matches!(slug(name).as_str(), "primary" | "primary_window")
}

fn is_secondary(name: &str) -> bool {
    matches!(slug(name).as_str(), "secondary" | "secondary_window")
}

fn longer_than_session(remaining: Option<f64>) -> bool {
    remaining.is_some_and(|seconds| seconds > SESSION_WINDOW_SECONDS * (1.0 + DURATION_TOLERANCE))
}

fn classify_key(seconds: Option<f64>, raw_name: &str, taken: &Slots, remaining: Option<f64>) -> String {
    if let Some(seconds) = seconds {
        if near(seconds, SESSION_WINDOW_SECONDS) && !taken.session {
            return "session".into();
        }
        if near(seconds, WEEKLY_WINDOW_SECONDS) && !taken.weekly {
            return "weekly".into();
        }
    }
    if seconds.is_none() && longer_than_session(remaining) && !taken.weekly && (is_primary(raw_name) || is_secondary(raw_name)) {
        return "weekly".into();
    }
    let lower = raw_name.to_lowercase();
    if !taken.session
        && (lower.contains("five_hour") || lower.contains("five-hour") || lower.contains("5h") || is_primary(raw_name))
        && seconds.is_none_or(|seconds| near(seconds, SESSION_WINDOW_SECONDS))
        && !longer_than_session(remaining)
    {
        return "session".into();
    }
    if !taken.weekly
        && (lower.contains("seven_day") || lower.contains("weekly") || lower.contains("7d") || is_secondary(raw_name))
        && seconds.is_none_or(|seconds| near(seconds, WEEKLY_WINDOW_SECONDS))
    {
        return "weekly".into();
    }
    slug(raw_name)
}

fn label_for(key: &str, raw_name: &str, language: &str) -> String {
    match key {
        "session" => tr(language, "window.label.session").to_string(),
        "weekly" => tr(language, "window.label.weekly").to_string(),
        key if key.contains("code_review") => tr(language, "window.label.codexCodeReview").to_string(),
        key => {
            let name = raw_name.trim();
            if name.is_empty() { key.to_string() } else { name.to_string() }
        }
    }
}

fn parse_window(raw: &Value, language: &str, now: i64, slots: &mut Slots) -> Option<CodexWindow> {
    let used = used_percent_of(raw);
    let seconds = window_seconds(raw);
    let remaining = reset_seconds_remaining(raw, now);
    let raw_name = raw_name_of(raw);
    if used.is_none() && seconds.is_none() && raw_name.is_empty() {
        return None;
    }
    let mut key = classify_key(seconds, &raw_name, slots, remaining);
    if key != "session" && key != "weekly" && (is_primary(&raw_name) || is_secondary(&raw_name)) {
        return None;
    }
    if key == "unknown" {
        key = slug(&format!("window_{}", seconds.map_or("x".to_string(), |seconds| seconds.to_string())));
    }
    match key.as_str() {
        "session" => slots.session = true,
        "weekly" => slots.weekly = true,
        _ => {}
    }
    Some(CodexWindow { label: label_for(&key, &raw_name, language), key, used_percent: used, resets_at: resets_at_of(raw, now) })
}

fn looks_like_window(raw: &Value) -> bool {
    used_percent_of(raw).is_some()
        || window_seconds(raw).is_some()
        || ["reset_at", "resetAt", "reset_after_seconds"].iter().any(|field| raw.get(*field).is_some_and(|value| !value.is_null()))
}

fn collect_from(value: &Value, language: &str, now: i64, slots: &mut Slots, into: &mut Vec<CodexWindow>, parent: &str) {
    match value {
        Value::Array(entries) => {
            for entry in entries {
                collect_from(entry, language, now, slots, into, parent);
            }
        }
        Value::Object(map) => {
            if looks_like_window(value) {
                let mut named = value.clone();
                if !parent.is_empty() && raw_name_of(value).is_empty() {
                    named["name"] = json!(parent);
                }
                if let Some(parsed) = parse_window(&named, language, now, slots) {
                    into.push(parsed);
                }
                return;
            }
            for (key, nested) in map {
                if matches!(key.as_str(), "credits" | "spend_control" | "plan_type") {
                    continue;
                }
                collect_from(nested, language, now, slots, into, key);
            }
        }
        _ => {}
    }
}

fn extract_windows(payload: &Value, language: &str, now: i64) -> Vec<CodexWindow> {
    let mut windows = Vec::new();
    let mut slots = Slots::default();
    let rate_limit = ["rate_limit", "rateLimit", "rate_limits"]
        .iter()
        .find_map(|field| payload.get(*field).filter(|value| value.is_object()));
    if let Some(rate_limit) = rate_limit {
        collect_from(rate_limit, language, now, &mut slots, &mut windows, "");
    }
    let additional = payload.get("additional_rate_limits").or_else(|| payload.get("additionalRateLimits"));
    collect_from(additional.unwrap_or(&Value::Null), language, now, &mut slots, &mut windows, "additional");
    let review = payload.get("code_review_rate_limit").or_else(|| payload.get("codeReviewRateLimit"));
    collect_from(review.unwrap_or(&Value::Null), language, now, &mut slots, &mut windows, "code_review");
    if windows.is_empty() {
        collect_from(payload, language, now, &mut slots, &mut windows, "");
    }
    windows
}

fn credits_text(payload: &Value, language: &str) -> Option<String> {
    let credits = payload.get("credits").filter(|value| value.is_object())?;
    if credits.get("unlimited") == Some(&json!(true)) {
        return Some(tr(language, "window.codexCredits.unlimited").to_string());
    }
    let balance = match credits.get("balance") {
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::String(text)) if !text.trim().is_empty() => text.trim().to_string(),
        _ if credits.get("has_credits") == Some(&json!(true)) => tr(language, "app.unknown").to_string(),
        _ => "0".to_string(),
    };
    Some(fill(tr(language, "window.codexCredits.balance"), &[("balance", &balance)]))
}

fn build_scrape(payload: &Value, language: &str, now: i64) -> Scrape {
    let limits = extract_windows(payload, language, now);
    let credits = credits_text(payload, language);
    let mut extra = Map::new();
    extra.insert("source".into(), json!("api"));
    extra.insert("creditsText".into(), json!(credits));
    if limits.is_empty() && credits.is_none() {
        let mut scrape = Scrape::failure("percent", tr(language, "error.codexMissingFields"));
        scrape.is_error = false;
        scrape.extra = extra;
        return scrape;
    }
    let windows: Vec<Value> = limits
        .iter()
        .map(|item| {
            let remaining = item.used_percent.map(|used| clamp_percent(100.0 - used));
            json!({
                "key": item.key, "label": item.label, "remaining": remaining,
                "total": item.used_percent.map(|_| 100), "percent": remaining,
                "resetsAt": item.resets_at, "message": tr(language, "window.message.codexSource")
            })
        })
        .collect();
    let find = |key: &str| windows.iter().find(|window| window["key"] == key);
    let session = find("session");
    let weekly = find("weekly");
    let session_remaining = session.and_then(|window| window["remaining"].as_f64());
    let weekly_remaining = weekly.and_then(|window| window["remaining"].as_f64());
    let remaining = session_remaining.or(weekly_remaining);
    let text = |value: Option<f64>| value.map_or_else(|| "N/A".to_string(), |value| format!("{}%", value.round() as i64));
    extra.insert("weeklyResetAt".into(), weekly.map_or(Value::Null, |window| window["resetsAt"].clone()));
    Scrape {
        remaining,
        total: remaining.map(|_| 100.0),
        unit: "percent",
        resets_at: session.and_then(|window| window["resetsAt"].as_str().map(str::to_string)),
        message: fill(tr(language, "message.codexSummary"), &[("session", &text(session_remaining)), ("weekly", &text(weekly_remaining))]),
        windows,
        is_error: false,
        extra,
    }
}

async fn fetch_payload(client: &reqwest::Client, token: &str, account_id: Option<&str>) -> Result<Value, Option<u16>> {
    let mut last: Option<u16> = None;
    for url in USAGE_URLS {
        let mut request = client
            .get(url)
            .bearer_auth(token)
            .header("Accept", "application/json")
            .header("originator", "Codex Desktop")
            .header("OAI-Product-Sku", "CODEX");
        if let Some(account) = account_id {
            request = request.header("ChatGPT-Account-Id", account);
        }
        match request.send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                if (200..300).contains(&status) {
                    if let Ok(payload) = response.json::<Value>().await {
                        if payload.is_object() {
                            return Ok(payload);
                        }
                    }
                } else if status == 401 || status == 403 {
                    return Err(Some(status));
                } else {
                    last = Some(status);
                }
            }
            Err(_) => last = None,
        }
    }
    Err(last)
}

pub async fn collect(client: &reqwest::Client, language: &str) -> Scrape {
    let auth = match credentials::codex::resolve(client).await {
        Ok(auth) => auth,
        Err(CredentialError::Missing) => return Scrape::failure("percent", tr(language, "error.codexCredentialMissing")),
        Err(CredentialError::ReadFailed) => return Scrape::failure("percent", tr(language, "error.codexApiFailed")),
    };
    match fetch_payload(client, &auth.access_token, auth.account_id.as_deref()).await {
        Ok(payload) => {
            let mut scrape = build_scrape(&payload, language, now_ms());
            // A date already past is a stale login-time snapshot, not a plan that ended.
            if let Some(end) = auth.subscription_active_until.as_deref() {
                if crate::time::parse_iso_ms(end).is_some_and(|end_ms| end_ms > now_ms()) {
                    scrape.extra.insert("billingResetAt".into(), json!(end));
                    scrape.extra.insert("billingResetLabel".into(), json!(tr(language, "fallback.codexBilling")));
                }
            }
            scrape
        }
        Err(Some(401 | 403)) => {
            let mut scrape = Scrape::failure("percent", tr(language, "error.codexLoginExpired"));
            scrape.extra.insert("errorCode".into(), json!("codexLoginExpired"));
            scrape.extra.insert("credentialSource".into(), json!(auth.source));
            scrape
        }
        Err(_) => Scrape::failure("percent", tr(language, "error.codexApiFailed")),
    }
}
