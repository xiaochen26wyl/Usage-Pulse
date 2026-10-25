// Wall-clock waiting for the polling loops. tokio's timers are monotonic and
// stop counting while the machine sleeps, so a plain sleep(15 min) can overshoot
// by the whole length of a sleep. Waiting in short slices against the wall clock
// makes a loop notice a wake-up within one slice, the way Electron's powerMonitor
// "resume" did, without any OS hook.
use std::time::Duration;

use crate::time::now_ms;

const SLICE: Duration = Duration::from_secs(30);

/// How long to sleep next, or `None` once the wall clock has reached `due_ms`.
fn next_slice(due_ms: i64, now_ms: i64) -> Option<Duration> {
    let remaining = due_ms - now_ms;
    if remaining <= 0 {
        return None;
    }
    Some(Duration::from_millis(remaining as u64).min(SLICE))
}

/// Sleeps for `delay` of wall-clock time, in slices.
pub async fn sleep_for(delay: Duration) {
    let due_ms = now_ms() + delay.as_millis() as i64;
    while let Some(slice) = next_slice(due_ms, now_ms()) {
        tokio::time::sleep(slice).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn due_or_overdue_stops_waiting() {
        assert_eq!(next_slice(1_000, 1_000), None);
        assert_eq!(next_slice(1_000, 5_000_000), None);
    }

    #[test]
    fn long_waits_are_cut_into_slices() {
        assert_eq!(next_slice(15 * 60 * 1000, 0), Some(SLICE));
    }

    #[test]
    fn the_last_slice_is_only_what_remains() {
        assert_eq!(next_slice(1_500, 1_000), Some(Duration::from_millis(500)));
    }
}
