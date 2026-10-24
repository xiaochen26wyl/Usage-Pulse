use serde_json::Value;

use super::{CredentialError, RawCredential, jwt_expiry_ms, security_read};

const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
const OAUTH_PREFIX: &str = "sk-ant-oat01-";

pub fn is_oauth_token(value: &str) -> bool {
    value.starts_with(OAUTH_PREFIX)
}

// The Keychain item holds `{ claudeAiOauth: { accessToken, expiresAt } }`.
fn parse(raw: &str, source: &'static str) -> Option<RawCredential> {
    let trimmed = raw.trim();
    let (token, explicit_expiry) = match serde_json::from_str::<Value>(trimmed) {
        Ok(parsed) => {
            let oauth = parsed.get("claudeAiOauth").unwrap_or(&parsed);
            let token = oauth.get("accessToken").and_then(Value::as_str).map(str::trim).map(str::to_string);
            let expiry = ["expiresAt", "expires_at", "expiresAtMs"].iter().find_map(|key| {
                let value = oauth.get(*key)?;
                let number = value.as_f64().or_else(|| value.as_str()?.parse().ok())?;
                // Some blobs store seconds rather than milliseconds.
                (number > 0.0).then(|| if number < 1e11 { number * 1000.0 } else { number } as i64)
            });
            (token, expiry)
        }
        Err(_) => (Some(trimmed.to_string()), None),
    };
    let token = token.filter(|token| !token.is_empty())?;
    let expires_at_ms = explicit_expiry.or_else(|| jwt_expiry_ms(&token));
    Some(RawCredential { token, expires_at_ms, source })
}

fn keychain_account() -> Option<String> {
    let output = security_read(&["find-generic-password", "-s", KEYCHAIN_SERVICE])?;
    let marker = "\"acct\"<blob>=\"";
    let start = output.find(marker)? + marker.len();
    let end = output[start..].find('"')?;
    Some(output[start..start + end].to_string())
}

/// Reads the official Claude Code login from the Keychain (read-only).
/// `Ok(None)` is "nothing there"; an item that is not an OAuth token is an error.
fn peek_keychain() -> Result<Option<RawCredential>, CredentialError> {
    let mut found_unusable = false;
    let mut attempts: Vec<Option<String>> = vec![None];
    attempts.push(keychain_account());
    if let Some(user) = std::env::var_os("USER") {
        attempts.push(Some(user.to_string_lossy().into_owned()));
    }
    for account in attempts {
        let mut args = vec!["find-generic-password", "-s", KEYCHAIN_SERVICE];
        if let Some(account) = account.as_deref() {
            args.extend(["-a", account]);
        }
        args.push("-w");
        let Some(stdout) = security_read(&args) else { continue };
        match parse(&stdout, "keychain") {
            Some(credential) if is_oauth_token(&credential.token) => return Ok(Some(credential)),
            _ => found_unusable = true,
        }
    }
    if found_unusable { Err(CredentialError::ReadFailed) } else { Ok(None) }
}

fn has_expired(credential: &RawCredential) -> bool {
    credential.expires_at_ms.is_some_and(|expiry| expiry <= crate::time::now_ms())
}

/// Keychain first (the CLI keeps it refreshed); a token the user pasted is the
/// fallback when the Keychain one is missing or stale.
pub fn read(manual_token: &str) -> Result<RawCredential, CredentialError> {
    let from_keychain = peek_keychain()?;
    if let Some(credential) = from_keychain.as_ref().filter(|credential| !has_expired(credential)) {
        return Ok(RawCredential { token: credential.token.clone(), expires_at_ms: credential.expires_at_ms, source: credential.source });
    }
    let manual = manual_token.trim();
    if is_oauth_token(manual) {
        return Ok(RawCredential { token: manual.to_string(), expires_at_ms: None, source: "manualToken" });
    }
    from_keychain.ok_or(CredentialError::Missing)
}
