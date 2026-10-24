use std::time::Duration;

use serde_json::{Value, json};

use super::{Scrape, to_iso_time, to_number};
use crate::{
    credentials::{self, CredentialError},
    i18n::{fill, tr},
};

const API_BASE: &str = "https://api2.cursor.sh";

fn cents_to_usd(value: Option<f64>) -> Option<f64> {
    value.map(|cents| (cents / 100.0 * 100.0).round() / 100.0)
}

fn percent_of(remaining: Option<f64>, total: Option<f64>) -> Option<f64> {
    match (remaining, total) {
        (Some(remaining), Some(total)) if total > 0.0 => Some((remaining / total * 100.0).round().clamp(0.0, 100.0)),
        _ => None,
    }
}

// Mirrors clampPercentFromRatio in src/shared/monitor-utils.ts.
fn clamp_percent_from_ratio(value: f64) -> f64 {
    let percent = if value > 1.0 { value } else { value * 100.0 };
    percent.round().clamp(0.0, 100.0)
}

enum RequestError {
    Unauthorized,
    Failed,
}

async fn request(client: &reqwest::Client, path: &str, token: &str) -> Result<Value, RequestError> {
    let response = client
        .post(format!("{API_BASE}{path}"))
        .bearer_auth(token)
        .header("Connect-Protocol-Version", "1")
        .json(&json!({}))
        .send()
        .await
        .map_err(|_| RequestError::Failed)?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(RequestError::Unauthorized);
    }
    if !response.status().is_success() {
        return Err(RequestError::Failed);
    }
    response.json().await.map_err(|_| RequestError::Failed)
}

fn error_scrape(language: &str, key: &str) -> Scrape {
    Scrape::failure("usd", tr(language, key))
}

fn window(key: &str, label: String, percent: Option<f64>, message: String, remaining: Option<f64>, total: Option<f64>, resets_at: Option<String>) -> Value {
    json!({
        "key": key, "label": label, "remaining": remaining, "total": total,
        "percent": percent, "resetsAt": resets_at, "message": message
    })
}

pub async fn collect(client: &reqwest::Client, language: &str) -> Scrape {
    let token = match credentials::cursor::read() {
        Ok(credential) => credential.token,
        Err(CredentialError::Missing) => return error_scrape(language, "error.cursorCredentialMissing"),
        Err(CredentialError::ReadFailed) => return error_scrape(language, "error.cursorCredentialReadFailed"),
    };

    let raw = match request(client, "/aiserver.v1.DashboardService/GetCurrentPeriodUsage", &token).await {
        Ok(raw) => raw,
        Err(RequestError::Unauthorized) => return error_scrape(language, "error.cursorLoginExpired"),
        Err(RequestError::Failed) => return error_scrape(language, "error.cursorApiFailed"),
    };
    // Some responses wrap the payload in a `message` envelope.
    let usage = if raw.get("planUsage").is_some() { &raw } else { raw.get("message").filter(|value| value.is_object()).unwrap_or(&raw) };

    let plan_usage = usage.get("planUsage").cloned().unwrap_or(Value::Null);
    let included_spend = to_number(plan_usage.get("includedSpend"));
    let mut limit = to_number(plan_usage.get("limit"));
    let mut remaining = to_number(plan_usage.get("remaining"));

    if limit.is_none_or(|limit| limit <= 0.0) {
        if let (Some(remaining), Some(spend)) = (remaining, included_spend) {
            limit = Some(remaining + spend);
        }
    }
    if limit.is_none_or(|limit| limit <= 0.0) {
        if let Ok(info) = request(client, "/aiserver.v1.DashboardService/GetPlanInfo", &token).await {
            let included = to_number(
                info.pointer("/message/planInfo/includedAmountCents").or_else(|| info.pointer("/planInfo/includedAmountCents")),
            );
            if let Some(included) = included.filter(|included| *included > 0.0) {
                limit = Some(included);
            }
        }
    }
    if remaining.is_none() {
        if let (Some(limit), Some(spend)) = (limit, included_spend) {
            remaining = Some((limit - spend).max(0.0));
        }
    }

    let remaining_usd = cents_to_usd(remaining);
    let total_usd = cents_to_usd(limit);
    let resets_at = to_iso_time(usage.get("billingCycleEnd"));

    let mut windows = vec![window(
        "billing_cycle",
        tr(language, "window.label.billingCycle").to_string(),
        percent_of(remaining_usd, total_usd),
        tr(language, "window.message.cursorSource").to_string(),
        remaining_usd,
        total_usd,
        resets_at.clone(),
    )];
    if let Some(auto) = to_number(plan_usage.get("autoPercentUsed")) {
        windows.push(window(
            "cursor_models",
            tr(language, "window.label.cursorModels").to_string(),
            Some(clamp_percent_from_ratio(auto)),
            tr(language, "window.desc.cursorModels").to_string(),
            None,
            None,
            None,
        ));
    }
    if let Some(api) = to_number(plan_usage.get("apiPercentUsed")) {
        windows.push(window(
            "other_models",
            tr(language, "window.label.otherModels").to_string(),
            Some(clamp_percent_from_ratio(api)),
            tr(language, "window.desc.otherModels").to_string(),
            None,
            None,
            None,
        ));
    }

    if remaining_usd.is_none() && total_usd.is_none() {
        return Scrape {
            remaining: None,
            total: None,
            unit: "usd",
            resets_at,
            windows,
            message: tr(language, "error.cursorMissingFields").to_string(),
            is_error: false,
            extra: Default::default(),
        };
    }

    let money = |value: Option<f64>| value.map_or_else(|| "N/A".to_string(), |amount| format!("${amount:.2}"));
    let suffix = to_number(plan_usage.get("totalPercentUsed"))
        .map(|percent| fill(tr(language, "message.cursorUsedSuffix"), &[("percent", &format!("{}", percent.round() as i64))]))
        .unwrap_or_default();
    Scrape {
        remaining: remaining_usd,
        total: total_usd,
        unit: "usd",
        resets_at,
        windows,
        message: fill(
            tr(language, "message.cursorSummary"),
            &[("remaining", &money(remaining_usd)), ("total", &money(total_usd)), ("suffix", &suffix)],
        ),
        is_error: false,
        extra: Default::default(),
    }
}

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("http client")
}
