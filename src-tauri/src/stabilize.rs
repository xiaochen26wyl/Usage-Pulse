// Keeps a re-derived reset time stable across polls; a port of stabilizeResetTime and
// stabilizeWindowResets in src/shared/monitor-utils.ts.
//
// Sources such as Codex's reset_after_seconds recompute `resetsAt` as `now + secondsLeft`
// on every poll, so the same real reset comes back a second or two apart. The one-shot
// alert latch keys off that value, so without pinning it a low-quota alert re-arms on
// every poll and never stays quiet.
use serde_json::Value;

use crate::time::parse_iso_ms;

// Real recompute jitter is "a second or two"; 60 s is generous headroom yet far short of
// any genuine reset change (minutes to hours).
const RESET_DRIFT_TOLERANCE_MS: i64 = 60_000;

/// The cached reset time while it is still in the future and the candidate is within
/// jitter of it; otherwise the candidate (even `None`).
pub fn stabilize_reset_time(cached: Option<&str>, candidate: Option<&str>, now_ms: i64) -> Option<String> {
    let Some(cached) = cached else { return candidate.map(str::to_string) };
    let cached_ms = parse_iso_ms(cached);
    if !cached_ms.is_some_and(|ms| ms > now_ms) {
        return candidate.map(str::to_string);
    }
    let Some(candidate) = candidate else { return Some(cached.to_string()) };
    let materially_different = match (parse_iso_ms(candidate), cached_ms) {
        (Some(candidate_ms), Some(cached_ms)) => (candidate_ms - cached_ms).abs() > RESET_DRIFT_TOLERANCE_MS,
        _ => false,
    };
    Some(if materially_different { candidate } else { cached }.to_string())
}

/// Pins every window's `resetsAt` to the previous poll's, matched by `key`.
pub fn stabilize_window_resets(previous: &[Value], next: &mut [Value], now_ms: i64) {
    for window in next.iter_mut() {
        let cached = previous.iter().find(|old| old["key"] == window["key"]).and_then(|old| old["resetsAt"].as_str());
        let stable = stabilize_reset_time(cached, window["resetsAt"].as_str(), now_ms);
        if stable.as_deref() != window["resetsAt"].as_str() {
            window["resetsAt"] = stable.map_or(Value::Null, Value::from);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_000_000_000_000;

    fn at(offset_ms: i64) -> String {
        crate::time::iso_from_ms(NOW + offset_ms)
    }

    #[test]
    fn no_cache_takes_the_candidate() {
        assert_eq!(stabilize_reset_time(None, Some(&at(5_000)), NOW), Some(at(5_000)));
        assert_eq!(stabilize_reset_time(None, None, NOW), None);
    }

    #[test]
    fn a_live_cache_absorbs_jitter_and_a_missing_candidate() {
        let cached = at(3_600_000);
        assert_eq!(stabilize_reset_time(Some(&cached), Some(&at(3_601_500)), NOW), Some(cached.clone()));
        assert_eq!(stabilize_reset_time(Some(&cached), None, NOW), Some(cached));
    }

    #[test]
    fn a_real_change_or_an_elapsed_cache_takes_the_candidate() {
        let cached = at(3_600_000);
        assert_eq!(stabilize_reset_time(Some(&cached), Some(&at(1_800_000)), NOW), Some(at(1_800_000)));
        assert_eq!(stabilize_reset_time(Some(&at(-1_000)), Some(&at(5_000)), NOW), Some(at(5_000)));
        assert_eq!(stabilize_reset_time(Some(&at(-1_000)), None, NOW), None);
    }

    #[test]
    fn window_resets_are_pinned_by_key() {
        let previous = vec![json!({ "key": "session", "resetsAt": at(3_600_000) })];
        let mut next = vec![json!({ "key": "session", "resetsAt": at(3_601_000) }), json!({ "key": "weekly", "resetsAt": at(9_000) })];
        stabilize_window_resets(&previous, &mut next, NOW);
        assert_eq!(next[0]["resetsAt"], json!(at(3_600_000)));
        assert_eq!(next[1]["resetsAt"], json!(at(9_000)));
    }
}
