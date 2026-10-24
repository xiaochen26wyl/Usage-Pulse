// "Launch with the IDE": the menu-bar app is never a login item itself. A tiny
// helper starts at login and opens this binary only once Cursor or Claude Code
// is running. A port of src/main/ide-launch-helper.ts; the files it writes are
// Usage-Pulse's own (a script, a LaunchAgent / Run key), never an IDE's.
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use tauri::{AppHandle, Manager};

const WATCHER_LABEL: &str = "com.xiaochen26wyl.usagepulse.ide-watcher";
#[cfg(windows)]
const WINDOWS_WATCHER_NAME: &str = "Usage-Pulse IDE Watcher";

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn xml_escape(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

#[cfg_attr(not(windows), allow(dead_code))]
fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn mac_watcher_script(exe: &Path) -> String {
    let process_name = exe.file_name().and_then(|name| name.to_str()).unwrap_or("Usage-Pulse");
    format!(
        r#"#!/bin/bash
EXE={exe}
if pgrep -x {name} >/dev/null 2>&1; then
  exit 0
fi

ide_running=0
if pgrep -x 'Cursor' >/dev/null 2>&1; then
  ide_running=1
elif pgrep -x 'claude' >/dev/null 2>&1; then
  ide_running=1
elif ps -ax -o command= | grep -E 'claude-code|@anthropic-ai/claude-code' | grep -v 'ide-watcher' | grep -v grep >/dev/null 2>&1; then
  ide_running=1
fi

if [ "$ide_running" -eq 0 ]; then
  exit 0
fi

if [[ "$EXE" == *'.app/Contents/MacOS/'* ]]; then
  APP="${{EXE%%.app/*}}.app"
  open "$APP"
else
  nohup "$EXE" >/dev/null 2>&1 &
fi
"#,
        exe = sh_quote(&exe.to_string_lossy()),
        name = sh_quote(process_name),
    )
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn mac_launch_agent_plist(script: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>{script}</string>
  </array>
  <key>StartInterval</key>
  <integer>1800</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
"#,
        label = xml_escape(WATCHER_LABEL),
        script = xml_escape(&script.to_string_lossy()),
    )
}

#[cfg_attr(not(windows), allow(dead_code))]
fn windows_watcher_script(exe: &Path) -> String {
    let process_name = exe.file_stem().and_then(|name| name.to_str()).unwrap_or("Usage-Pulse");
    format!(
        r#"$ErrorActionPreference = 'SilentlyContinue'
$exe = {exe}
while ($true) {{
  $running = Get-Process -Name {name} -ErrorAction SilentlyContinue
  if (-not $running) {{
    $cursor = Get-Process -Name 'Cursor' -ErrorAction SilentlyContinue
    $claude = Get-Process -Name 'claude' -ErrorAction SilentlyContinue | Where-Object {{ $_.ProcessName -ceq 'claude' }}
    $cli = $false
    try {{
      $cli = @(Get-CimInstance Win32_Process | Where-Object {{
        $_.CommandLine -and
        ($_.CommandLine -match 'claude-code|@anthropic-ai/claude-code') -and
        ($_.CommandLine -notmatch 'ide-watcher')
      }}).Count -gt 0
    }} catch {{}}
    if ($cursor -or $claude -or $cli) {{
      Start-Process -FilePath $exe
    }}
  }}
  Start-Sleep -Seconds 1800
}}
"#,
        exe = ps_quote(&exe.to_string_lossy()),
        name = ps_quote(process_name),
    )
}

#[cfg_attr(not(windows), allow(dead_code))]
fn windows_vbs(ps1: &Path) -> String {
    let escaped = ps1.to_string_lossy().replace('"', "\"\"");
    format!(
        "Set sh = CreateObject(\"WScript.Shell\")\r\nsh.Run \"powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"\"{escaped}\"\"\", 0, False\r\n"
    )
}

fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

#[cfg(target_os = "macos")]
fn plist_path() -> Option<PathBuf> {
    Some(crate::credentials::home_dir()?.join("Library/LaunchAgents").join(format!("{WATCHER_LABEL}.plist")))
}

#[cfg(target_os = "macos")]
fn launchctl(args: &[&str]) -> bool {
    Command::new("launchctl").args(args).output().is_ok_and(|output| output.status.success())
}

#[cfg(target_os = "macos")]
fn launchd_domain() -> String {
    // SAFETY: getuid has no preconditions.
    format!("gui/{}", unsafe { libc::getuid() })
}

#[cfg(target_os = "macos")]
fn unload_agent(plist: &Path) {
    if !launchctl(&["bootout", &format!("{}/{WATCHER_LABEL}", launchd_domain())]) {
        launchctl(&["unload", &plist.to_string_lossy()]);
    }
}

#[cfg(target_os = "macos")]
fn load_agent(plist: &Path) {
    if !launchctl(&["bootstrap", &launchd_domain(), &plist.to_string_lossy()]) {
        launchctl(&["load", &plist.to_string_lossy()]);
    }
}

#[cfg(target_os = "macos")]
fn install(app: &AppHandle, exe: &Path) -> Option<()> {
    use std::os::unix::fs::PermissionsExt;
    let script = data_dir(app)?.join("ide-watcher.sh");
    let plist = plist_path()?;
    fs::create_dir_all(plist.parent()?).ok()?;
    fs::write(&script, mac_watcher_script(exe)).ok()?;
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).ok()?;
    unload_agent(&plist);
    fs::write(&plist, mac_launch_agent_plist(&script)).ok()?;
    load_agent(&plist);
    Some(())
}

#[cfg(target_os = "macos")]
fn uninstall(app: &AppHandle) {
    if let Some(plist) = plist_path() {
        unload_agent(&plist);
        let _ = fs::remove_file(plist);
    }
    if let Some(dir) = data_dir(app) {
        let _ = fs::remove_file(dir.join("ide-watcher.sh"));
    }
}

#[cfg(windows)]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

#[cfg(windows)]
fn reg(args: &[&str]) -> bool {
    use std::os::windows::process::CommandExt;
    Command::new("reg")
        .args(args)
        .creation_flags(0x0800_0000)
        .output()
        .is_ok_and(|output| output.status.success())
}

#[cfg(windows)]
fn install(app: &AppHandle, exe: &Path) -> Option<()> {
    let dir = data_dir(app)?;
    let (ps1, vbs) = (dir.join("ide-watcher.ps1"), dir.join("ide-watcher.vbs"));
    fs::write(&ps1, windows_watcher_script(exe)).ok()?;
    fs::write(&vbs, windows_vbs(&ps1)).ok()?;
    let wscript = std::path::Path::new(&std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string()))
        .join("System32")
        .join("wscript.exe");
    let command = format!("\"{}\" //B //Nologo \"{}\"", wscript.display(), vbs.display());
    reg(&["add", RUN_KEY, "/v", WINDOWS_WATCHER_NAME, "/t", "REG_SZ", "/d", &command, "/f"]).then_some(())
}

#[cfg(windows)]
fn uninstall(app: &AppHandle) {
    reg(&["delete", RUN_KEY, "/v", WINDOWS_WATCHER_NAME, "/f"]);
    if let Some(dir) = data_dir(app) {
        let _ = fs::remove_file(dir.join("ide-watcher.ps1"));
        let _ = fs::remove_file(dir.join("ide-watcher.vbs"));
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn install(_app: &AppHandle, _exe: &Path) -> Option<()> {
    Some(())
}

#[cfg(not(any(target_os = "macos", windows)))]
fn uninstall(_app: &AppHandle) {}

// Re-applied on every launch and every settings save, so an app update rewrites
// the executable path. Development builds are never installed as a helper.
pub fn apply(app: &AppHandle, enabled: bool) {
    if !enabled {
        uninstall(app);
        return;
    }
    if cfg!(debug_assertions) {
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    if install(app, &exe).is_none() {
        eprintln!("[Usage-Pulse] failed to install the IDE launch helper");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_awkward_paths() {
        assert_eq!(sh_quote("/a b/it's"), r#"'/a b/it'\''s'"#);
        assert_eq!(ps_quote("C:\\it's"), "'C:\\it''s'");
        assert_eq!(xml_escape("a&b<c>\"d"), "a&amp;b&lt;c&gt;&quot;d");
    }

    #[test]
    fn mac_script_opens_the_app_bundle() {
        let script = mac_watcher_script(Path::new("/Applications/Usage-Pulse.app/Contents/MacOS/Usage-Pulse"));
        assert!(script.contains("pgrep -x 'Usage-Pulse'"));
        assert!(script.contains(r#"APP="${EXE%%.app/*}.app""#));
    }
}
