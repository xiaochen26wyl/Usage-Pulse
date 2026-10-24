// The two secret settings (LINE token, Claude manual token) live in the OS
// credential store (macOS Keychain, Windows Credential Manager, Secret Service),
// under Usage-Pulse's own service name. They are never written to settings.json.
use keyring::Entry;

const SERVICE: &str = "com.xiaochen26wyl.usagepulse";

pub fn available() -> bool {
    Entry::store_status().is_ok()
}

pub fn get(key: &str) -> Option<String> {
    Entry::new(SERVICE, key).ok()?.get_password().ok()
}

/// Stores `value`; an empty value removes the entry.
pub fn set(key: &str, value: &str) {
    let Ok(entry) = Entry::new(SERVICE, key) else { return };
    if value.is_empty() {
        let _ = entry.delete_credential();
    } else {
        let _ = entry.set_password(value);
    }
}
