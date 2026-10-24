use std::{path::PathBuf, sync::Mutex};

use serde_json::Value;

use super::{CredentialError, RawCredential, jwt_expiry_ms, jwt_payload, security_read};

const KEYRING_SERVICES: [&str; 3] = ["Codex Auth", "com.openai.codex", "Codex Auth Credentials"];
const REFRESH_SKEW_MS: i64 = 60_000;
const CHATGPT_ACCOUNT_CLAIM: &str = "https://api.openai.com/auth.chatgpt_account_id";

#[derive(Clone)]
pub struct ParsedCodexAuth {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub account_id: Option<String>,
    pub expires_at_ms: Option<i64>,
    pub subscription_active_until: Option<String>,
    pub source: &'static str,
}

// A refreshed access token lives here and nowhere else: auth.json is never rewritten.
static MEMORY_AUTH: Mutex<Option<ParsedCodexAuth>> = Mutex::new(None);

fn non_empty(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn account_id_from_jwt(token: Option<&str>) -> Option<String> {
    let payload = jwt_payload(token?)?;
    non_empty(payload.get(CHATGPT_ACCOUNT_CLAIM))
        .or_else(|| non_empty(payload.pointer("/https:~1~1api.openai.com~1auth/chatgpt_account_id")))
        .or_else(|| non_empty(payload.get("chatgpt_account_id")))
        .or_else(|| non_empty(payload.get("account_id")))
}

fn subscription_until(token: Option<&str>) -> Option<String> {
    let payload = jwt_payload(token?)?;
    let raw = payload.pointer("/https:~1~1api.openai.com~1auth/chatgpt_subscription_active_until")?;
    let ms = match raw {
        Value::Number(number) => {
            let value = number.as_f64()?;
            (value > 0.0).then(|| if value < 1e12 { value * 1000.0 } else { value } as i64)?
        }
        Value::String(text) => crate::time::parse_iso_ms(text)?,
        _ => return None,
    };
    Some(crate::time::iso_from_ms(ms))
}

pub fn parse_auth_json(raw: &str, source: &'static str) -> Option<ParsedCodexAuth> {
    let root: Value = serde_json::from_str(raw.trim()).ok()?;
    root.as_object()?;
    let tokens = root.get("tokens").filter(|value| value.is_object()).unwrap_or(&root);
    let pick = |keys: &[&str]| keys.iter().find_map(|key| non_empty(tokens.get(*key)).or_else(|| non_empty(root.get(*key))));
    let access_token = pick(&["access_token", "accessToken"])?;
    let refresh_token = pick(&["refresh_token", "refreshToken"]);
    let id_token = pick(&["id_token", "idToken"]);
    let account_id = non_empty(root.get("account_id"))
        .or_else(|| non_empty(root.get("accountId")))
        .or_else(|| non_empty(tokens.get("account_id")))
        .or_else(|| account_id_from_jwt(id_token.as_deref()))
        .or_else(|| account_id_from_jwt(Some(&access_token)));
    Some(ParsedCodexAuth {
        expires_at_ms: jwt_expiry_ms(&access_token),
        subscription_active_until: subscription_until(id_token.as_deref()).or_else(|| subscription_until(Some(&access_token))),
        access_token,
        refresh_token,
        account_id,
        source,
    })
}

fn codex_home() -> Option<PathBuf> {
    match std::env::var("CODEX_HOME") {
        Ok(custom) if !custom.trim().is_empty() => Some(PathBuf::from(custom.trim())),
        _ => super::home_dir().map(|home| home.join(".codex")),
    }
}

fn store_preference() -> Option<&'static str> {
    let config = std::fs::read_to_string(codex_home()?.join("config.toml")).ok()?;
    let line = config.lines().find(|line| line.contains("cli_auth_credentials_store"))?.to_lowercase();
    ["file", "keyring", "auto"].into_iter().find(|value| line.contains(&format!("\"{value}\"")) || line.contains(&format!("'{value}'")))
}

fn read_auth_file() -> Option<ParsedCodexAuth> {
    parse_auth_json(&std::fs::read_to_string(codex_home()?.join("auth.json")).ok()?, "codexAuthFile")
}

fn read_keyring() -> Option<ParsedCodexAuth> {
    KEYRING_SERVICES.iter().find_map(|service| {
        parse_auth_json(&security_read(&["find-generic-password", "-s", service, "-w"])?, "codexKeyring")
    })
}

fn load_from_disk() -> Result<ParsedCodexAuth, CredentialError> {
    let preference = store_preference();
    let from_file = read_auth_file();
    let found = if preference == Some("keyring") {
        read_keyring().or(from_file)
    } else {
        from_file.or_else(|| if preference == Some("file") { None } else { read_keyring() })
    };
    found.ok_or(CredentialError::Missing)
}

fn is_fresh(auth: &ParsedCodexAuth) -> bool {
    auth.expires_at_ms.is_none_or(|expiry| expiry - REFRESH_SKEW_MS > crate::time::now_ms())
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (byte as char).to_string(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

const OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";

async fn refresh(client: &reqwest::Client, stale: &ParsedCodexAuth, refresh_token: &str) -> Option<ParsedCodexAuth> {
    let body = format!(
        "grant_type=refresh_token&refresh_token={}&client_id={}",
        percent_encode(refresh_token),
        OAUTH_CLIENT_ID
    );
    let response = client
        .post(OAUTH_TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let data: Value = response.json().await.ok()?;
    let access_token = non_empty(data.get("access_token"))?;
    let id_token = non_empty(data.get("id_token"));
    let expires_in = data.get("expires_in").and_then(Value::as_f64);
    Some(ParsedCodexAuth {
        refresh_token: non_empty(data.get("refresh_token")).or_else(|| Some(refresh_token.to_string())),
        account_id: account_id_from_jwt(id_token.as_deref())
            .or_else(|| account_id_from_jwt(Some(&access_token)))
            .or_else(|| stale.account_id.clone()),
        expires_at_ms: expires_in.map(|seconds| crate::time::now_ms() + (seconds * 1000.0) as i64).or_else(|| jwt_expiry_ms(&access_token)),
        subscription_active_until: subscription_until(id_token.as_deref()).or_else(|| subscription_until(Some(&access_token))),
        access_token,
        source: stale.source,
    })
}

fn remember(auth: ParsedCodexAuth) -> ParsedCodexAuth {
    *MEMORY_AUTH.lock().expect("codex auth lock poisoned") = Some(auth.clone());
    auth
}

/// Current Codex credential, refreshed in memory when the stored one is stale.
pub async fn resolve(client: &reqwest::Client) -> Result<ParsedCodexAuth, CredentialError> {
    let cached = MEMORY_AUTH.lock().expect("codex auth lock poisoned").clone();
    if let Some(auth) = cached.filter(is_fresh) {
        return Ok(auth);
    }
    let from_disk = load_from_disk()?;
    if is_fresh(&from_disk) {
        return Ok(remember(from_disk));
    }
    if let Some(refresh_token) = from_disk.refresh_token.clone() {
        if let Some(refreshed) = refresh(client, &from_disk, &refresh_token).await {
            return Ok(remember(refreshed));
        }
    }
    // Hand back the expired token so the credential check can report the expiry.
    Ok(remember(from_disk))
}

pub fn as_raw(auth: &ParsedCodexAuth) -> RawCredential {
    RawCredential { token: auth.access_token.clone(), expires_at_ms: auth.expires_at_ms, source: auth.source }
}
