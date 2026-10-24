// Usage collectors. READ-ONLY toward the IDE / CLI sources, like credentials/:
// they read a credential and call the vendor's usage API, nothing else.
pub mod claude;
pub mod codex;
pub mod cursor;

use serde_json::{Map, Value};

/// The result of one collector run, before the monitor turns it into a snapshot.
/// Field names match ScrapeResult in src/shared/types.ts.
pub struct Scrape {
    pub remaining: Option<f64>,
    pub total: Option<f64>,
    pub unit: &'static str,
    pub resets_at: Option<String>,
    pub windows: Vec<Value>,
    pub message: String,
    pub is_error: bool,
    /// Optional ScrapeResult fields: weeklyResetAt, billingAnchorAt, creditsText,
    /// errorCode, credentialSource, source ...
    pub extra: Map<String, Value>,
}

impl Scrape {
    pub fn failure(unit: &'static str, message: &str) -> Self {
        Self {
            remaining: None,
            total: None,
            unit,
            resets_at: None,
            windows: Vec::new(),
            message: message.to_string(),
            is_error: true,
            extra: Map::new(),
        }
    }
}

pub fn to_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64().filter(|number| number.is_finite()),
        Value::String(text) => text.trim().parse::<f64>().ok().filter(|number| number.is_finite()),
        _ => None,
    }
}

/// Epoch seconds / milliseconds or an RFC 3339 string to an ISO-8601 UTC string.
pub fn to_iso_time(value: Option<&Value>) -> Option<String> {
    let ms = match to_number(value) {
        Some(numeric) => (if numeric > 1e12 { numeric } else { numeric * 1000.0 }) as i64,
        None => crate::time::parse_iso_ms(value?.as_str()?)?,
    };
    Some(crate::time::iso_from_ms(ms))
}

pub fn clamp_percent(value: f64) -> f64 {
    value.clamp(0.0, 100.0)
}
