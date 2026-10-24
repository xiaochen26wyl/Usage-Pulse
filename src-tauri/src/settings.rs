use std::{path::PathBuf, sync::Mutex};

use serde_json::{Map, Value, json};

// Mirrors src/shared/types.ts MASKS: the renderer never receives a stored secret.
const SECRET_MASK: &str = "__stored__";
const SECRET_KEYS: [&str; 2] = ["lineChannelAccessToken", "claudeManualToken"];

// Mirrors ALERT_SERVICE in src/shared/notify-channels.ts. The two 5-hour reset
// alarms start with LINE unticked (they ring several times a day).
const ALERT_KEYS: [&str; 13] = [
    "cursor-advanced-models-low",
    "cursor-models-low",
    "cursor-billing",
    "claude-session-low",
    "claude-weekly-low",
    "claude-session",
    "claude-weekly",
    "claude-billing",
    "codex-session-low",
    "codex-weekly-low",
    "codex-session",
    "codex-weekly",
    "codex-billing",
];
const LINE_OFF_BY_DEFAULT: [&str; 2] = ["claude-session", "codex-session"];

// Mirrors DEFAULT_SETTINGS in src/main/config.ts.
fn default_settings() -> Map<String, Value> {
    let mut channels = Map::new();
    for key in ALERT_KEYS {
        channels.insert(
            key.to_string(),
            json!({ "popup": true, "line": !LINE_OFF_BY_DEFAULT.contains(&key) }),
        );
    }
    let Value::Object(settings) = json!({
        "enableCursorMonitoring": true,
        "enableClaudeMonitoring": true,
        "enableCodexMonitoring": true,
        "cursorAdvancedModelsLowThresholdPercent": 20,
        "cursorModelsLowThresholdPercent": 20,
        "claudeSessionLowThresholdPercent": 20,
        "claudeWeeklyLowThresholdPercent": 20,
        "codexSessionLowThresholdPercent": 20,
        "codexWeeklyLowThresholdPercent": 20,
        "launchWithIde": false,
        "notifyCooldownMinutes": 15,
        "language": "zh",
        "showWeeklyInTray": true,
        "alertChannels": channels,
        "lineChannelAccessToken": "",
        "claudeManualToken": "",
        "autoCheckForUpdates": true
    }) else {
        unreachable!("json! of an object literal is an object")
    };
    settings
}

// Settings live in memory and are written to `settings.json` in the app data
// directory on every save. The two secret fields are NOT written there: they go
// to the OS credential store (see secrets.rs).
pub struct SettingsState {
    values: Mutex<Map<String, Value>>,
    path: Option<PathBuf>,
    use_secret_store: bool,
}

// Where the Electron build keeps its settings (electron-store, name "usage-pulse").
// Read once, on the first launch of the Tauri build; its secrets are encrypted
// with Electron's safeStorage and cannot be read here, so they are not imported.
fn electron_settings_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let base = crate::credentials::home_dir()?.join("Library/Application Support");
    #[cfg(target_os = "windows")]
    let base = PathBuf::from(std::env::var_os("APPDATA")?);
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = crate::credentials::home_dir()?.join(".config");
    Some(base.join("usage-pulse").join("usage-pulse.json"))
}

fn read_object(path: &PathBuf) -> Option<Map<String, Value>> {
    match serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

impl SettingsState {
    /// Defaults overlaid with the stored file (or, on first launch, the Electron
    /// build's settings); unknown keys are dropped. Secrets come from the OS store.
    pub fn load(path: PathBuf) -> Self {
        let mut state = Self::build(path, true);
        let first_launch = state.path.as_ref().is_some_and(|path| !path.exists());
        if first_launch {
            if let Some(imported) = electron_settings_path().and_then(|path| read_object(&path)).and_then(|root| match root.get("settings") {
                Some(Value::Object(settings)) => Some(settings.clone()),
                _ => None,
            }) {
                state.overlay(imported);
                let snapshot = state.values.lock().expect("settings lock poisoned").clone();
                state.persist(&snapshot);
            }
        }
        state
    }

    fn build(path: PathBuf, use_secret_store: bool) -> Self {
        let mut state = Self { values: Mutex::new(default_settings()), path: Some(path.clone()), use_secret_store };
        if let Some(stored) = read_object(&path) {
            state.overlay(stored);
        }
        if use_secret_store {
            let mut values = state.values.lock().expect("settings lock poisoned");
            for key in SECRET_KEYS {
                values.insert(key.to_string(), Value::String(crate::secrets::get(key).unwrap_or_default()));
            }
        }
        state
    }

    fn overlay(&mut self, stored: Map<String, Value>) {
        let values = self.values.get_mut().expect("settings lock poisoned");
        for (key, value) in stored {
            if values.contains_key(&key) && !SECRET_KEYS.contains(&key.as_str()) {
                values.insert(key, value);
            }
        }
    }

    pub fn secret_store_available(&self) -> bool {
        self.use_secret_store && crate::secrets::available()
    }

    /// Replaces one secret (empty clears it), in memory and in the OS store.
    pub fn set_secret(&self, key: &str, value: &str) {
        self.values.lock().expect("settings lock poisoned").insert(key.to_string(), Value::String(value.to_string()));
        if self.use_secret_store {
            crate::secrets::set(key, value);
        }
    }

    fn persist(&self, values: &Map<String, Value>) {
        let Some(path) = &self.path else { return };
        let mut plain = values.clone();
        for key in SECRET_KEYS {
            plain.remove(key);
        }
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(text) = serde_json::to_string_pretty(&Value::Object(plain)) {
            // Temp file + rename so a crash mid-write cannot leave half a file.
            let temp = path.with_extension("json.tmp");
            if std::fs::write(&temp, text).is_ok() {
                let _ = std::fs::rename(&temp, path);
            }
        }
    }

    pub fn language(&self) -> String {
        let settings = self.values.lock().expect("settings lock poisoned");
        settings
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or("zh")
            .to_string()
    }

    pub fn value(&self, key: &str) -> Value {
        self.values.lock().expect("settings lock poisoned").get(key).cloned().unwrap_or(Value::Null)
    }

    /// One reminder's channel switch (`popup` or `line`), mirrors isAlertPopup / isAlertLine.
    pub fn alert_channel(&self, alert: &str, channel: &str) -> bool {
        self.value("alertChannels")[alert][channel].as_bool().unwrap_or(false)
    }

    pub fn string(&self, key: &str) -> String {
        let settings = self.values.lock().expect("settings lock poisoned");
        settings.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
    }

    pub fn flag(&self, key: &str) -> bool {
        let settings = self.values.lock().expect("settings lock poisoned");
        settings.get(key).and_then(Value::as_bool).unwrap_or(false)
    }

    pub fn number(&self, key: &str, fallback: f64) -> f64 {
        let settings = self.values.lock().expect("settings lock poisoned");
        settings.get(key).and_then(Value::as_f64).unwrap_or(fallback)
    }

    // Settings as the renderer may see them: a stored secret becomes the mask.
    pub fn masked(&self) -> Value {
        let settings = self.values.lock().expect("settings lock poisoned");
        let mut view = settings.clone();
        for key in SECRET_KEYS {
            let stored = view.get(key).and_then(Value::as_str).is_some_and(|v| !v.is_empty());
            if stored {
                view.insert(key.to_string(), Value::String(SECRET_MASK.to_string()));
            }
        }
        Value::Object(view)
    }

    // Shallow merge of a patch. A masked secret in the patch is the renderer
    // echoing back what it was shown, so it is ignored rather than stored.
    pub fn save(&self, patch: &Value) -> Value {
        if let Value::Object(patch) = patch {
            let mut settings = self.values.lock().expect("settings lock poisoned");
            for (key, value) in patch {
                if SECRET_KEYS.contains(&key.as_str()) {
                    if value.as_str() == Some(SECRET_MASK) {
                        continue;
                    }
                    if self.use_secret_store {
                        crate::secrets::set(key, value.as_str().unwrap_or_default());
                    }
                }
                if settings.contains_key(key) {
                    settings.insert(key.clone(), value.clone());
                }
            }
            self.persist(&settings);
        }
        self.masked()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_plain_settings_and_never_the_secrets() {
        let path = std::env::temp_dir().join(format!("usage-pulse-settings-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let state = SettingsState::build(path.clone(), false);
        state.save(&json!({ "language": "en", "claudeManualToken": "sk-ant-oat01-secret", "bogus": 1 }));

        let text = std::fs::read_to_string(&path).expect("settings file written");
        assert!(!text.contains("sk-ant-oat01-secret"));
        assert!(!text.contains("bogus"));

        let reloaded = SettingsState::build(path.clone(), false);
        assert_eq!(reloaded.language(), "en");
        assert_eq!(reloaded.string("claudeManualToken"), "");
        let _ = std::fs::remove_file(&path);
    }
}
