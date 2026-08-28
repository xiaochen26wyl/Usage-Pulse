import { execFile } from "node:child_process";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { app } from "electron";

const execFileAsync = promisify(execFile);

export const IDE_WATCHER_LABEL = "com.xiaochen26wyl.usagepulse.ide-watcher";
const WINDOWS_WATCHER_NAME = "Usage-Pulse IDE Watcher";

const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const xmlEscape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const scriptPath = (): string =>
  join(app.getPath("userData"), process.platform === "win32" ? "ide-watcher.ps1" : "ide-watcher.sh");

const vbsPath = (): string => join(app.getPath("userData"), "ide-watcher.vbs");

const plistPath = (): string => join(homedir(), "Library", "LaunchAgents", `${IDE_WATCHER_LABEL}.plist`);

const windowsWscriptPath = (): string => join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");

const buildMacWatcherScript = (exePath: string): string => `#!/bin/bash
EXE=${shQuote(exePath)}
if pgrep -x 'Usage-Pulse' >/dev/null 2>&1; then
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
  APP="\${EXE%%.app/*}.app"
  open "$APP"
else
  nohup "$EXE" >/dev/null 2>&1 &
fi
`;

const buildMacLaunchAgentPlist = (watcherScriptPath: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(IDE_WATCHER_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${xmlEscape(watcherScriptPath)}</string>
  </array>
  <key>StartInterval</key>
  <integer>1800</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;

const buildWindowsWatcherScript = (exePath: string): string => `$ErrorActionPreference = 'SilentlyContinue'
$exe = ${psQuote(exePath)}
while ($true) {
  $running = Get-Process -Name 'Usage-Pulse' -ErrorAction SilentlyContinue
  if (-not $running) {
    $cursor = Get-Process -Name 'Cursor' -ErrorAction SilentlyContinue
    $claude = Get-Process -Name 'claude' -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -ceq 'claude' }
    $cli = $false
    try {
      $cli = @(Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -and
        ($_.CommandLine -match 'claude-code|@anthropic-ai/claude-code') -and
        ($_.CommandLine -notmatch 'ide-watcher')
      }).Count -gt 0
    } catch {}
    if ($cursor -or $claude -or $cli) {
      Start-Process -FilePath $exe
    }
  }
  Start-Sleep -Seconds 1800
}
`;

const buildWindowsVbs = (ps1Path: string): string => {
  const escaped = ps1Path.replace(/"/g, '""');
  return `Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""${escaped}""", 0, False
`;
};

const runLaunchctl = async (args: string[]): Promise<boolean> => {
  try {
    await execFileAsync("launchctl", args, { timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
};

const launchdDomain = (): string => `gui/${process.getuid?.() ?? 501}`;

const unloadMacAgent = async (agentPlistPath: string): Promise<void> => {
  const unloaded = await runLaunchctl(["bootout", `${launchdDomain()}/${IDE_WATCHER_LABEL}`]);
  if (!unloaded) {
    await runLaunchctl(["unload", agentPlistPath]);
  }
};

const loadMacAgent = async (agentPlistPath: string): Promise<void> => {
  const loaded = await runLaunchctl(["bootstrap", launchdDomain(), agentPlistPath]);
  if (!loaded) {
    await runLaunchctl(["load", agentPlistPath]);
  }
};

const removeFile = async (path: string): Promise<void> => {
  try {
    await unlink(path);
  } catch {
    // already gone
  }
};

const clearAppLoginItem = (): void => {
  app.setLoginItemSettings({ openAtLogin: false });
};

const clearWindowsHelperLoginItem = (): void => {
  app.setLoginItemSettings({
    openAtLogin: false,
    path: windowsWscriptPath(),
    args: ["//B", "//Nologo", vbsPath()],
    name: WINDOWS_WATCHER_NAME
  });
};

const uninstallHelper = async (): Promise<void> => {
  if (process.platform === "darwin") {
    const agentPlistPath = plistPath();
    await unloadMacAgent(agentPlistPath);
    await removeFile(agentPlistPath);
    await removeFile(scriptPath());
    return;
  }

  if (process.platform === "win32") {
    clearWindowsHelperLoginItem();
    await removeFile(scriptPath());
    await removeFile(vbsPath());
  }
};

const installMacHelper = async (exePath: string): Promise<void> => {
  const watcherScriptPath = scriptPath();
  const agentPlistPath = plistPath();
  await mkdir(app.getPath("userData"), { recursive: true });
  await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  await writeFile(watcherScriptPath, buildMacWatcherScript(exePath), "utf8");
  await chmod(watcherScriptPath, 0o755);
  await unloadMacAgent(agentPlistPath);
  await writeFile(agentPlistPath, buildMacLaunchAgentPlist(watcherScriptPath), "utf8");
  await loadMacAgent(agentPlistPath);
};

const installWindowsHelper = async (exePath: string): Promise<void> => {
  const ps1 = scriptPath();
  const vbs = vbsPath();
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(ps1, buildWindowsWatcherScript(exePath), "utf8");
  await writeFile(vbs, buildWindowsVbs(ps1), "utf8");
  app.setLoginItemSettings({
    openAtLogin: true,
    path: windowsWscriptPath(),
    args: ["//B", "//Nologo", vbs],
    name: WINDOWS_WATCHER_NAME
  });
};

// The menu-bar app itself is never a login item. When enabled and packaged,
// a tiny helper starts at login and opens this binary only after Cursor or
// Claude Code is running. Re-applying on every launch rewrites the exe path
// after an app update.
export const applyIdeLaunchHelper = async (enabled: boolean): Promise<void> => {
  clearAppLoginItem();

  if (!enabled) {
    await uninstallHelper();
    return;
  }

  if (!app.isPackaged) {
    return;
  }

  const exePath = app.getPath("exe");
  if (process.platform === "darwin") {
    await installMacHelper(exePath);
    return;
  }
  if (process.platform === "win32") {
    await installWindowsHelper(exePath);
  }
};
