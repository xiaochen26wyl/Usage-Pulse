use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

// ISO-8601 UTC with milliseconds (civil-from-days, no date crate needed).
pub fn iso_from_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60,
        ms.rem_euclid(1000)
    )
}

pub fn now_iso() -> String {
    iso_from_ms(now_ms())
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year.rem_euclid(400);
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// RFC 3339 / ISO-8601 timestamp to epoch milliseconds.
pub fn parse_iso_ms(text: &str) -> Option<i64> {
    let text = text.trim();
    let (date, rest) = text.split_once(['T', ' '])?;
    let mut date_parts = date.split('-').map(|part| part.parse::<i64>().ok());
    let (year, month, day) = (date_parts.next()??, date_parts.next()??, date_parts.next()??);
    let split = rest.find(['Z', 'z', '+', '-']).unwrap_or(rest.len());
    let (clock, zone) = rest.split_at(split);
    let mut clock_parts = clock.split(':');
    let hour: i64 = clock_parts.next()?.parse().ok()?;
    let minute: i64 = clock_parts.next().unwrap_or("0").parse().ok()?;
    let seconds: f64 = clock_parts.next().unwrap_or("0").parse().ok()?;
    let offset_minutes = match zone.chars().next() {
        Some(sign @ ('+' | '-')) => {
            let digits: String = zone[1..].chars().filter(char::is_ascii_digit).collect();
            let (hours, minutes) = (digits.get(0..2)?.parse::<i64>().ok()?, digits.get(2..4).unwrap_or("00").parse::<i64>().ok()?);
            let total = hours * 60 + minutes;
            if sign == '-' { -total } else { total }
        }
        _ => 0,
    };
    let days = days_from_civil(year, month, day);
    Some(((days * 86_400 + hour * 3_600 + minute * 60) as f64 * 1000.0 + seconds * 1000.0) as i64 - offset_minutes * 60_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_formats_round_trip() {
        let ms = parse_iso_ms("2026-10-24T08:49:00.250Z").expect("parse");
        assert_eq!(iso_from_ms(ms), "2026-10-24T08:49:00.250Z");
        assert_eq!(parse_iso_ms("2026-10-24T16:49:00+08:00"), parse_iso_ms("2026-10-24T08:49:00Z"));
    }
}

/// `YYYY-MM-DD HH:MM` in the machine's local time zone (UTC where it cannot be read).
pub fn local_text_from_iso(iso: &str) -> Option<String> {
    let ms = parse_iso_ms(iso)?;
    let secs = ms.div_euclid(1000);
    #[cfg(unix)]
    let shifted = {
        let time = secs as libc::time_t;
        let mut parts: libc::tm = unsafe { std::mem::zeroed() };
        if unsafe { libc::localtime_r(&time, &mut parts) }.is_null() { secs } else { secs + parts.tm_gmtoff }
    };
    #[cfg(not(unix))]
    let shifted = secs;
    let text = iso_from_ms(shifted * 1000);
    Some(format!("{} {}", &text[0..10], &text[11..16]))
}
