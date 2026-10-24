// Credential readers. Everything under this module is READ-ONLY with respect to
// the IDE / CLI files it touches (see scripts/check-readonly.mjs): it opens
// their stores for reading and never writes, renames or deletes anything.
pub mod claude;
pub mod codex;
pub mod cursor;

use serde_json::Value;

/// Why a credential could not be produced.
pub enum CredentialError {
    /// Not there yet (never logged in, or logged out): the ordinary case.
    Missing,
    /// Present but unreadable.
    ReadFailed,
}

pub struct RawCredential {
    pub token: String,
    pub expires_at_ms: Option<i64>,
    /// Which store supplied it (CredentialSource in src/shared/types.ts).
    pub source: &'static str,
}

fn base64url_decode(input: &str) -> Option<Vec<u8>> {
    let mut bits = 0u32;
    let mut count = 0u32;
    let mut out = Vec::new();
    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' => break,
            _ => return None,
        } as u32;
        bits = (bits << 6) | value;
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    Some(out)
}

pub fn jwt_payload(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    serde_json::from_slice(&base64url_decode(payload)?).ok()
}

/// `exp` of a JWT access token, in milliseconds.
pub fn jwt_expiry_ms(token: &str) -> Option<i64> {
    let seconds = jwt_payload(token)?.get("exp")?.as_f64()?;
    (seconds > 0.0).then(|| (seconds * 1000.0) as i64)
}

/// Runs the macOS `security` CLI for a read-only Keychain lookup.
#[cfg(target_os = "macos")]
pub fn security_read(args: &[&str]) -> Option<String> {
    let output = std::process::Command::new("security").args(args).output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(not(target_os = "macos"))]
pub fn security_read(_args: &[&str]) -> Option<String> {
    None
}

pub fn home_dir() -> Option<std::path::PathBuf> {
    #[cfg(unix)]
    return std::env::var_os("HOME").map(std::path::PathBuf::from);
    #[cfg(not(unix))]
    return std::env::var_os("USERPROFILE").map(std::path::PathBuf::from);
}
