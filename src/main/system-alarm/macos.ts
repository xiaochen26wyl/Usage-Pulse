import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AlarmTarget, SystemAlarmKind, SystemAlarmStatus } from "@shared/types";
import { type SystemAlarmAdapter, statusOf } from "./types";

const execFileAsync = promisify(execFile);

const LAUNCH_AGENT_LABEL = "com.xiaochen26wyl.usagepulse.alarm";
const LAUNCH_AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(LAUNCH_AGENTS_DIR, `${LAUNCH_AGENT_LABEL}.plist`);
const FIRE_AT_ENV = "USAGE_PULSE_ALARM_FIRE_AT";

export const SHORTCUT_SET = "Usage-Pulse Set Alarm";
export const SHORTCUT_CLEAR = "Usage-Pulse Clear Alarm";
export const SHORTCUT_CHECK = "Usage-Pulse Check Alarm";
const REQUIRED_SHORTCUTS = [SHORTCUT_SET, SHORTCUT_CLEAR, SHORTCUT_CHECK];

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const withTempFile = async <T>(name: string, run: (path: string) => Promise<T>): Promise<T> => {
  const path = join(tmpdir(), `usage-pulse-${process.pid}-${name}`);
  try {
    return await run(path);
  } finally {
    await rm(path, { force: true }).catch(() => undefined);
  }
};

const buildPlist = (target: AlarmTarget): string => {
  const fireDate = new Date(target.fireAt);
  const args = [process.execPath, `--alarm-fired=${target.id}`];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>${FIRE_AT_ENV}</key>
    <string>${escapeXml(target.fireAt)}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Month</key><integer>${fireDate.getMonth() + 1}</integer>
    <key>Day</key><integer>${fireDate.getDate()}</integer>
    <key>Hour</key><integer>${fireDate.getHours()}</integer>
    <key>Minute</key><integer>${fireDate.getMinutes()}</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
};

const listShortcuts = async (): Promise<string[]> => {
  const { stdout } = await execFileAsync("/usr/bin/shortcuts", ["list"]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
};

const missingShortcuts = async (): Promise<string[]> => {
  const installed = new Set(await listShortcuts());
  return REQUIRED_SHORTCUTS.filter((name) => !installed.has(name));
};

const probeWakeApp = async (): Promise<SystemAlarmStatus> => {
  let plist: string;
  try {
    plist = await readFile(PLIST_PATH, "utf-8");
  } catch {
    return statusOf("wake-app", "stale", null, "LaunchAgent plist not found");
  }

  const fireAt = new RegExp(`<key>${FIRE_AT_ENV}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1] ?? null;

  try {
    // Asks launchd what it actually holds. A plist sitting on disk that was
    // never bootstrapped (or was booted out on reboot) is not a running clock.
    await execFileAsync("/bin/launchctl", ["print", `gui/${process.getuid?.() ?? 501}/${LAUNCH_AGENT_LABEL}`]);
  } catch {
    return statusOf("wake-app", "stale", fireAt, "LaunchAgent is not loaded in launchd");
  }

  return statusOf("wake-app", "armed", fireAt);
};

const probeNative = async (): Promise<SystemAlarmStatus> => {
  let missing: string[];
  try {
    missing = await missingShortcuts();
  } catch (error) {
    return statusOf("native", "error", null, errorMessage(error));
  }

  if (missing.length > 0) {
    return statusOf("native", "not-installed", null, missing.join(", "));
  }

  try {
    const output = await withTempFile("check-alarm.txt", async (path) => {
      await execFileAsync("/usr/bin/shortcuts", ["run", SHORTCUT_CHECK, "--output-path", path]);
      return readFile(path, "utf-8").catch(() => "");
    });

    const text = output.trim();
    if (!text || /^(no|none|false|0)$/i.test(text)) {
      return statusOf("native", "stale", null, "Clock app holds no Usage-Pulse alarm");
    }
    return statusOf("native", "armed", text);
  } catch (error) {
    return statusOf("native", "error", null, errorMessage(error));
  }
};

export const macosAdapter: SystemAlarmAdapter = {
  isSupported: () => true,

  async probe(kind: SystemAlarmKind): Promise<SystemAlarmStatus> {
    return kind === "wake-app" ? probeWakeApp() : probeNative();
  },

  async arm(kind: SystemAlarmKind, target: AlarmTarget): Promise<void> {
    if (kind === "wake-app") {
      await mkdir(LAUNCH_AGENTS_DIR, { recursive: true });
      await writeFile(PLIST_PATH, buildPlist(target), "utf-8");
      const domain = `gui/${process.getuid?.() ?? 501}`;
      await execFileAsync("/bin/launchctl", ["bootout", `${domain}/${LAUNCH_AGENT_LABEL}`]).catch(() => undefined);
      await execFileAsync("/bin/launchctl", ["bootstrap", domain, PLIST_PATH]);
      return;
    }

    const missing = await missingShortcuts();
    if (missing.length > 0) {
      throw new Error(`Missing shortcuts: ${missing.join(", ")}`);
    }
    await withTempFile("set-alarm.txt", async (path) => {
      // A temp file rather than stdin: `--input-path -` is undocumented and
      // unverified, while a real path is unambiguous.
      await writeFile(path, target.fireAt, "utf-8");
      await execFileAsync("/usr/bin/shortcuts", ["run", SHORTCUT_SET, "--input-path", path]);
    });
  },

  async clear(kind: SystemAlarmKind): Promise<void> {
    if (kind === "wake-app") {
      const domain = `gui/${process.getuid?.() ?? 501}`;
      await execFileAsync("/bin/launchctl", ["bootout", `${domain}/${LAUNCH_AGENT_LABEL}`]).catch(() => undefined);
      await rm(PLIST_PATH, { force: true });
      return;
    }

    const missing = await missingShortcuts();
    if (missing.length > 0) {
      return;
    }
    await execFileAsync("/usr/bin/shortcuts", ["run", SHORTCUT_CLEAR]);
  }
};
