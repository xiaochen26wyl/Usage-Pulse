use std::sync::Mutex;

use serde_json::{Map, Value, json};

use super::{Scrape, clamp_percent, to_iso_time, to_number};
use super::claude_cli_log::{self as cli_log, SESSION_LIMIT_TYPES, WEEKLY_LIMIT_TYPES};
use crate::{
    credentials::{self, CredentialError},
    i18n::{fill, tr},
    stabilize::stabilize_reset_time,
    time::now_ms,
};

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
const RESET_FIELDS: [&str; 6] = ["resetsAt", "resets_at", "resetAt", "reset_at", "resetTime", "reset_time"];

struct Limit {
    key: String,
    label: String,
    used_percent: Option<f64>,
    resets_at: Option<String>,
}

fn pick_reset(source: &Value) -> Option<String> {
    RESET_FIELDS.iter().find_map(|field| to_iso_time(source.get(*field)))
}

// Percent-named fields are taken at face value; only `ratio` is scaled.
fn percent_field(value: Option<&Value>) -> Option<f64> {
    to_number(value).map(clamp_percent)
}

fn detect_limit_key(raw: &str) -> String {
    let key = raw.to_lowercase();
    if key.contains("session") || key.contains("five") {
        "session".into()
    } else if key.contains("weekly_all") || key.contains("seven_day_all") {
        "weekly_all".into()
    } else if key.contains("weekly_scoped") {
        "weekly_scoped".into()
    } else if key.contains("weekly") || key.contains("seven_day") {
        "weekly".into()
    } else if key.is_empty() {
        "unknown".into()
    } else {
        key
    }
}

fn label_for_key(key: &str, language: &str) -> String {
    let label_key = match key {
        "session" => "window.label.session",
        "weekly_all" => "window.label.weeklyAll",
        "weekly_scoped" => "window.label.weeklyScoped",
        "weekly" => "window.label.weekly",
        _ => return key.to_string(),
    };
    tr(language, label_key).to_string()
}

fn text_of(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn parse_limit_object(raw: &Value, language: &str) -> Option<Limit> {
    let raw_key = ["kind", "group", "name", "id", "type", "window", "limit", "key"]
        .iter()
        .find_map(|field| text_of(raw.get(*field)))
        .unwrap_or_default();
    let key = detect_limit_key(raw_key.trim());
    let mut used = ["utilization", "percentUsed", "usedPercent", "utilisation", "percent"]
        .iter()
        .find_map(|field| percent_field(raw.get(*field)))
        .or_else(|| to_number(raw.get("ratio")).map(|ratio| clamp_percent(ratio * 100.0)));
    if used.is_none() {
        if let (Some(remaining), Some(total)) = (to_number(raw.get("remaining")), to_number(raw.get("total"))) {
            if total > 0.0 {
                used = Some(clamp_percent((total - remaining) / total * 100.0));
            }
        }
    }
    if used.is_none() && key == "unknown" {
        return None;
    }
    Some(Limit { label: label_for_key(&key, language), key, used_percent: used, resets_at: pick_reset(raw) })
}

fn extract_limits(payload: &Value, language: &str) -> Vec<Limit> {
    let mut limits: Vec<Limit> = payload
        .get("limits")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().filter(|entry| entry.is_object()).filter_map(|entry| parse_limit_object(entry, language)).collect())
        .unwrap_or_default();
    if !limits.is_empty() {
        return limits;
    }
    let first = |names: &[&str]| names.iter().find_map(|name| payload.get(*name).filter(|value| !value.is_null()));
    let legacy = [
        ("session", first(&["five_hour", "fiveHour", "session"])),
        ("weekly_all", first(&["weekly_all", "seven_day_all", "sevenDayAll"])),
        ("weekly", first(&["weekly", "seven_day", "sevenDay"])),
    ];
    for (key, raw) in legacy {
        let Some(item) = raw.filter(|value| value.is_object()) else { continue };
        let Some(used) = ["utilization", "percentUsed", "usedPercent"].iter().find_map(|field| percent_field(item.get(*field))) else {
            continue;
        };
        limits.push(Limit { key: key.into(), label: label_for_key(key, language), used_percent: Some(used), resets_at: pick_reset(item) });
    }
    limits
}

fn select_primary(limits: &[Limit]) -> (Option<&Limit>, Option<&Limit>) {
    let find = |key: &str| limits.iter().find(|limit| limit.key == key);
    (find("session"), find("weekly_all").or_else(|| find("weekly_scoped")).or_else(|| find("weekly")))
}

/// Reset times recovered from the CLI's own logs, for windows the API left blank.
#[derive(Default, Clone, PartialEq, Debug)]
struct CliResets {
    session: Option<String>,
    weekly: Option<String>,
}

// Wider than the 5-hour window, so a rejection recorded at its start is still in scope
// when we go looking for the reset time it carried.
const CLI_LOG_LOOKBACK_MS: i64 = 8 * 60 * 60_000;

// The log rescan's "newest future candidate" can drift poll to poll (a new line appears)
// although the real window has not rolled over. The one-shot alert latch keys off this
// value, so it is held until it elapses and only then replaced.
static STABLE_CLI_RESETS: Mutex<(Option<String>, Option<String>)> = Mutex::new((None, None));

/// Best effort in every sense: a failure just means carrying on without a reset time.
async fn read_cli_resets(need_session: bool, need_weekly: bool) -> CliResets {
    if !need_session && !need_weekly {
        return CliResets::default();
    }
    let now = now_ms();
    let events = tauri::async_runtime::spawn_blocking(move || cli_log::read_quota_events(now - CLI_LOG_LOOKBACK_MS)).await.unwrap_or_default();
    let mut stable = STABLE_CLI_RESETS.lock().expect("cli reset lock poisoned");
    if need_session {
        stable.0 = stabilize_reset_time(stable.0.as_deref(), cli_log::latest_future_reset(&events, &SESSION_LIMIT_TYPES, now).as_deref(), now);
    }
    if need_weekly {
        stable.1 = stabilize_reset_time(stable.1.as_deref(), cli_log::latest_future_reset(&events, &WEEKLY_LIMIT_TYPES, now).as_deref(), now);
    }
    CliResets { session: need_session.then(|| stable.0.clone()).flatten(), weekly: need_weekly.then(|| stable.1.clone()).flatten() }
}

fn scrape_from_limits(limits: &[Limit], language: &str, cli: &CliResets) -> Scrape {
    if limits.is_empty() {
        let mut scrape = Scrape::failure("percent", tr(language, "error.claudeMissingFields"));
        scrape.is_error = false;
        scrape.extra.insert("source".into(), json!("api"));
        return scrape;
    }
    let (session, weekly) = select_primary(limits);
    let session_reset = session.and_then(|limit| limit.resets_at.clone()).or_else(|| cli.session.clone());
    let weekly_reset = weekly.and_then(|limit| limit.resets_at.clone()).or_else(|| cli.weekly.clone());
    let windows: Vec<Value> = limits
        .iter()
        .map(|item| {
            let remaining = item.used_percent.map(|used| clamp_percent(100.0 - used));
            let resets_at = item.resets_at.clone().or_else(|| match item.key.as_str() {
                "session" => session_reset.clone(),
                key if key.starts_with("weekly") => weekly_reset.clone(),
                _ => None,
            });
            json!({
                "key": item.key, "label": item.label, "remaining": remaining,
                "total": item.used_percent.map(|_| 100), "percent": remaining,
                "resetsAt": resets_at, "message": tr(language, "window.message.claudeSource")
            })
        })
        .collect();
    let session_used = session.and_then(|limit| limit.used_percent);
    let weekly_used = weekly.and_then(|limit| limit.used_percent);
    let primary = session_used.or(weekly_used);
    let text = |used: Option<f64>| used.map_or_else(|| "N/A".to_string(), |used| format!("{}%", clamp_percent(100.0 - used).round() as i64));

    let mut extra = Map::new();
    extra.insert("weeklyResetAt".into(), json!(weekly_reset));
    extra.insert("source".into(), json!(if cli.session.is_some() || cli.weekly.is_some() { "cli-log" } else { "api" }));
    Scrape {
        remaining: primary.map(|used| clamp_percent(100.0 - used)),
        total: primary.map(|_| 100.0),
        unit: "percent",
        resets_at: session_reset.clone().or_else(|| weekly_reset.clone()),
        windows,
        message: fill(tr(language, "message.claudeSummary"), &[("session", &text(session_used)), ("weekly", &text(weekly_used))]),
        is_error: false,
        extra,
    }
}

async fn get(client: &reqwest::Client, url: &str, token: &str) -> Result<reqwest::Response, reqwest::Error> {
    client
        .get(url)
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "claude-code/")
        .send()
        .await
}

fn subscription_created_at(payload: &Value) -> Option<String> {
    let mut candidates: Vec<&Value> = vec![payload.get("organization").unwrap_or(&Value::Null), payload];
    if let Some(memberships) = payload.get("memberships").and_then(Value::as_array) {
        for membership in memberships {
            candidates.push(membership.get("organization").unwrap_or(&Value::Null));
            candidates.push(membership);
        }
    }
    candidates.into_iter().find_map(|candidate| {
        ["subscription_created_at", "subscriptionCreatedAt"]
            .iter()
            .find_map(|field| to_iso_time(candidate.get(*field).filter(|value| value.is_string())))
    })
}

// Cached for a day: the anchor changes at most when the plan does.
static PROFILE_CACHE: std::sync::Mutex<Option<(i64, Option<String>)>> = std::sync::Mutex::new(None);
const PROFILE_CACHE_MS: i64 = 24 * 60 * 60 * 1000;

async fn read_subscription_created_at(client: &reqwest::Client, token: &str) -> Option<String> {
    let cached = PROFILE_CACHE.lock().expect("profile cache lock poisoned").clone();
    if let Some((fetched_at, value)) = cached.as_ref() {
        if crate::time::now_ms() - fetched_at < PROFILE_CACHE_MS {
            return value.clone();
        }
    }
    let fetched = match get(client, PROFILE_URL, token).await {
        Ok(response) if response.status().is_success() => response.json::<Value>().await.ok().map(|payload| subscription_created_at(&payload)),
        _ => None,
    };
    match fetched {
        Some(value) => {
            *PROFILE_CACHE.lock().expect("profile cache lock poisoned") = Some((crate::time::now_ms(), value.clone()));
            value
        }
        None => cached.and_then(|(_, value)| value),
    }
}

fn failure(language: &str, key: &str, code: Option<&str>, source: &str) -> Scrape {
    let mut scrape = Scrape::failure("percent", tr(language, key));
    if let Some(code) = code {
        scrape.extra.insert("errorCode".into(), json!(code));
    }
    scrape.extra.insert("credentialSource".into(), json!(source));
    scrape
}

pub async fn collect(client: &reqwest::Client, language: &str, manual_token: &str) -> Scrape {
    let credential = match credentials::claude::read(manual_token) {
        Ok(credential) => credential,
        Err(CredentialError::Missing) => return Scrape::failure("percent", tr(language, "error.claudeCredentialMissing")),
        Err(CredentialError::ReadFailed) => return Scrape::failure("percent", tr(language, "error.claudeKeychainFormatInvalid")),
    };
    collect_with_token(client, language, &credential.token, credential.source).await
}

/// One usage fetch for a known token; also what validates a pasted token.
pub async fn collect_with_token(client: &reqwest::Client, language: &str, token: &str, source: &str) -> Scrape {
    let response = match get(client, USAGE_URL, token).await {
        Ok(response) => response,
        Err(_) => return failure(language, "error.claudeApiFailed", None, source),
    };
    match response.status().as_u16() {
        200..=299 => {}
        401 => return failure(language, "error.claudeLoginExpired", Some("claudeLoginExpired"), source),
        429 => return failure(language, "error.claudeRateLimited", Some("claudeRateLimited"), source),
        403 => {
            let body: Value = response.json().await.unwrap_or(Value::Null);
            let scope = body.pointer("/error/details/error_code").and_then(Value::as_str) == Some("oauth_scope_insufficient");
            let key = if scope { "error.claudeScopeInsufficient" } else { "error.claudeApiFailed" };
            return failure(language, key, Some("claudeScopeInsufficient"), source);
        }
        _ => return failure(language, "error.claudeApiFailed", None, source),
    }
    let Ok(payload) = response.json::<Value>().await else {
        return failure(language, "error.claudeApiFailed", None, source);
    };
    let limits = extract_limits(&payload, language);
    // The API does not always carry a reset time; without one no reset alarm can be
    // armed, so fall back to what the CLI recorded locally.
    let (session, weekly) = select_primary(&limits);
    let cli = read_cli_resets(session.is_none_or(|limit| limit.resets_at.is_none()), weekly.is_none_or(|limit| limit.resets_at.is_none())).await;
    let mut scrape = scrape_from_limits(&limits, language, &cli);
    if !limits.is_empty() {
        let anchor = read_subscription_created_at(client, token).await;
        scrape.extra.insert("billingAnchorAt".into(), json!(anchor));
        scrape.extra.insert("billingResetAt".into(), Value::Null);
        scrape.extra.insert("billingResetLabel".into(), Value::Null);
    }
    scrape
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limit(key: &str, used: f64, resets_at: Option<&str>) -> Limit {
        Limit { key: key.into(), label: key.into(), used_percent: Some(used), resets_at: resets_at.map(str::to_string) }
    }

    #[test]
    fn api_reset_times_win_and_the_source_stays_api() {
        let limits = [limit("session", 40.0, Some("2026-08-20T10:00:00.000Z")), limit("weekly_all", 10.0, Some("2026-08-25T00:00:00.000Z"))];
        let cli = CliResets { session: Some("2026-08-20T11:00:00.000Z".into()), weekly: None };
        let scrape = scrape_from_limits(&limits, "en", &cli);
        assert_eq!(scrape.resets_at.as_deref(), Some("2026-08-20T10:00:00.000Z"));
        assert_eq!(scrape.extra["source"], json!("cli-log"));
        let plain = scrape_from_limits(&limits, "en", &CliResets::default());
        assert_eq!(plain.extra["source"], json!("api"));
    }

    #[test]
    fn missing_api_reset_times_are_filled_from_the_cli_log() {
        let limits = [limit("session", 100.0, None), limit("weekly_all", 10.0, None)];
        let cli = CliResets { session: Some("2026-08-20T10:30:00.000Z".into()), weekly: Some("2026-08-25T00:00:00.000Z".into()) };
        let scrape = scrape_from_limits(&limits, "en", &cli);
        assert_eq!(scrape.resets_at.as_deref(), Some("2026-08-20T10:30:00.000Z"));
        assert_eq!(scrape.extra["weeklyResetAt"], json!("2026-08-25T00:00:00.000Z"));
        assert_eq!(scrape.windows[0]["resetsAt"], json!("2026-08-20T10:30:00.000Z"));
        assert_eq!(scrape.windows[1]["resetsAt"], json!("2026-08-25T00:00:00.000Z"));
    }
}
