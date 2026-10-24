use std::path::PathBuf;

use rusqlite::{Connection, OpenFlags};

use super::{CredentialError, RawCredential, jwt_expiry_ms};

const ACCESS_TOKEN_KEY: &str = "cursorAuth/accessToken";

fn state_db_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let path = super::home_dir()?.join("Library/Application Support/Cursor/User/globalStorage/state.vscdb");
    #[cfg(target_os = "windows")]
    let path = PathBuf::from(std::env::var_os("APPDATA")?).join("Cursor/User/globalStorage/state.vscdb");
    #[cfg(all(unix, not(target_os = "macos")))]
    let path = super::home_dir()?.join(".config/Cursor/User/globalStorage/state.vscdb");
    Some(path)
}

// Cursor writes this value either as a bare token or as a JSON string.
fn token_from_raw(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    match serde_json::from_str::<serde_json::Value>(trimmed) {
        Ok(serde_json::Value::String(text)) => Some(text.trim().to_string()).filter(|text| !text.is_empty()),
        Ok(serde_json::Value::Object(record)) => record
            .get("accessToken")
            .and_then(|value| value.as_str())
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty()),
        _ => Some(trimmed.to_string()),
    }
}

/// Reads Cursor's access token from its own state database. The connection is
/// opened read-only and only ever runs a SELECT.
pub fn read() -> Result<RawCredential, CredentialError> {
    let path = state_db_path().ok_or(CredentialError::ReadFailed)?;
    if !path.exists() {
        return Err(CredentialError::Missing);
    }
    let connection = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|_| CredentialError::ReadFailed)?;
    let raw: Option<String> = connection
        .query_row("SELECT value FROM ItemTable WHERE key = ?1 LIMIT 1", [ACCESS_TOKEN_KEY], |row| {
            Ok(match row.get_ref(0)? {
                rusqlite::types::ValueRef::Text(bytes) | rusqlite::types::ValueRef::Blob(bytes) => {
                    String::from_utf8_lossy(bytes).into_owned()
                }
                _ => String::new(),
            })
        })
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            _ => Err(CredentialError::ReadFailed),
        })?;
    let token = raw.as_deref().and_then(token_from_raw).ok_or(CredentialError::Missing)?;
    let expires_at_ms = jwt_expiry_ms(&token);
    Ok(RawCredential { token, expires_at_ms, source: "cursorStateDb" })
}
